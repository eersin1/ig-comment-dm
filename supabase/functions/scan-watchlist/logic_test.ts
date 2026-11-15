import { assertEquals } from "jsr:@std/assert@1";
import { describeError, discoveryPath, findTrends, median, toRows, validUsername, type WatchReel } from "./logic.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const reel = (username: string, id: string, views: number | null, daysAgo: number, product = "REELS"): WatchReel => ({
  media_id: id, username, permalink: null, thumbnail_url: null, caption: null, product_type: product, views, likes: 0, comments: 0,
  posted_at: new Date(NOW - daysAgo * 86_400_000).toISOString(), updated_at: new Date(NOW).toISOString(),
});

Deno.test("usernames are cleaned from @handles and profile links, and junk is refused", () => {
  assertEquals(validUsername("@Another.Creator"), "another.creator");
  assertEquals(validUsername("https://www.instagram.com/example.creator/"), "example.creator");
  assertEquals(validUsername("not a name"), null);
  assertEquals(validUsername(""), null);
});

Deno.test("the discovery request asks for views, likes and comments", () => {
  const path = decodeURIComponent(discoveryPath("1", "another.creator"));
  assertEquals(path.includes("business_discovery.username(another.creator)"), true);
  assertEquals(path.includes("view_count"), true);
});

Deno.test("a reel is a trend relative to its own creator, not by raw size", () => {
  const small = ["a1", "a2", "a3", "a4", "a5"].map((id, i) => reel("small", id, 1_000, 20 + i));
  const big = ["b1", "b2", "b3", "b4", "b5"].map((id, i) => reel("big", id, 1_000_000, 20 + i));
  const trends = findTrends([...small, ...big, reel("small", "a6", 5_000, 2), reel("big", "b6", 1_200_000, 2)], NOW);
  assertEquals(trends.map((t) => [t.media_id, t.multiple]), [["a6", 5], ["b6", 1.2]]);
});

Deno.test("old reels, non-reels, missing views and thin baselines are left out", () => {
  const base = ["c1", "c2", "c3", "c4", "c5"].map((id, i) => reel("c", id, 100, 30 + i));
  const trends = findTrends([
    ...base,
    reel("c", "old", 900, 20),
    reel("c", "photo", 900, 1, "FEED"),
    reel("c", "hidden", null, 1),
    reel("thin", "t1", 10, 30), reel("thin", "t2", 900, 1),
  ], NOW);
  assertEquals(trends.map((t) => t.media_id), []);
});

Deno.test("a creator's trial reels and brand-new reels don't drag their usual down", () => {
  const main = ["m1", "m2", "m3", "m4", "m5"].map((id, i) => reel("j", id, 200_000, 3 + i));
  const trials = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id, i) => reel("j", id, 2_000, 3 + i));
  const fresh = ["f1", "f2", "f3"].map((id) => reel("j", id, 500, 0.2));
  const trends = findTrends([...main, ...trials, ...fresh, reel("j", "hit", 400_000, 1)], NOW);
  assertEquals(trends.find((t) => t.media_id === "hit")?.multiple, 2);
});

Deno.test("median handles odd, even and empty lists", () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assertEquals(median([]), null);
});

Deno.test("Meta's timestamps become ISO dates", () => {
  const rows = toRows("x", { media: { data: [{ id: "1", timestamp: "2026-11-07T20:09:27+0000", view_count: 5 }] } }, new Date(NOW));
  assertEquals(rows[0].posted_at, "2026-11-07T20:09:27.000Z");
  assertEquals(rows[0].views, 5);
});

Deno.test("rate limits and a dead token stop the scan; a personal account only skips itself", () => {
  assertEquals(describeError(4, undefined, "limit").stop, true);
  assertEquals(describeError(190, undefined, "bad").stop, true);
  assertEquals(describeError(110, 2207013, "cannot be found").stop, false);
});
