// Turns a downloaded reel into things that can be read: transcript, cuts, hook frames, contact sheets
// and pacing numbers. Shared by scripts/library.ts (your reels) and scripts/watch-library.ts (watched
// creators' reels). Needs ffmpeg, ffprobe and whisper-cli.
// Download ggml-small.en.bin into models/ (see the README), or set WHISPER_MODEL to another path.
export const WHISPER_MODEL = Deno.env.get("WHISPER_MODEL") ??
  new URL("../models/ggml-small.en.bin", import.meta.url).pathname;
const SCENE = "0.1"; // talking head + graphic cards: 0.3 misses jump cuts and card swaps

export async function sh(cmd: string[], quiet = true) {
  const out = await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" }).output();
  if (!out.success && !quiet) throw new Error(`${cmd[0]} failed: ${new TextDecoder().decode(out.stderr).slice(-300)}`);
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
}

export const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

export type Cue = { start: number; end: number; text: string };
export function parseVtt(vtt: string): Cue[] {
  const t = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);
  return [...vtt.matchAll(/(\d\d):(\d\d):(\d\d\.\d+) --> (\d\d):(\d\d):(\d\d\.\d+)\n(.*)/g)].map((m) => ({
    start: t(m[1], m[2], m[3]), end: t(m[4], m[5], m[6]), text: m[7].trim(),
  }));
}

// Watched reels use smaller contact sheets (sheetWidth 240, quality 6): about a quarter of the disk space.
export async function processVideo(dir: string, { sheetWidth = 360, sheetQuality }: { sheetWidth?: number; sheetQuality?: number } = {}) {
  const video = `${dir}/video.mp4`;
  const hasAudio = (await sh(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", video])).trim() !== "";
  if (!hasAudio && !await exists(`${dir}/transcript.vtt`)) {
    // Silent reels (music added in-app isn't in the file either) have nothing to transcribe.
    await Deno.writeTextFile(`${dir}/transcript.vtt`, "WEBVTT\n\n");
    await Deno.writeTextFile(`${dir}/transcript.txt`, "");
  }
  if (!await exists(`${dir}/transcript.vtt`)) {
    await sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", `${dir}/audio.wav`], false);
    await sh(["whisper-cli", "-m", WHISPER_MODEL, "-f", `${dir}/audio.wav`, "--output-txt", "--output-vtt", "--output-file", `${dir}/transcript`]);
    await Deno.remove(`${dir}/audio.wav`).catch(() => {});
  }
  if (!await exists(`${dir}/cuts.txt`)) {
    const log = await sh(["ffmpeg", "-nostdin", "-i", video, "-vf", `select='gt(scene,${SCENE})',showinfo`, "-an", "-f", "null", "-"]);
    const cuts = [...log.matchAll(/pts_time:([0-9.]+)/g)].map((m) => m[1]);
    await Deno.writeTextFile(`${dir}/cuts.txt`, cuts.join("\n") + (cuts.length ? "\n" : ""));
  }
  if (!await exists(`${dir}/hook`)) {
    await Deno.mkdir(`${dir}/hook`);
    await sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-t", "3", "-i", video, "-vf", "fps=3,scale=540:-2", `${dir}/hook/h%02d.jpg`]);
  }
  if (!await exists(`${dir}/sheet-01.jpg`)) {
    await sh([
      "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", video, "-vf", `fps=1,scale=${sheetWidth}:-2,tile=3x3:padding=4:color=white`,
      ...(sheetQuality ? ["-q:v", String(sheetQuality)] : []), `${dir}/sheet-%02d.jpg`,
    ]);
  }
}

export async function stats(dir: string) {
  const duration = Number((await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${dir}/video.mp4`])).trim());
  const cuts = (await Deno.readTextFile(`${dir}/cuts.txt`).catch(() => "")).split("\n").filter(Boolean).map(Number);
  const cues = parseVtt(await Deno.readTextFile(`${dir}/transcript.vtt`).catch(() => ""));
  const words = cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
  // Whisper always starts its first segment at 0, so speech onset comes from the audio: the end of any
  // leading silence in the first 5 seconds.
  const silence = await sh(["ffmpeg", "-nostdin", "-t", "5", "-i", `${dir}/video.mp4`, "-af", "silencedetect=noise=-30dB:d=0.1", "-f", "null", "-"]);
  const lead = silence.match(/silence_start: (-?[\d.]+)[\s\S]*?silence_end: ([\d.]+)/);
  const onset = lead && Number(lead[1]) < 0.05 ? Math.round(Number(lead[2]) * 100) / 100 : 0;
  const hookCues = cues.filter((c) => c.start < 3);
  const cta = cues.find((c) => /\bcomment\b/i.test(c.text));
  const follow = cues.find((c) => /\bfollow (me|for|along)\b|\bhit follow\b/i.test(c.text));
  return {
    duration_s: Math.round(duration * 10) / 10,
    cuts: cuts.length,
    cuts_per_10s: duration ? Math.round((cuts.length / duration) * 100) / 10 : null,
    first_cut_s: cuts[0] ?? null,
    words,
    wpm: duration ? Math.round((words / duration) * 60) : null,
    first_word_s: cues.length ? onset : null,
    hook_spoken: hookCues.map((c) => c.text).join(" "),
    hook_words: hookCues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0),
    cta_comment_at_s: cta?.start ?? null,
    cta_comment_line: cta?.text ?? null,
    cta_follow_at_s: follow?.start ?? null,
    // "comment, guide, and I'll..." / "comment PLAN below" -> the word right after "comment"
    cta_keyword_spoken: cta?.text.match(/\bcomment\b[\s,"“']*([A-Za-z][\w-]*)/i)?.[1]?.toUpperCase() ?? null,
  };
}
