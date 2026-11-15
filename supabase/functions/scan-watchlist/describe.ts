// Labels for a watched reel, read from its caption: the hook, the call to action, the topics and the
// format. Instagram doesn't share other creators' video or audio, so these are best guesses from the
// text, and the cover image on the page shows the rest. Free of Deno-only imports, like logic.ts.
import { TOPICS } from "./niche.ts";

export type Cta = { kind: string; label: string };
export type About = { hook: string | null; cta: Cta; topics: string[]; format: string };

// Folds styled letters (𝗧𝗛𝗘 → THE) and curly quotes so the patterns below see plain text.
function plain(caption: string): string {
  return caption.normalize("NFKC").replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");
}

const CTA_START = /^(comment|type|drop|follow|dm|save|share|link in bio|subscribe)\b/i;

function sentences(caption: string): string[] {
  return plain(caption)
    .split("\n").map((line) => line.replace(/[#@][\w.]+/g, "").trim()).filter((line) => /\p{L}/u.test(line))
    .flatMap((line) => line.match(/.{12,}?[.!?]+(?=\s|$)|.+$/gu) ?? [])
    .map((sentence) => sentence.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// The caption's first sentence, without hashtags or mentions, skipping a CTA that opens it.
// Captions usually open with the hook the video says out loud.
export function hookOf(caption: string | null): string | null {
  if (!caption) return null;
  const all = sentences(caption);
  const hook = all.find((sentence) => !CTA_START.test(sentence)) ?? all[0];
  if (!hook) return null;
  return hook.length > 120 ? `${hook.slice(0, 117).trimEnd()}…` : hook;
}

const NOT_KEYWORDS = new Set([
  "below", "down", "your", "you", "if", "what", "and", "a", "an", "the", "which", "with", "in", "on",
  "for", "yes", "here", "this", "it", "me", "my", "any", "and", "to", "or", "how", "why", "who",
]);

export function ctaOf(caption: string | null): Cta {
  const text = plain(caption ?? "");
  for (const match of text.matchAll(/\b(?:comment|type|drop|reply|write)\s+(?:the\s+word\s+)?"?'?([A-Za-z0-9][\w-]{0,20})/gi)) {
    const word = match[1];
    if (!NOT_KEYWORDS.has(word.toLowerCase())) return { kind: "Comment keyword", label: `Comment "${word.toUpperCase()}"` };
  }
  const rules: [RegExp, string, string][] = [
    [/\b(dm me|send me a dm|message me)\b/i, "DM", "DM me"],
    [/\b(link in (my )?bio|newsletter|subscribe|sign up)\b/i, "Link in bio", "Link in bio"],
    [/\bfollow\b/i, "Follow", "Follow"],
    [/\bsave (this|it|for later)\b/i, "Save or share", "Save this"],
    [/\b(share (this|it)|send (this|it) to|tag (a|someone|your))\b/i, "Save or share", "Share or tag"],
    [/\?\s*(#[\w.]+\s*)*$|\b(let me know|what do you think|tell me|comment below|in the comments)\b/i, "Question", "Asks a question"],
  ];
  for (const [pattern, kind, label] of rules) if (pattern.test(text)) return { kind, label };
  return { kind: "None", label: "No CTA" };
}


export function topicsOf(caption: string | null): string[] {
  const text = plain(caption ?? "");
  return TOPICS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name).slice(0, 3);
}

// One format per reel, first match wins, so the more specific patterns come first.
const FORMATS: [string, RegExp][] = [
  ["Series", /\b(part|pt\.?)\s*\d+\b|\bday\s*\d+\b|\bep(isode)?\.?\s*\d+\b/i],
  ["Day in the life", /\b(day in (the|my) life|vlog|bts|behind the scenes|come with me)\b/i],
  ["List", /\btop\s*\d+\b|\b\d+\s+(things|ways|tips|tools|papers|projects|stocks|reasons|mistakes|books|apps|steps|signs|foods|habits|programs|competitions|specialt\w*)\b/i],
  ["Comparison", /\bvs\.?\b|\bversus\b/i],
  ["News breakdown", /\b(just (released|announced|launched|dropped|revealed|got|made)|yesterday|this week|last (week|month)|hours ago|breaking|announced|unveiled|revealed|cleared for|here's what happened)\b/i],
  ["Myth-busting", /\b(myths?|the truth about|nonsense|stop (doing|believing|saying)|unpopular opinion|misinformation|debunk\w*)\b/i],
  ["Tutorial or roadmap", /\b(how to|roadmap|crash course|step[- ]by[- ]step|tutorial|explained|guide|from scratch|here's how|learn(ed)? it)\b/i],
  ["Personal story", /\b(i spent|i built|i made|i quit|i got|i tried|i learned|i went|my (journey|story)|when i was)\b/i],
];

// When the caption has none of the above, the hook's shape still says a lot.
const HOOK_SHAPES: [string, RegExp][] = [
  ["Story about someone", /^(a|an|this|the|for \w+ years,?)\s+((\w+\s+){0,3})?(man|woman|girl|guy|kid|teen\w*|doctor|surgeon|student|founder|company|team|patient|professor|scientist)s?\b/i],
  ["Explainer", /^(why|how|what|when|where|can|could|is|are|do|does|did|which)\b|\?$/i],
  ["Direct advice", /^(your|you|if you|stop|don't|do this|never|always|here's|this is your sign)\b/i],
  ["Bold claim", /\b(insane|crazy|incredible|unreal|wild|is coming for|the future|changes everything|no one|nobody|secret|game[- ]?changer|can now|just)\b/i],
];

export function formatOf(caption: string | null): string {
  const text = plain(caption ?? "");
  const listed = FORMATS.find(([, pattern]) => pattern.test(text))?.[0];
  if (listed) return listed;
  const hook = hookOf(caption) ?? "";
  return HOOK_SHAPES.find(([, pattern]) => pattern.test(hook))?.[0] ?? "Other";
}

export function describe(caption: string | null): About {
  return { hook: hookOf(caption), cta: ctaOf(caption), topics: topicsOf(caption), format: formatOf(caption) };
}

export type PatternRow = { label: string; reels: number; hot: number; median: number };
export type Patterns = { topics: PatternRow[]; formats: PatternRow[]; hookTypes: PatternRow[]; ctas: PatternRow[] };

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Which topics, formats and CTAs beat their creators' usual views, across all recent reels. A label
// needs at least `minReels` reels so one lucky post doesn't top the list.
// hook_type only exists for reels whose video was analysed (scripts/watch-labels.ts).
export function patterns(reels: (About & { multiple: number; hook_type?: string })[], hotAt = 2, minReels = 3): Patterns {
  const group = (keysOf: (reel: About & { hook_type?: string }) => string[]) => {
    const groups = new Map<string, number[]>();
    for (const reel of reels) {
      for (const key of keysOf(reel)) groups.set(key, [...(groups.get(key) ?? []), reel.multiple]);
    }
    return [...groups].filter(([, multiples]) => multiples.length >= minReels)
      .map(([label, multiples]) => ({
        label,
        reels: multiples.length,
        hot: multiples.filter((m) => m >= hotAt).length,
        median: medianOf(multiples),
      }))
      .sort((a, b) => b.median - a.median);
  };
  return {
    topics: group((reel) => reel.topics.length ? reel.topics : ["No clear topic"]),
    formats: group((reel) => reel.format ? [reel.format] : []),
    hookTypes: group((reel) => reel.hook_type ? [reel.hook_type] : []),
    ctas: group((reel) => [reel.cta.kind]),
  };
}
