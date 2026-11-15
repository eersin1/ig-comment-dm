import { createHosting, createMeta, createRules } from "./clients.ts";
import { type Job, newJob, runPublish, validateKeywordPair, validatePublish } from "./publisher.ts";
import { serveFile } from "jsr:@std/http@1/file-server";
import { describeError, discoveryPath, findTrends, toRows, validUsername, type WatchReel, BASELINE_MIN_AGE_DAYS } from "../supabase/functions/scan-watchlist/logic.ts";
import { describe, patterns } from "../supabase/functions/scan-watchlist/describe.ts";

// --port lets a second copy run for testing while the usual one stays open.
const portArg = Deno.args.indexOf("--port");
const PORT = portArg >= 0 ? Number(Deno.args[portArg + 1]) : 8787;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const UPLOADS = new URL("../.uploads/", import.meta.url);
const PAGE = new URL("./index.html", import.meta.url);
const DASHBOARD_JS = new URL("./dashboard.js", import.meta.url);
const TRENDS_JS = new URL("./trends.js", import.meta.url);
const LIBRARY = new URL("../library/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function readEnvFile(): Record<string, string> {
  const text = Deno.readTextFileSync(new URL("../.env", import.meta.url));
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      return match ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

const env = readEnvFile();
const dryRun = Deno.args.includes("--dry-run");
for (const key of ["IG_TOKEN", "SUPABASE_PROJECT_REF", "SUPABASE_SECRET_KEY"]) {
  if (!env[key]) {
    console.error(`${key} is missing from .env. See the README.`);
    Deno.exit(1);
  }
}
const SUPABASE_URL = `https://${env.SUPABASE_PROJECT_REF}.supabase.co`;

const meta = createMeta(env.IG_TOKEN, env.API_VERSION || "v26.0");
const rules = createRules(SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const hosting = createHosting(SUPABASE_URL, env.SUPABASE_SECRET_KEY, UPLOADS);
const jobs = new Map<string, Job>();
let activeJob: string | null = null;

await Deno.remove(UPLOADS, { recursive: true }).catch(() => {});
await Deno.mkdir(UPLOADS, { recursive: true });

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

// A local server can be called by any website open in the browser, so requests must be from this page.
function fromThisPage(request: Request): boolean {
  if (!ALLOWED_HOSTS.has(request.headers.get("host") ?? "")) return false;
  if (request.method === "GET") return true;
  const origin = request.headers.get("origin");
  return origin !== null && ALLOWED_HOSTS.has(new URL(origin).host);
}

async function saveUpload(request: Request): Promise<Response> {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > MAX_VIDEO_BYTES) return fail("This video is over Instagram's 300 MB limit. Export it smaller and try again.", 413);
  if (!request.body) return fail("No video was sent.");
  const id = crypto.randomUUID();
  const file = await Deno.open(new URL(id, UPLOADS), { write: true, create: true });
  await request.body.pipeTo(file.writable);
  return json({ uploadId: id });
}

async function startPublish(request: Request): Promise<Response> {
  const body = await request.json();
  const problem = validatePublish(body);
  if (problem) return fail(problem);
  if (activeJob && jobs.get(activeJob)?.status === "running") return fail("A reel is already posting. Wait for it to finish.", 409);
  if (!/^[0-9a-f-]{36}$/.test(String(body.uploadId))) return fail("The video upload was lost. Choose the video again.");

  const path = new URL(body.uploadId, UPLOADS);
  const video = await Deno.readFile(path).catch(() => null);
  if (!video) return fail("The video upload was lost. Choose the video again.");

  const keyword = String(body.keyword ?? "").trim();
  const job = newJob(crypto.randomUUID(), Boolean(keyword), dryRun);
  jobs.set(job.id, job);
  activeJob = job.id;
  runPublish(job, {
    video,
    caption: body.caption,
    rule: keyword
      ? { keyword, dm_text: String(body.dm_text).trim(), public_reply: String(body.public_reply ?? "").trim() || null }
      : null,
  }, meta, rules, hosting, { dryRun }).finally(() => Deno.remove(path).catch(() => {}));
  return json({ jobId: job.id });
}

async function overview(): Promise<Response> {
  const account = await meta.account();
  const [posts, ruleList] = await Promise.all([meta.posts(account.id), rules.list()]);
  return json({ username: account.username, dryRun, posts, rules: ruleList });
}

async function addRule(request: Request): Promise<Response> {
  const body = await request.json();
  const problem = validateKeywordPair(body.keyword, body.dm_text);
  if (problem) return fail(problem);
  if (!String(body.keyword ?? "").trim()) return fail("Add a keyword.");
  if (!/^\d+$/.test(String(body.media_id))) return fail("Choose a reel for this keyword.");
  const rule = await rules.add({
    media_id: String(body.media_id),
    keyword: String(body.keyword).trim(),
    dm_text: String(body.dm_text).trim(),
    public_reply: String(body.public_reply ?? "").trim() || null,
  });
  return json(rule);
}


// ---- trends ------------------------------------------------------------------------------------

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error("Couldn't reach Supabase. Check your connection.");
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Supabase refused the request: ${body?.message ?? response.status}`);
  return body;
}

// Supabase returns at most 1,000 rows per request, so page through.
async function allWatchReels(since: string): Promise<WatchReel[]> {
  const rows: WatchReel[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(`watch_reels?select=*&posted_at=gte.${since}&order=posted_at.desc`, {
      headers: { Range: `${from}-${from + 999}` },
    });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const WATCH = new URL("watch/", LIBRARY);
const CTA_LABELS: Record<string, string> = {
  "Follow": "Follow", "Link in bio": "Link in bio", "Save or share": "Save or share", "DM": "DM me",
  "Question": "Asks a question", "None": "No CTA",
};

// What scripts/watch-library.ts made for a reel: screenshots and pacing always, Haiku's labels once
// ANTHROPIC_API_KEY is set. Null until the reel has been downloaded.
async function videoAnalysis(mediaId: string) {
  if (!/^\d+$/.test(mediaId)) return null;
  const dir = new URL(`${mediaId}/`, WATCH);
  const stats = await Deno.readTextFile(new URL("stats.json", dir)).then(JSON.parse, () => null);
  if (!stats) return null;
  const labels = await Deno.readTextFile(new URL("labels.json", dir)).then(JSON.parse, () => null);
  const sheets: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) if (/^sheet-\d+\.jpg$/.test(entry.name)) sheets.push(entry.name);
  } catch { /* removed meanwhile */ }
  const frames = [];
  for (const name of ["h01.jpg", "h04.jpg", "h07.jpg"]) {
    if (await Deno.stat(new URL(`hook/${name}`, dir)).then(() => true, () => false)) frames.push(`/watch/${mediaId}/hook/${name}`);
  }
  const { usage: _usage, ...rest } = labels ?? {};
  return {
    stats,
    labels: labels ? rest : null,
    frames,
    sheets: sheets.sort().map((name) => `/watch/${mediaId}/${name}`),
    transcript: await Deno.readTextFile(new URL("transcript.txt", dir)).catch(() => ""),
  };
}

async function trends(): Promise<Response> {
  const now = Date.now();
  const since = new Date(now - 120 * 86_400_000).toISOString();
  const [accounts, reels] = await Promise.all([
    rest("watch_accounts?select=*&order=username.asc"),
    allWatchReels(since),
  ]);
  const found = await Promise.all(findTrends(reels, now).map(async (trend) => {
    const fromCaption = describe(trend.caption);
    const video = await videoAnalysis(trend.media_id);
    const l = video?.labels;
    if (!l) return { ...trend, ...fromCaption, video, source: "caption" };
    // Haiku watched the reel, so its labels replace the caption guesses.
    return {
      ...trend,
      video,
      source: "video",
      hook: l.hook_spoken || l.hook_on_screen || fromCaption.hook,
      format: l.format,
      topics: l.topics.filter((topic: string) => topic !== "Other"),
      hook_type: l.hook_type,
      cta: {
        kind: l.cta_kind,
        label: l.cta_kind === "Comment keyword" ? `Comment "${String(l.cta_keyword || "?").toUpperCase()}"` : CTA_LABELS[l.cta_kind] ?? l.cta_kind,
      },
    };
  }));
  // Reels still collecting views would make every label look weak, so the summary skips them.
  const settled = found.filter((trend) => trend.age_days >= BASELINE_MIN_AGE_DAYS);
  const recent = found.length;
  const watched = found.filter((trend) => trend.source === "video").length;
  return json({
    accounts,
    trends: found,
    // Video formats and caption guesses use different names, so formats only count watched reels.
    patterns: patterns(settled.map((trend) => trend.source === "video" ? trend : { ...trend, format: "" })),
    analysis: { running: Boolean(watching), watched, recent, labels: Boolean(env.ANTHROPIC_API_KEY) },
  });
}

let watching: Promise<void> | null = null;

// Downloads, transcribes, screenshots and labels watched reels in the background (scripts/watch-library.ts).
function analyseWatchedReels() {
  watching ??= (async () => {
    const out = await new Deno.Command("deno", {
      args: ["run", "-A", "scripts/watch-library.ts"],
      cwd: ROOT.pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    if (!out.success) console.error(`Watched reels analysis failed:\n${log.slice(-1000)}`);
    else console.log(log.trim().split("\n").at(-1));
  })().finally(() => { watching = null; });
}
setTimeout(analyseWatchedReels, 5_000);
setInterval(analyseWatchedReels, 30 * 60_000);

async function watchFile(request: Request, mediaId: string, file: string): Promise<Response> {
  if (!/^\d+$/.test(mediaId) || !/^(sheet-\d+\.jpg|hook\/h\d+\.jpg)$/.test(file)) return fail("Not found.", 404);
  const response = await serveFile(request, new URL(`${mediaId}/${file}`, WATCH).pathname);
  response.headers.set("Cache-Control", "private, max-age=86400");
  return response;
}

// Reads the account straight away, so a typo or a personal account is caught before it's added.
async function addWatch(request: Request): Promise<Response> {
  const username = validUsername(String((await request.json()).username ?? ""));
  if (!username) return fail("That doesn't look like an Instagram username.");
  const account = await meta.account();
  const response = await fetch(`https://graph.facebook.com/${env.API_VERSION || "v26.0"}${discoveryPath(account.id, username)}`, {
    headers: { Authorization: `Bearer ${env.IG_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const body = await response?.json().catch(() => ({})) ?? {};
  if (!response?.ok || body.error) {
    const { reason } = describeError(body.error?.code, body.error?.error_subcode, body.error?.message ?? "Instagram didn't respond.");
    return fail(`Couldn't add @${username}. ${reason}`);
  }
  const found = body.business_discovery ?? {};
  const now = new Date();
  await rest("watch_accounts?on_conflict=username", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      username, enabled: true, display_name: found.name ?? null, followers: found.followers_count ?? null,
      media_count: found.media_count ?? null, last_scanned_at: now.toISOString(), last_error: null,
    }),
  });
  const rows = toRows(username, found, now);
  if (rows.length) {
    await rest("watch_reels?on_conflict=media_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows),
    });
  }
  return json({ username, reels: rows.length });
}

async function removeWatch(username: string): Promise<Response> {
  const name = validUsername(username);
  if (!name) return fail("That doesn't look like an Instagram username.");
  await rest(`watch_accounts?username=eq.${encodeURIComponent(name)}`, { method: "DELETE" });
  return json({ ok: true });
}

// ---- dashboard ---------------------------------------------------------------------------------

function parseCsv(text: string): Record<string, string | number | boolean | null>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((key, i) => {
    const v = r[i] ?? "";
    if (v === "") return [key, null];
    if (v === "true" || v === "false") return [key, v === "true"];
    return [key, /^-?\d+(\.\d+)?$/.test(v) && !/^(folder|keyword|media_id)$/.test(key) ? Number(v) : v];
  })));
}

async function supabase(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? await response.json() : [];
}

let refreshing: Promise<{ ok: boolean; log: string }> | null = null;

// Rebuilds library/ with scripts/library.ts: downloads and transcribes new reels, refreshes every number.
function refreshLibrary() {
  refreshing ??= (async () => {
    const out = await new Deno.Command("deno", {
      args: ["run", "-A", "scripts/library.ts"],
      cwd: ROOT.pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    if (!out.success) console.error(`Library refresh failed:\n${log.slice(-1000)}`);
    return { ok: out.success, log: log.slice(-2000) };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function dashboard(): Promise<Response> {
  const csv = await Deno.readTextFile(new URL("reels.csv", LIBRARY)).catch(() => "");
  const builtAt = (await Deno.stat(new URL("reels.csv", LIBRARY)).catch(() => null))?.mtime ?? null;
  const review = await Deno.readTextFile(new URL("review.md", LIBRARY)).catch(() => null);
  const reviewAt = (await Deno.stat(new URL("review.md", LIBRARY)).catch(() => null))?.mtime ?? null;
  const since = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const followers = await supabase(`account_snapshots?select=taken_at,followers&taken_at=gte.${since}&order=taken_at.asc`);
  return json({ reels: parseCsv(csv), builtAt, review, reviewAt, followers, refreshing: Boolean(refreshing) });
}

function parseVtt(vtt: string) {
  const t = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);
  return [...vtt.matchAll(/(\d\d):(\d\d):(\d\d\.\d+) --> (\d\d):(\d\d):(\d\d\.\d+)\n(.*)/g)].map((m) => ({
    start: t(m[1], m[2], m[3]), end: t(m[4], m[5], m[6]), text: m[7].trim(),
  }));
}

const SAFE_FOLDER = /^[A-Za-z0-9._-]+$/;

async function reelDetail(folder: string): Promise<Response> {
  if (!SAFE_FOLDER.test(folder) || folder.startsWith(".")) return fail("Not found.", 404);
  const dir = new URL(`${folder}/`, LIBRARY);
  const reel = JSON.parse(await Deno.readTextFile(new URL("reel.json", dir)).catch(() => "null"));
  if (!reel) return fail("That reel isn't in the library yet. Refresh the dashboard.", 404);
  const metrics = JSON.parse(await Deno.readTextFile(new URL("metrics.json", dir)).catch(() => "[]"));
  const cues = parseVtt(await Deno.readTextFile(new URL("transcript.vtt", dir)).catch(() => ""));
  const list = async (sub: string, pattern: RegExp) => {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(new URL(sub ? `${sub}/` : ".", dir))) {
        if (entry.isFile && pattern.test(entry.name)) names.push(sub ? `${sub}/${entry.name}` : entry.name);
      }
    } catch { /* folder not built yet */ }
    return names.sort();
  };
  return json({ folder, reel, metrics, cues, hook: await list("hook", /^h\d+\.jpg$/), sheets: await list("", /^sheet-\d+\.jpg$/) });
}

async function libraryFile(request: Request, folder: string, file: string): Promise<Response> {
  if (!SAFE_FOLDER.test(folder) || folder.startsWith(".")) return fail("Not found.", 404);
  if (!/^(video\.mp4|sheet-\d+\.jpg|hook\/h\d+\.jpg)$/.test(file)) return fail("Not found.", 404);
  const response = await serveFile(request, new URL(`${folder}/${file}`, LIBRARY).pathname);
  response.headers.set("Cache-Control", "private, max-age=3600");
  return response;
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (method === "GET" && pathname === "/") {
    return new Response(await Deno.readFile(PAGE), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' blob:; frame-ancestors 'none'",
      },
    });
  }
  if (method === "GET" && pathname === "/dashboard.js") {
    return new Response(await Deno.readFile(DASHBOARD_JS), {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (method === "GET" && pathname === "/trends.js") {
    return new Response(await Deno.readFile(TRENDS_JS), {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (method === "GET" && pathname === "/api/trends") return await trends();
  if (method === "POST" && pathname === "/api/watchlist") return await addWatch(request);
  const watchMatch = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
  if (method === "DELETE" && watchMatch) return await removeWatch(decodeURIComponent(watchMatch[1]));
  if (method === "GET" && pathname === "/api/dashboard") return await dashboard();
  if (method === "POST" && pathname === "/api/library/refresh") return json(await refreshLibrary());
  const reelMatch = pathname.match(/^\/api\/reels\/([^/]+)$/);
  if (method === "GET" && reelMatch) return await reelDetail(decodeURIComponent(reelMatch[1]));
  const watchFileMatch = pathname.match(/^\/watch\/(\d+)\/(.+)$/);
  if (method === "GET" && watchFileMatch) return await watchFile(request, watchFileMatch[1], watchFileMatch[2]);
  const fileMatch = pathname.match(/^\/library\/([^/]+)\/(.+)$/);
  if (method === "GET" && fileMatch) return await libraryFile(request, decodeURIComponent(fileMatch[1]), fileMatch[2]);
  if (method === "GET" && pathname === "/api/overview") return await overview();
  if (method === "POST" && pathname === "/api/upload") return await saveUpload(request);
  if (method === "POST" && pathname === "/api/publish") return await startPublish(request);
  if (method === "POST" && pathname === "/api/rules") return await addRule(request);
  const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    return job ? json(job) : fail("That post is no longer tracked.", 404);
  }
  const ruleMatch = pathname.match(/^\/api\/rules\/(\d+)$/);
  if (method === "PATCH" && ruleMatch) {
    const { enabled } = await request.json();
    await rules.setEnabled(Number(ruleMatch[1]), Boolean(enabled));
    return json({ ok: true });
  }
  return fail("Not found.", 404);
}

Deno.serve({
  hostname: "127.0.0.1",
  port: PORT,
  onListen: () => console.log(`Posting page: http://127.0.0.1:${PORT}${dryRun ? " (dry run, nothing gets posted)" : ""}`),
}, async (request) => {
  if (!fromThisPage(request)) return fail("Forbidden.", 403);
  try {
    return await route(request);
  } catch (error) {
    console.error((error as Error).message);
    return fail((error as Error).message, 500);
  }
});
