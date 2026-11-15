// Every 6 hours: read each watched creator's latest reels through Business Discovery and store
// their views, likes and comments. The page's Trends tab ranks them with findTrends().
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Discovery, describeError, discoveryPath, toRows } from "./logic.ts";
import { secretsMatch } from "../snapshot-insights/logic.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

Deno.serve(async (request) => {
  if (!await secretsMatch(request.headers.get("x-cron-secret"), Deno.env.get("CRON_SECRET"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const base = `https://graph.facebook.com/${Deno.env.get("API_VERSION") ?? "v26.0"}`;
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: accounts, error } = await db.from("watch_accounts").select("username").eq("enabled", true).order("username");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const summary = { accounts: accounts.length, scanned: 0, reels: 0, skipped: [] as string[], stopped: null as string | null };
  for (const { username } of accounts) {
    const response = await fetch(base + discoveryPath(env("IG_USER_ID"), username), {
      headers: { Authorization: `Bearer ${env("IG_TOKEN")}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    const body = await response?.json().catch(() => ({})) ?? {};
    const now = new Date();
    if (!response?.ok || body.error) {
      const { stop, reason } = describeError(body.error?.code, body.error?.error_subcode, body.error?.message ?? "No response");
      await db.from("watch_accounts").update({ last_scanned_at: now.toISOString(), last_error: reason }).eq("username", username);
      if (stop) { summary.stopped = reason; break; }
      summary.skipped.push(username);
      continue;
    }
    const found: Discovery = body.business_discovery ?? {};
    const rows = toRows(username, found, now);
    if (rows.length) {
      const { error: upsertError } = await db.from("watch_reels").upsert(rows, { onConflict: "media_id" });
      if (upsertError) throw new Error(upsertError.message);
    }
    await db.from("watch_accounts").update({
      display_name: found.name ?? null,
      followers: found.followers_count ?? null,
      media_count: found.media_count ?? null,
      last_scanned_at: now.toISOString(),
      last_error: null,
    }).eq("username", username);
    summary.scanned++;
    summary.reels += rows.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return Response.json(summary);
});
