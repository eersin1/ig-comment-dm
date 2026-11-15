// Builds library/: one folder per reel of yours, plus library/reels.csv with one row per reel.
//
//   deno run -A scripts/library.ts            all reels (new ones processed, every folder's numbers refreshed)
//   deno run -A scripts/library.ts --limit 5  only the 5 newest
//
// Per folder:
//   video.mp4         the posted reel
//   transcript.txt/.vtt, cuts.txt, hook/h*.jpg (first 3s at 3fps), sheet-NN.jpg (3x3, 9s each)
//   reel.json         caption, post time, CTA keyword + DM text + DMs sent, pacing stats, current counts
//   metrics.json      every snapshot from Supabase (views, reach, skip rate, watch time... over time)
//
// Needs IG_TOKEN, SUPABASE_PROJECT_REF and SUPABASE_SECRET_KEY in .env, and ffmpeg + whisper-cli.
import { exists, processVideo, stats } from "./reel-media.ts";
const ROOT = new URL("../", import.meta.url).pathname;
const LIB = `${ROOT}library`;

const env = Object.fromEntries(
  Deno.readTextFileSync(`${ROOT}.env`).split("\n").flatMap((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }),
);
const SUPABASE_URL = `https://${env.SUPABASE_PROJECT_REF}.supabase.co`;
// Post dates and hours are shown in TIMEZONE from .env (like America/New_York), else this computer's zone.
const TZ = env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const limitArg = Deno.args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(Deno.args[limitArg + 1]) : Infinity;
const GRAPH = `https://graph.facebook.com/${env.API_VERSION || "v26.0"}`;

async function graph(path: string) {
  const r = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${env.IG_TOKEN}` } });
  const body = await r.json();
  if (body.error) throw new Error(`Instagram: ${body.error.message}`);
  return body;
}

async function db(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
  });
  if (!r.ok) {
    // The insights tables only exist once the migration is applied. Everything else still works.
    if (r.status === 404 || r.status === 400) return [];
    throw new Error(`Supabase ${path.split("?")[0]}: HTTP ${r.status}`);
  }
  return r.json();
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-") || "reel";
const local = (iso: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      weekday: "short", hourCycle: "h23",
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, hour: Number(parts.hour) };
};

// The first snapshot taken at or after `hours` (within 50% slack), so reels compare at the same age.
function at(series: Snapshot[], hours: number) {
  return series.find((s) => s.age_hours >= hours && s.age_hours <= hours * 1.5) ?? null;
}
type Snapshot = {
  taken_at: string; age_hours: number; views: number | null; likes: number | null; comments: number | null;
  insights: Record<string, number>; insights_error: string | null;
};

const rate = (n: number | null | undefined, d: number | null | undefined) =>
  n == null || !d ? null : Math.round((n / d) * 10000) / 100;

// ---- main ------------------------------------------------------------------------------------
await Deno.mkdir(LIB, { recursive: true });
const igId = (await graph("/me/assigned_instagram_accounts?fields=id")).data[0].id;
const media: Record<string, any>[] = [];
let next: string | null = `/${igId}/media?fields=id,caption,permalink,timestamp,media_product_type,media_url,total_views_count,like_count,comments_count&limit=50`;
while (next && media.length < LIMIT) {
  const body = await graph(next);
  media.push(...body.data.filter((m: any) => m.media_product_type === "REELS"));
  next = body.paging?.next ? next.replace(/&after=[^&]*/, "") + `&after=${body.paging.cursors.after}` : null;
}
const reels = media.slice(0, LIMIT).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const rules: any[] = await db("rules?select=id,media_id,keyword,dm_text,public_reply,enabled");
const events: any[] = await db("events?select=rule_id,status&limit=100000");
const dmsByRule = new Map<number, number>();
for (const e of events) if (e.status === "sent") dmsByRule.set(e.rule_id, (dmsByRule.get(e.rule_id) ?? 0) + 1);

const existing = new Map<string, string>();
for await (const entry of Deno.readDir(LIB)) {
  const id = entry.name.match(/-(\d{10,})$/)?.[1];
  if (entry.isDirectory && id) existing.set(id, entry.name);
}

const rows: Record<string, unknown>[] = [];
let prevPost: string | null = null;
for (const [i, m] of reels.entries()) {
  const when = local(m.timestamp);
  const name = existing.get(m.id) ?? `${when.date}-${slug((m.caption ?? "").split("\n")[0])}-${m.id}`;
  const dir = `${LIB}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  console.log(`[${i + 1}/${reels.length}] ${name}`);

  if (!await exists(`${dir}/video.mp4`)) {
    if (!m.media_url) { console.log("    no media_url, skipped"); continue; }
    const r = await fetch(m.media_url);
    if (!r.ok) { console.log(`    download failed (HTTP ${r.status})`); continue; }
    await Deno.writeFile(`${dir}/video.mp4`, new Uint8Array(await r.arrayBuffer()));
  }
  await processVideo(dir);
  const s = await stats(dir);

  const rule = rules.filter((r) => r.media_id === m.id).sort((a, b) => b.id - a.id)[0];
  const caption: string = m.caption ?? "";
  const reel = {
    media_id: m.id,
    permalink: m.permalink,
    posted_at: m.timestamp,
    posted_local: `${when.date} ${when.time} (${when.weekday})`,
    caption,
    keyword: rule?.keyword ?? null,
    dm_text: rule?.dm_text ?? null,
    dms_sent: rule ? dmsByRule.get(rule.id) ?? 0 : null,
    now: { views: m.total_views_count ?? null, likes: m.like_count ?? null, comments: m.comments_count ?? null, at: new Date().toISOString() },
    ...s,
  };
  await Deno.writeTextFile(`${dir}/reel.json`, JSON.stringify(reel, null, 2));

  const series: Snapshot[] = await db(
    `snapshots?select=taken_at,age_hours,views,likes,comments,insights,insights_error&media_id=eq.${m.id}&order=taken_at.asc`,
  );
  series.forEach((x) => (x.age_hours = Number(x.age_hours)));
  await Deno.writeTextFile(`${dir}/metrics.json`, JSON.stringify(series, null, 2));

  const row: Record<string, unknown> = {
    folder: name,
    posted_at: m.timestamp,
    posted: reel.posted_local,
    weekday: when.weekday,
    hour: when.hour,
    hours_since_prev_post: prevPost ? Math.round((Date.parse(m.timestamp) - Date.parse(prevPost)) / 360000) / 10 : null,
    caption_first_line: caption.split("\n")[0].slice(0, 120),
    caption_chars: caption.length,
    hashtags: (caption.match(/#\w+/g) ?? []).length,
    keyword: reel.keyword ?? (s.cta_keyword_spoken && caption.includes(s.cta_keyword_spoken) ? s.cta_keyword_spoken : null),
    keyword_rule: reel.keyword != null,
    dms_sent: reel.dms_sent,
    duration_s: s.duration_s,
    visual_changes_per_10s: s.cuts_per_10s,
    first_visual_change_s: s.first_cut_s,
    wpm: s.wpm,
    first_word_s: s.first_word_s,
    hook_words: s.hook_words,
    hook_spoken: s.hook_spoken,
    cta_comment_at_pct: s.cta_comment_at_s != null && s.duration_s ? Math.round((s.cta_comment_at_s / s.duration_s) * 100) : null,
    cta_follow_at_pct: s.cta_follow_at_s != null && s.duration_s ? Math.round((s.cta_follow_at_s / s.duration_s) * 100) : null,
    views_now: reel.now.views,
    likes_now: reel.now.likes,
    comments_now: reel.now.comments,
    dm_rate_pct: rate(reel.dms_sent, reel.now.views),
    comment_rate_pct: rate(reel.now.comments, reel.now.views),
  };
  // Fixed ages compare reels fairly. "latest" covers reels older than the collector.
  const ages: [string, Snapshot | null][] = [["24h", at(series, 24)], ["72h", at(series, 72)], ["168h", at(series, 168)], ["latest", series.at(-1) ?? null]];
  row.latest_age_h = series.at(-1)?.age_hours ?? null;
  for (const [h, snap] of ages) {
    const ins = snap?.insights ?? {};
    const reach = ins.reach ?? null;
    const views = ins.views ?? snap?.views ?? null;
    const avgWatch = ins.ig_reels_avg_watch_time != null ? ins.ig_reels_avg_watch_time / 1000 : null;
    Object.assign(row, {
      [`views_${h}`]: views,
      [`reach_${h}`]: reach,
      [`skip_rate_${h}`]: ins.reels_skip_rate ?? null,
      [`avg_watch_s_${h}`]: avgWatch != null ? Math.round(avgWatch * 10) / 10 : null,
      [`watch_pct_${h}`]: avgWatch != null && s.duration_s ? Math.round((avgWatch / s.duration_s) * 100) : null,
      [`share_rate_${h}`]: rate(ins.shares, reach ?? views),
      [`save_rate_${h}`]: rate(ins.saved, reach ?? views),
      [`like_rate_${h}`]: rate(ins.likes ?? snap?.likes, reach ?? views),
      [`comment_rate_${h}`]: rate(ins.comments ?? snap?.comments, reach ?? views),
    });
  }
  rows.push(row);
  prevPost = m.timestamp;
}

// Posted within 3 hours with the same keyword or caption opening = variants of one video (A/B hooks).
const groups: { opening: string; keyword: unknown; t: number; name: string }[] = [];
for (const r of rows) {
  const opening = String(r.caption_first_line).slice(0, 30).toLowerCase();
  const t = Date.parse(String(r.posted_at));
  let group = groups.find((g) =>
    Math.abs(g.t - t) < 3 * 3_600_000 && (g.opening === opening || (r.keyword != null && g.keyword === r.keyword))
  );
  if (!group) groups.push(group = { opening, keyword: r.keyword, t, name: String(r.folder) });
  r.variant_group = group.name;
}

const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
const cell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
await Deno.writeTextFile(`${LIB}/reels.csv`, [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
console.log(`\nlibrary/reels.csv: ${rows.length} reels, ${cols.length} columns`);
