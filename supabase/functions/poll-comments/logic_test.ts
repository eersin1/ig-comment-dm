import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  classify,
  type Comment,
  earlierCommenters,
  matchesKeyword,
  MAX_RULES_PER_RUN,
  pickRules,
  type Rule,
  secretsMatch,
  shouldRetry,
  shouldSkip,
} from "./logic.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");

const rule: Rule = {
  id: 1,
  media_id: "m1",
  keyword: "guide",
  dm_text: "Here you go",
  public_reply: "Sent!",
  active_from: "2026-11-01T00:00:00Z",
};

const comment = (overrides: Partial<Comment> = {}): Comment => ({
  id: "c1",
  text: "guide",
  timestamp: "2026-11-03T10:00:00+0000",
  username: "someone",
  ...overrides,
});

Deno.test("matching accepts the spec's examples", () => {
  for (const text of ["GUIDE", "guide!", "Guide please", "Guide please!", "GUİDE", "guıde", "send the “guide”"]) {
    assert(matchesKeyword(text, "guide"), text);
  }
});

Deno.test("matching rejects partial words", () => {
  for (const text of ["guidelines", "misguide", "guide2", "", "gui de"]) {
    assert(!matchesKeyword(text, "guide"), text);
  }
});

Deno.test("Turkish casing works in the keyword as well as the comment", () => {
  assert(matchesKeyword("guide", "GUİDE"));
  assert(matchesKeyword("LIGHT", "light"));
  assert(matchesKeyword("lıght", "Light"));
});

Deno.test("hyphenated keywords match common spellings", () => {
  for (const text of ["X-RAY", "x-ray please", "xray", "x ray", "x–ray", "“X-RAY”"]) {
    assert(matchesKeyword(text, "X-RAY"), text);
  }
  assert(!matchesKeyword("xrays", "X-RAY"));
});

Deno.test("a keyword without a hyphen matches comments with one", () => {
  for (const text of ["X-RAY", "x-ray", "XRAY", "xray", "Xray please", "x\u2013ray"]) {
    assert(matchesKeyword(text, "XRAY"), text);
  }
  assert(matchesKeyword("guide-please", "guide"));
  assert(!matchesKeyword("x-rays", "xray"));
});

Deno.test("every casing of a keyword matches", () => {
  for (const text of ["CASES", "cases", "Cases", "cAsEs", "cases!", "cases please"]) {
    assert(matchesKeyword(text, "CASES"), text);
  }
});

Deno.test("accents don't change a match", () => {
  assert(matchesKeyword("IŞIK", "isik"));
  assert(matchesKeyword("isik", "ışık"));
  assert(matchesKeyword("PREÇO", "preco"));
  assert(matchesKeyword("क्लोड", "क्लोड"));
});

Deno.test("regex characters in a keyword are treated literally", () => {
  assert(matchesKeyword("c++ now", "c++"));
  assert(!matchesKeyword("guide", "gu.de"));
  assert(!matchesKeyword("guide", "   "));
});

Deno.test("a fresh matching comment isn't skipped", () => {
  assert(!shouldSkip(comment(), rule, "my.account", NOW));
});

Deno.test("filtering skips comments from before active_from", () => {
  assert(shouldSkip(comment({ timestamp: "2026-10-31T23:59:59+0000" }), rule, "my.account", NOW));
});

Deno.test("filtering skips comments older than 7 days", () => {
  const oldRule = { ...rule, active_from: "2026-01-01T00:00:00Z" };
  assert(shouldSkip(comment({ timestamp: "2026-10-27T11:59:59+0000" }), oldRule, "my.account", NOW));
  assert(!shouldSkip(comment({ timestamp: "2026-10-27T12:00:01+0000" }), oldRule, "my.account", NOW));
});

Deno.test("filtering skips the account's own comments in any casing", () => {
  assert(shouldSkip(comment({ username: "my.account" }), rule, "my.account", NOW));
  assert(shouldSkip(comment({ username: "My.Account" }), rule, "my.account", NOW));
});

Deno.test("filtering skips non-matching and malformed comments", () => {
  assert(shouldSkip(comment({ text: "nice video" }), rule, "my.account", NOW));
  assert(shouldSkip(comment({ text: undefined }), rule, "my.account", NOW));
  assert(shouldSkip(comment({ timestamp: "not a date" }), rule, "my.account", NOW));
});

Deno.test("classify separates the failure kinds", () => {
  assertEquals(classify(400, 190), "token");
  assertEquals(classify(400, 4), "rate_limit");
  assertEquals(classify(429), "rate_limit");
  assertEquals(classify(400, 80002), "rate_limit");
  assertEquals(classify(500, 2), "server");
  assertEquals(classify(400, 100), "other");
  assertEquals(classify(null), "network");
  assertEquals(classify(400, 200, "API access blocked."), "token");
  assertEquals(classify(400, 200, "Permissions error"), "other");
});

Deno.test("rate limits retry up to 3 attempts", () => {
  assert(shouldRetry("rate_limit", 1));
  assert(shouldRetry("rate_limit", 2));
  assert(!shouldRetry("rate_limit", 3));
});

Deno.test("sends with unknown or permanent outcomes never retry", () => {
  assert(!shouldRetry("server", 1));
  assert(!shouldRetry("network", 1));
  assert(!shouldRetry("other", 1));
});

Deno.test("the cron secret must match exactly", async () => {
  assert(await secretsMatch("abc", "abc"));
  assert(!await secretsMatch("abd", "abc"));
  assert(!await secretsMatch(null, "abc"));
  assert(!await secretsMatch("abc", undefined));
  assert(!await secretsMatch("", ""));
});

Deno.test("people who commented the keyword before the rule are remembered", () => {
  const before = "2026-10-31T10:00:00+0000";
  const found = earlierCommenters([
    comment({ username: "Handled", text: "GUIDE", timestamp: before }),
    comment({ username: "chatty", text: "nice video", timestamp: before }),
    comment({ username: "fresh", text: "guide" }),
    comment({ username: undefined, text: "guide", timestamp: before }),
  ], rule);
  assertEquals([...found], ["handled"]);
});

Deno.test("up to 3 rules all run every time", () => {
  const rules = [1, 2, 3].map((id) => ({ ...rule, id }));
  assertEquals(pickRules(rules, NOW).map((r) => r.id), [3, 2, 1]);
});

Deno.test("between the 2-minute marks, only the newest reel is checked", () => {
  const rules = [1, 2, 3].map((id) => ({ ...rule, id }));
  for (const offset of [30_000, 60_000, 90_000]) {
    assertEquals(pickRules(rules, NOW + offset).map((r) => r.id), [3]);
  }
  assertEquals(pickRules(rules, NOW + 120_000).map((r) => r.id), [3, 2, 1]);
  assertEquals(pickRules([], NOW), []);
});

Deno.test("with many rules, the newest always runs and the rest take turns", () => {
  const rules = Array.from({ length: 10 }, (_, i) => ({ ...rule, id: i + 1 }));
  const seen = new Set<number>();
  for (let run = 0; run < 5; run++) {
    const picked = pickRules(rules, NOW + run * 120_000);
    assertEquals(picked.length, MAX_RULES_PER_RUN);
    assertEquals(picked[0].id, 10);
    assertEquals(new Set(picked.map((r) => r.id)).size, MAX_RULES_PER_RUN);
    picked.forEach((r) => seen.add(r.id));
  }
  assertEquals(seen.size, 10);
});
