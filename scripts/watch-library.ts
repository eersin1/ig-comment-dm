// Builds library/watch/<media_id>/ for watched creators' reels from the last 14 days, newest first:
//   1. downloads the reel with yt-dlp (public link, no Instagram login)
//   2. transcript, cuts, hook frames and contact sheets, like your own reels (scripts/reel-media.ts)
//   3. pacing numbers -> stats.json
//   4. if ANTHROPIC_API_KEY is in .env, Claude Haiku 5.5 labels it -> labels.json
//   5. deletes the video, keeping the transcript and screenshots (about 1 MB a reel)
// Folders for reels older than 30 days are removed.
//
//   deno run -A scripts/watch-library.ts [--limit N]
//
// Runs in the background from app/server.ts while the posting page is open.
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { exists, processVideo, stats } from "./reel-media.ts";
import { labelReel } from "./watch-labels.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const WATCH = `${ROOT}library/watch`;
const RECENT_DAYS = 14;
const KEEP_DAYS = 30;
const PAUSE_MS = 3000; // between downloads, to stay well clear of Instagram's limits
const MAX_FAILED_DOWNLOADS = 3; // in a row: Instagram is probably refusing, so try again next run

const env = Object.fromEntries(
  Deno.readTextFileSync(`${ROOT}.env`).split("\n").flatMap((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }),
);
const SUPABASE_URL = `https://${env.SUPABASE_PROJECT_REF}.supabase.co`;
const limitArg = Deno.args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(Deno.args[limitArg + 1]) : Infinity;
const claude = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
if (!claude) console.log("No ANTHROPIC_API_KEY in .env: transcripts and screenshots only, no labels.");

type Row = { media_id: string; username: string; permalink: string | null; caption: string | null; posted_at: string };

async function recentReels(): Promise<Row[]> {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/watch_reels?select=media_id,username,permalink,caption,posted_at&product_type=eq.REELS&posted_at=gte.${since}&order=posted_at.desc`,
    { headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, Range: "0-1999" } },
  );
  if (!r.ok) throw new Error(`Supabase watch_reels: HTTP ${r.status}`);
  return r.json();
}

async function download(url: string, dir: string): Promise<boolean> {
  const out = await new Deno.Command("yt-dlp", {
    args: [
      "--no-playlist", "--quiet", "--no-warnings", "--socket-timeout", "30",
      "--merge-output-format", "mp4", "-o", `${dir}/video.%(ext)s`, url,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return out.success && await exists(`${dir}/video.mp4`);
}

async function prune() {
  if (!await exists(WATCH)) return;
  for await (const entry of Deno.readDir(WATCH)) {
    if (!entry.isDirectory) continue;
    const meta = await Deno.readTextFile(`${WATCH}/${entry.name}/meta.json`).then(JSON.parse, () => null);
    if (meta && Date.now() - Date.parse(meta.posted_at) > KEEP_DAYS * 86_400_000) {
      await Deno.remove(`${WATCH}/${entry.name}`, { recursive: true });
    }
  }
}

await Deno.mkdir(WATCH, { recursive: true });

// One run at a time, even with two copies of the page open. A lock whose process is gone, or that's
// older than 2 hours, is from a run that was stopped.
const LOCK = `${WATCH}/.lock`;
const lockAge = await Deno.stat(LOCK).then((s) => Date.now() - (s.mtime?.getTime() ?? 0), () => null);
const lockPid = await Deno.readTextFile(LOCK).then((text) => text.trim(), () => "");
const lockAlive = /^\d+$/.test(lockPid) &&
  (await new Deno.Command("/bin/kill", { args: ["-0", lockPid], stdout: "null", stderr: "null" }).output()).success;
if (lockAge !== null && lockAge < 2 * 3_600_000 && lockAlive) {
  console.log("watch library: another run is going, so this one stops.");
  Deno.exit(0);
}
await Deno.writeTextFile(LOCK, String(Deno.pid));
globalThis.addEventListener("unload", () => { try { Deno.removeSync(LOCK); } catch { /* already gone */ } });

await prune();
const reels = (await recentReels()).filter((r) => r.permalink && /^\d+$/.test(r.media_id)).slice(0, LIMIT);
let failedInARow = 0, analysed = 0, labelled = 0, skipped = 0;

for (const [i, reel] of reels.entries()) {
  const dir = `${WATCH}/${reel.media_id}`;
  const hasStats = await exists(`${dir}/stats.json`);
  const hasLabels = await exists(`${dir}/labels.json`);
  if (hasStats && (hasLabels || !claude)) continue;
  console.log(`[${i + 1}/${reels.length}] @${reel.username} ${reel.media_id}`);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify(reel, null, 2));

  if (!hasStats) {
    if (!await exists(`${dir}/video.mp4`)) {
      if (!await download(reel.permalink!, dir)) {
        console.log("    download failed");
        skipped++;
        if (++failedInARow >= MAX_FAILED_DOWNLOADS) {
          console.log(`Stopping: ${MAX_FAILED_DOWNLOADS} downloads failed in a row. Instagram may be limiting downloads, so the next run will try again.`);
          break;
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    failedInARow = 0;
    try {
      await processVideo(dir, { sheetWidth: 240, sheetQuality: 6 });
      await Deno.writeTextFile(`${dir}/stats.json`, JSON.stringify(await stats(dir), null, 2));
      analysed++;
    } catch (error) {
      // One odd video shouldn't stop the rest. It's tried again on the next run.
      console.log(`    analysis failed: ${(error as Error).message.slice(0, 200)}`);
      skipped++;
      continue;
    } finally {
      await Deno.remove(`${dir}/video.mp4`).catch(() => {});
    }
  }

  if (claude && !hasLabels) {
    try {
      const s = JSON.parse(await Deno.readTextFile(`${dir}/stats.json`));
      const transcript = await Deno.readTextFile(`${dir}/transcript.vtt`).catch(() => "");
      const labels = await labelReel(claude, dir, reel, s, transcript.replace(/^WEBVTT\s*/, ""));
      await Deno.writeTextFile(`${dir}/labels.json`, JSON.stringify(labels, null, 2));
      labelled++;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        console.log("Stopping: Anthropic rejected the API key in .env.");
        break;
      }
      if (error instanceof Anthropic.RateLimitError) {
        console.log("Stopping: Anthropic rate limit reached. The next run continues.");
        break;
      }
      console.log(`    labels failed: ${(error as Error).message.replace(/\s+/g, " ").slice(0, 600)}`);
    }
  }
}
console.log(`\nwatch library: ${analysed} new reels analysed, ${labelled} labelled, ${skipped} skipped, ${reels.length} recent reels in total.`);
