// Trend spotting for the creator watchlist. Shared by the scan-watchlist Edge Function and the
// local page (app/server.ts), so keep it free of Deno-only or npm imports.

export const MEDIA_PER_ACCOUNT = 25;
export const RECENT_DAYS = 14;
export const MIN_BASELINE = 5;
export const OUTLIER_MULTIPLE = 2;
// Reels this young are still collecting views, so they'd drag "usual" down.
export const BASELINE_MIN_AGE_DAYS = 2;
// Trial reels only go to non-followers and get a fraction of a normal reel's views. Instagram
// doesn't say which of another creator's reels are trials, so reels under this share of the
// creator's 90th-percentile views are left out of "usual". Heavy trial posters can have more trials than normal reels, so it has to be a high percentile.
export const TRIAL_SHARE = 0.05;

// Business Discovery reads another professional account's public profile and media through your
// own account. Personal accounts aren't readable this way.
export function discoveryPath(igUserId: string, username: string): string {
  const media = `media.limit(${MEDIA_PER_ACCOUNT}){id,caption,permalink,thumbnail_url,timestamp,media_product_type,view_count,like_count,comments_count}`;
  const fields = `business_discovery.username(${username}){username,name,followers_count,media_count,${media}}`;
  return `/${igUserId}?fields=${encodeURIComponent(fields)}`;
}

export function validUsername(value: string): string | null {
  const name = value.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(name) ? name : null;
}

type DiscoveryMedia = {
  id: string;
  caption?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp: string;
  media_product_type?: string;
  view_count?: number;
  like_count?: number;
  comments_count?: number;
};
export type Discovery = {
  username?: string;
  name?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: DiscoveryMedia[] };
};

export type WatchReel = {
  media_id: string;
  username: string;
  permalink: string | null;
  // Instagram's cover image link. It expires after a few days, and each scan refreshes it.
  thumbnail_url: string | null;
  caption: string | null;
  posted_at: string;
  product_type: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  updated_at: string;
};

export function toRows(username: string, found: Discovery, now: Date): WatchReel[] {
  return (found.media?.data ?? []).map((m) => ({
    media_id: m.id,
    username,
    permalink: m.permalink ?? null,
    thumbnail_url: m.thumbnail_url ?? null,
    caption: m.caption ?? null,
    posted_at: new Date(Date.parse(m.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))).toISOString(),
    product_type: m.media_product_type ?? null,
    views: m.view_count ?? null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    updated_at: now.toISOString(),
  }));
}

// Plain-language reason for an account that couldn't be read. Rate limits and a dead token stop
// the whole scan; anything else only skips that account.
export function describeError(code: number | undefined, subcode: number | undefined, message: string) {
  if (code === 190) return { stop: true, reason: "The Instagram token was rejected." };
  if (code !== undefined && [4, 17, 32, 613].includes(code)) return { stop: true, reason: "Meta's rate limit was reached." };
  if (code === 110 || subcode === 2207013 || /cannot be found|not.*business/i.test(message)) {
    return { stop: false, reason: "Not found, or not a business or creator account, so Instagram won't share its reels." };
  }
  return { stop: false, reason: message.slice(0, 200) };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export type Trend = WatchReel & { baseline: number; multiple: number; age_days: number };

// A reel counts as a trend when it beats its own creator's usual views, not when it's just big:
// a large account's average reel would otherwise always win.
export function findTrends(reels: WatchReel[], now: number, days = RECENT_DAYS): Trend[] {
  const byCreator = new Map<string, WatchReel[]>();
  for (const reel of reels) {
    if (reel.product_type !== "REELS" || reel.views === null) continue;
    byCreator.set(reel.username, [...(byCreator.get(reel.username) ?? []), reel]);
  }
  const trends: Trend[] = [];
  for (const own of byCreator.values()) {
    for (const reel of own) {
      const age = (now - Date.parse(reel.posted_at)) / 86_400_000;
      if (age > days) continue;
      const settled = own.filter((other) =>
        other.media_id !== reel.media_id && now - Date.parse(other.posted_at) >= BASELINE_MIN_AGE_DAYS * 86_400_000
      ).map((other) => other.views!);
      const floor = (percentile(settled, 0.9) ?? 0) * TRIAL_SHARE;
      const others = settled.filter((views) => views >= floor);
      if (others.length < MIN_BASELINE) continue;
      const baseline = median(others)!;
      if (baseline <= 0) continue;
      trends.push({ ...reel, baseline, multiple: reel.views! / baseline, age_days: age });
    }
  }
  return trends.sort((a, b) => b.multiple - a.multiple);
}
