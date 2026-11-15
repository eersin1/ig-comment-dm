import { assertEquals } from "jsr:@std/assert@1";
import { cadenceMs, isDue, parseInsights } from "./logic.ts";

const H = 3_600_000;
const now = Date.parse("2026-11-06T12:00:00Z");
const ago = (hours: number) => new Date(now - hours * H).toISOString();

Deno.test("cadence tightens early and stops at 30 days", () => {
  assertEquals(cadenceMs(1), H);
  assertEquals(cadenceMs(50), 6 * H);
  assertEquals(cadenceMs(200), 24 * H);
  assertEquals(cadenceMs(24 * 31), null);
});

Deno.test("a new reel is due straight away", () => {
  assertEquals(isDue(ago(0.2), null, now), true);
});

Deno.test("hourly reel is due after ~an hour, with cron jitter tolerated", () => {
  assertEquals(isDue(ago(10), ago(0.5), now), false);
  assertEquals(isDue(ago(10), ago(0.95), now), true);
});

Deno.test("3-day-old reel waits 6 hours", () => {
  assertEquals(isDue(ago(72), ago(3), now), false);
  assertEquals(isDue(ago(72), ago(6), now), true);
});

Deno.test("reels past 30 days are never due", () => {
  assertEquals(isDue(ago(24 * 40), null, now), false);
});

Deno.test("parses both value shapes and skips non-numbers", () => {
  assertEquals(
    parseInsights({
      data: [
        { name: "reach", values: [{ value: 900 }] },
        { name: "reels_skip_rate", total_value: { value: 41.5 } },
        { name: "odd", values: [{ value: { nested: 1 } }] },
      ],
    }),
    { reach: 900, reels_skip_rate: 41.5 },
  );
});
