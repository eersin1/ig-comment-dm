export const MAX_ATTEMPTS = 3;
export const WINDOW_DAYS = 7;
export const MAX_RULES_PER_RUN = 3;
const RUN_INTERVAL_MS = 30_000;
const OLDER_REELS_INTERVAL_MS = 120_000;

// A 5xx may mean the DM was delivered anyway, and a missed DM is better than a duplicate.
export const RETRY_5XX = false;

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const TOKEN_CODES = new Set([102, 190]);

export type Rule = {
  id: number;
  media_id: string;
  keyword: string;
  dm_text: string;
  public_reply: string | null;
  active_from: string;
};

export type Comment = {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
};

export type FailureKind = "token" | "rate_limit" | "server" | "network" | "other";

// Commenters type accents inconsistently, so "ışık" and "isik" count as the same word.
// Only Latin letters are folded, because marks carry meaning in scripts like Devanagari.
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[Iı]/g, "i")
    .toLowerCase();
}

const HYPHENS = /[-\u2010-\u2015]/g;

function keywordPattern(keyword: string): RegExp {
  const word = normalize(keyword.trim())
    .replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")
    // "x-ray" also matches "x ray", "xray" and typographic hyphens.
    .replace(/[-‐-―]/g, "[-\\u2010-\\u2015\\s]?");
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u");
}

export function matchesKeyword(text: string, keyword: string): boolean {
  if (!keyword.trim()) return false;
  const pattern = keywordPattern(keyword);
  const comment = normalize(text);
  // The second test lets an "xray" rule match "X-RAY" without "guide-please" failing to match "guide".
  return pattern.test(comment) || pattern.test(comment.replace(HYPHENS, ""));
}

// Meta sends "+0000", which isn't a strict ISO offset.
export function parseTime(timestamp: string): number {
  return Date.parse(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

export function shouldSkip(comment: Comment, rule: Rule, ownUsername: string, now: number): boolean {
  const posted = parseTime(comment.timestamp);
  if (Number.isNaN(posted)) return true;
  if (posted < Date.parse(rule.active_from)) return true;
  if (posted < now - WINDOW_DAYS * 86_400_000) return true;
  if (normalize(comment.username ?? "") === normalize(ownUsername)) return true;
  return !matchesKeyword(comment.text ?? "", rule.keyword);
}

// People who commented the keyword before the rule existed were already handled by hand,
// so a later comment from them doesn't earn a second message.
export function earlierCommenters(comments: Comment[], rule: Rule): Set<string> {
  const start = Date.parse(rule.active_from);
  return new Set(
    comments
      .filter((comment) => comment.username && parseTime(comment.timestamp) < start)
      .filter((comment) => matchesKeyword(comment.text ?? "", rule.keyword))
      .map((comment) => normalize(comment.username!)),
  );
}

// Meta flagged this account for suspicious activity once, so API calls stay flat however many
// rules are on: the newest rule runs every time and the others take turns.
export function pickRules(rules: Rule[], now: number): Rule[] {
  const sorted = [...rules].sort((a, b) => b.id - a.id);
  if (sorted.length === 0) return [];
  const [newest, ...others] = sorted;
  // Runs come every 30 seconds. Only the newest reel gets all of them, to keep API use low.
  if (Math.floor(now / RUN_INTERVAL_MS) % (OLDER_REELS_INTERVAL_MS / RUN_INTERVAL_MS) !== 0) return [newest];
  if (sorted.length <= MAX_RULES_PER_RUN) return sorted;
  const turns = MAX_RULES_PER_RUN - 1;
  const start = (Math.floor(now / OLDER_REELS_INTERVAL_MS) * turns) % others.length;
  return [newest, ...Array.from({ length: turns }, (_, i) => others[(start + i) % others.length])];
}

export function classify(status: number | null, code?: number, message = ""): FailureKind {
  if (status === null) return "network";
  if (code !== undefined && TOKEN_CODES.has(code)) return "token";
  // Meta blocking the whole app stops every call, so it must alert like a dead token.
  if (code === 200 && /api access blocked/i.test(message)) return "token";
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) return "rate_limit";
  if (status >= 500) return "server";
  return "other";
}

// A rejected token and a rate limit both mean Meta refused the send, so no DM went out.
// A network failure leaves the outcome unknown, so it's never retried.
export function shouldRetry(kind: FailureKind, attempts: number): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (kind === "rate_limit" || kind === "token") return true;
  return kind === "server" && RETRY_5XX;
}

export async function secretsMatch(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;
}
