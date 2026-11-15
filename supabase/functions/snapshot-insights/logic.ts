// Every per-reel insights metric worth keeping. Meta rejects the whole request if one name is
// invalid for this media, so index.ts probes them one by one and remembers which ones work.
export const METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "total_interactions",
  "follows",
  "profile_visits",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
  "clips_replays_count",
  "reposts",
] as const;

const HOUR = 3_600_000;
const TOLERANCE = 5 * 60_000;
export const MAX_AGE_DAYS = 30;

// Hourly for the first two days, every 6 hours to day 7, then daily to day 30.
export function cadenceMs(ageHours: number): number | null {
  if (ageHours < 48) return HOUR;
  if (ageHours < 168) return 6 * HOUR;
  if (ageHours < MAX_AGE_DAYS * 24) return 24 * HOUR;
  return null;
}

export function isDue(postedAt: string, lastTakenAt: string | null, now: number): boolean {
  const ageHours = (now - Date.parse(postedAt)) / HOUR;
  const cadence = cadenceMs(ageHours);
  if (cadence === null) return false;
  if (!lastTakenAt) return true;
  return now - Date.parse(lastTakenAt) >= cadence - TOLERANCE;
}

type InsightRow = { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } };

export function parseInsights(body: { data?: InsightRow[] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of body.data ?? []) {
    const value = row.total_value?.value ?? row.values?.[0]?.value;
    if (typeof value === "number") out[row.name] = value;
  }
  return out;
}

export async function secretsMatch(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;
}
