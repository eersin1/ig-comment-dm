// Asks Claude Haiku 5.5 to label one watched reel from its screenshots, transcript and pacing numbers:
// the format you'd see, the hook, the topic and the call to action. About a tenth of a cent a reel.
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@1.6.0/helpers/zod";
import { z } from "npm:zod@4.6.7";
import { NICHE, TOPICS as NICHE_TOPICS } from "../supabase/functions/scan-watchlist/niche.ts";

export const LABEL_MODEL = "claude-haiku-5-5";

export const FORMATS = [
  "Talking head",
  "Talking head + green screen",
  "Talking head + b-roll",
  "Voiceover on b-roll",
  "Screen recording or demo",
  "Text or slides on screen",
  "Vlog or day in the life",
  "Interview or podcast clip",
  "Skit or meme",
  "Other",
] as const;

export const HOOK_TYPES = [
  "Bold claim",
  "Question",
  "News",
  "Story",
  "Surprising fact or number",
  "Speaks to the viewer",
  "Visual stunt",
  "Other",
] as const;

// Edit topics in supabase/functions/scan-watchlist/niche.ts.
const [firstTopic, ...otherTopics] = [...NICHE_TOPICS.map(([name]) => name), "Other"];
export const TOPICS: [string, ...string[]] = [firstTopic, ...otherTopics];

export const CTA_KINDS = ["Comment keyword", "Follow", "Link in bio", "Save or share", "DM", "Question", "None"] as const;

export const Labels = z.object({
  format: z.enum(FORMATS),
  format_note: z.string().describe("One short sentence on what the viewer sees, e.g. 'At a desk, cutting every 2s to paper screenshots'"),
  hook_spoken: z.string().describe("The first sentence said out loud, word for word from the transcript. Empty if nobody speaks."),
  hook_on_screen: z.string().describe("A title or text on screen in the first 2 seconds that isn't just captions of the speech, word for word. Empty if none."),
  hook_type: z.enum(HOOK_TYPES),
  topic: z.string().describe("What the reel is about in 3 to 6 words"),
  topics: z.array(z.enum(TOPICS)).describe("1 to 3 broad topics, most important first"),
  cta_kind: z.enum(CTA_KINDS).describe("The main call to action, said or shown in the video or written in the caption"),
  cta_keyword: z.string().describe("The single word viewers are asked to comment if the CTA is 'Comment keyword', else empty"),
  why_it_works: z.string().describe("One sentence: the most likely reason this reel holds attention, based on what you see and hear"),
});
export type Labels = z.infer<typeof Labels>;

const SYSTEM = `You label Instagram reels from ${NICHE} creators, so a creator in the same niche can see which formats, hooks and calls to action are working.

You get the reel's opening frames (0s, 1s, 2s), contact sheets of the whole video (each sheet is 9 frames, one per second, read left to right and top to bottom), the timed transcript, pacing numbers and the caption.

Label what is actually in the video, not what the caption claims. Pick the format from what the frames show:
- "Talking head" when it's mostly the person on camera, even with props or zooms. Use "+ b-roll" only when other footage, images or screen captures are cut in, and "+ green screen" only when the person is placed over an image or video.
- hook_on_screen is a title or text that differs from the speech. Word-by-word captions of what is being said don't count, so leave it empty when the only text on screen is those captions.
- "Comment keyword" is only for asking viewers to comment a specific word to get something sent to them, like "comment GUIDE and I'll send it". Asking viewers to comment their own answer or opinion ("comment your major", "tell me below") is "Question".
If nobody speaks, leave hook_spoken empty. If there is no call to action, use "None".`;

type Meta = { username: string; caption: string | null };

const b64 = async (path: string) => {
  const bytes = await Deno.readFile(path);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function images(dir: string) {
  const hook = ["h01.jpg", "h04.jpg", "h07.jpg"].map((name) => `${dir}/hook/${name}`);
  const sheets: string[] = [];
  for await (const entry of Deno.readDir(dir)) if (/^sheet-\d+\.jpg$/.test(entry.name)) sheets.push(`${dir}/${entry.name}`);
  sheets.sort();
  // First, middle and last sheet cover the opening, the body and the ending CTA.
  const picked = [...new Set([sheets[0], sheets[Math.floor(sheets.length / 2)], sheets.at(-1)])].filter(Boolean) as string[];
  const blocks: Anthropic.ImageBlockParam[] = [];
  for (const path of [...hook, ...picked]) {
    try {
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await b64(path) } });
    } catch { /* a very short reel has fewer hook frames */ }
  }
  return blocks;
}

export async function labelReel(client: Anthropic, dir: string, meta: Meta, stats: Record<string, unknown>, transcript: string) {
  const text = [
    `Creator: @${meta.username}`,
    `Pacing: ${JSON.stringify(stats)}`,
    `Transcript (timed):\n${transcript.trim() || "(no speech)"}`,
    `Caption:\n${(meta.caption ?? "").slice(0, 2000) || "(none)"}`,
  ].join("\n\n");
  const response = await client.messages.parse({
    model: LABEL_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(Labels) },
    messages: [{ role: "user", content: [...await images(dir), { type: "text", text }] }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to label this reel.");
  if (!response.parsed_output) throw new Error(`No labels came back (stop reason: ${response.stop_reason}).`);
  return { ...response.parsed_output, model: LABEL_MODEL, usage: response.usage, labelled_at: new Date().toISOString() };
}
