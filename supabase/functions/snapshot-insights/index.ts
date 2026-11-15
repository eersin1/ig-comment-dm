// Hourly: snapshot every reel under 30 days old that is due (see logic.ts), plus the follower count.
// Basic counts need no special permission. Insights need instagram_manage_insights on the token;
// without it the error is stored on the snapshot and the basic counts are still kept.
import { createClient } from "npm:@supabase/supabase-js@2";
import { isDue, MAX_AGE_DAYS, METRICS, parseInsights, secretsMatch } from "./logic.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

type Media = {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp: string;
  media_product_type?: string;
  total_views_count?: number;
  like_count?: number;
  comments_count?: number;
};

class MetaError extends Error {
  constructor(readonly code: number | undefined, message: string) {
    super(message);
  }
}

Deno.serve(async (request) => {
  if (!await secretsMatch(request.headers.get("x-cron-secret"), Deno.env.get("CRON_SECRET"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = Date.now();
  // {"force": true} snapshots every reel under 30 days now, due or not. For backfills.
  const force = Boolean((await request.json().catch(() => ({}))).force);
  const base = `https://graph.facebook.com/${Deno.env.get("API_VERSION") ?? "v26.0"}`;
  const token = env("IG_TOKEN");
  const igUserId = env("IG_USER_ID");
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  async function meta(path: string) {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new MetaError(body.error?.code, `HTTP ${response.status} code=${body.error?.code}: ${body.error?.message ?? ""}`);
    }
    return body;
  }

  function check<T>(result: { data: T; error: { message: string } | null }): T {
    if (result.error) throw new Error(`Database error: ${result.error.message}`);
    return result.data;
  }

  try {
    // Recent media, newest first, until past the 30-day window.
    const cutoff = now - MAX_AGE_DAYS * 86_400_000;
    const fields = "id,caption,permalink,timestamp,media_product_type,total_views_count,like_count,comments_count";
    const media: Media[] = [];
    let path: string | null = `/${igUserId}/media?fields=${fields}&limit=50`;
    for (let page = 0; path && page < 5; page++) {
      const body = await meta(path);
      media.push(...(body.data ?? []));
      const last = body.data?.at(-1);
      if (!last || Date.parse(last.timestamp) < cutoff || !body.paging?.cursors?.after || !body.paging?.next) break;
      path = `/${igUserId}/media?fields=${fields}&limit=50&after=${body.paging.cursors.after}`;
    }
    const reels = media.filter((m) => m.media_product_type === "REELS" && Date.parse(m.timestamp) >= cutoff);

    check(
      await db.from("reels").upsert(
        reels.map((m) => ({
          media_id: m.id,
          caption: m.caption ?? null,
          permalink: m.permalink ?? null,
          posted_at: m.timestamp,
          product_type: m.media_product_type ?? null,
        })),
        { onConflict: "media_id" },
      ),
    );

    const latest = new Map<string, string>(
      (check(await db.from("latest_snapshots").select("media_id,taken_at").in("media_id", reels.map((m) => m.id))) as {
        media_id: string;
        taken_at: string;
      }[]).map((row) => [row.media_id, row.taken_at]),
    );
    const due = reels.filter((m) => force || isDue(m.timestamp, latest.get(m.id) ?? null, now));

    // Learned on the first reel that needs it, then reused: one call per reel instead of fourteen.
    let working: string[] | null = null;
    let noPermission: string | null = null;

    async function probe(mediaId: string) {
      const found: Record<string, number> = {};
      const ok: string[] = [];
      for (const metric of METRICS) {
        try {
          Object.assign(found, parseInsights(await meta(`/${mediaId}/insights?metric=${metric}`)));
          ok.push(metric);
        } catch (error) {
          if ((error as MetaError).code === 10 || (error as MetaError).code === 190) throw error;
        }
      }
      return { found, ok };
    }

    async function insightsFor(mediaId: string): Promise<{ insights: Record<string, number>; error: string | null }> {
      if (noPermission) return { insights: {}, error: noPermission };
      try {
        if (working?.length) {
          try {
            return { insights: parseInsights(await meta(`/${mediaId}/insights?metric=${working.join(",")}`)), error: null };
          } catch (error) {
            if ((error as MetaError).code === 10 || (error as MetaError).code === 190) throw error;
            // A metric this particular reel doesn't support. Probe it on its own.
          }
        }
        const { found, ok } = await probe(mediaId);
        if (!working || ok.length > working.length) working = ok;
        return { insights: found, error: ok.length ? null : "no metric accepted" };
      } catch (error) {
        noPermission = (error as Error).message.slice(0, 300);
        return { insights: {}, error: noPermission };
      }
    }

    const rows = [];
    for (const m of due) {
      const { insights, error } = await insightsFor(m.id);
      rows.push({
        media_id: m.id,
        age_hours: Math.round(((now - Date.parse(m.timestamp)) / 3_600_000) * 100) / 100,
        views: m.total_views_count ?? null,
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
        insights,
        insights_error: error,
      });
    }
    if (rows.length) check(await db.from("snapshots").insert(rows));

    const account = await meta(`/${igUserId}?fields=followers_count,media_count`);
    check(
      await db.from("account_snapshots").insert({
        followers: account.followers_count ?? null,
        media_count: account.media_count ?? null,
      }),
    );

    const summary = { reels: reels.length, snapshotted: rows.length, metrics: working, insights_error: noPermission };
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    console.error(`snapshot-insights failed: ${(error as Error).message}`);
    return Response.json({ error: "run failed" }, { status: 500 });
  }
});
