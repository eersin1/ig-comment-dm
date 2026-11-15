import { assertEquals } from "jsr:@std/assert@1";
import { type Instagram, InstagramError } from "./instagram.ts";
import { type Comment, type FailureKind, type Rule } from "./logic.ts";
import { run, type Store } from "./run.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
type Row = { status: string; retryable: boolean; attempts: number; error?: string; public_reply_error?: string };

const rule: Rule = {
  id: 1,
  media_id: "m1",
  keyword: "guide",
  dm_text: "Here you go",
  public_reply: "Sent!",
  active_from: "2026-11-01T00:00:00Z",
};

const guide = (id: string, username = "someone"): Comment => ({
  id,
  text: "guide",
  timestamp: "2026-11-03T10:00:00+0000",
  username,
});

function harness(comments: Comment[], rules: Rule[] = [rule]) {
  const rows = new Map<string, Row>();
  const dms: string[] = [];
  const replies: string[] = [];
  const alerts: string[] = [];
  const failDm: FailureKind[] = [];
  let failRead: FailureKind | null = null;
  let failReply = false;

  const store: Store = {
    loadRules: () => Promise.resolve(rules),
    existingEvents: (ids) =>
      Promise.resolve(
        ids.filter((id) => rows.has(id)).map((id) => ({
          comment_id: id,
          status: rows.get(id)!.status,
          retryable: rows.get(id)!.retryable,
        })),
      ),
    claim: (comment) => {
      if (rows.has(comment.id)) return Promise.resolve(null);
      rows.set(comment.id, { status: "sending", retryable: false, attempts: 1 });
      return Promise.resolve(1);
    },
    reclaim: (id) => {
      const row = rows.get(id)!;
      if (row.status !== "failed" || !row.retryable) return Promise.resolve(null);
      Object.assign(row, { status: "sending", retryable: false, attempts: row.attempts + 1 });
      return Promise.resolve(row.attempts);
    },
    markSent: (id) => {
      Object.assign(rows.get(id)!, { status: "sent", retryable: false });
      return Promise.resolve();
    },
    markFailed: (id, retryable, error) => {
      Object.assign(rows.get(id)!, { status: "failed", retryable, error });
      return Promise.resolve();
    },
    markPublicReplyError: (id, error) => {
      rows.get(id)!.public_reply_error = error;
      return Promise.resolve();
    },
  };

  const instagram: Instagram = {
    listComments: () => {
      if (failRead) return Promise.reject(new InstagramError(failRead, "read failed"));
      return Promise.resolve({ comments, hitPageCap: false, usedFallback: false });
    },
    sendPrivateReply: (id) => {
      const kind = failDm.shift();
      if (kind) return Promise.reject(new InstagramError(kind, `dm ${kind}`));
      dms.push(id);
      return Promise.resolve();
    },
    postPublicReply: (id) => {
      if (failReply) return Promise.reject(new InstagramError("other", "reply failed"));
      replies.push(id);
      return Promise.resolve();
    },
    peakUsage: () => 12,
  };

  const go = () =>
    run({
      store,
      instagram,
      alert: (message) => {
        alerts.push(message);
        return Promise.resolve();
      },
      ownUsername: "my.account",
      now: NOW,
    });

  return {
    go,
    rows,
    dms,
    replies,
    alerts,
    failDm,
    setFailRead: (kind: FailureKind | null) => (failRead = kind),
    setFailReply: (value: boolean) => (failReply = value),
  };
}

Deno.test("a keyword comment gets one DM and one public reply", async () => {
  const h = harness([guide("c1")]);
  const summary = await h.go();
  assertEquals(h.dms, ["c1"]);
  assertEquals(h.replies, ["c1"]);
  assertEquals(h.rows.get("c1")?.status, "sent");
  assertEquals(summary.sent, 1);
});

Deno.test("running twice sends no second DM", async () => {
  const h = harness([guide("c1")]);
  await h.go();
  await h.go();
  assertEquals(h.dms, ["c1"]);
  assertEquals(h.replies, ["c1"]);
});

Deno.test("two comments from one person get one DM each", async () => {
  const h = harness([guide("c1"), guide("c2")]);
  await h.go();
  assertEquals(h.dms, ["c1", "c2"]);
});

Deno.test("own and non-keyword comments get nothing and leave no row", async () => {
  const h = harness([guide("c1", "my.account"), { ...guide("c2"), text: "nice" }]);
  await h.go();
  assertEquals(h.dms, []);
  assertEquals(h.rows.size, 0);
});

Deno.test("two rules on a video send only one DM for a comment", async () => {
  const h = harness([guide("c1")], [rule, { ...rule, id: 2 }]);
  await h.go();
  assertEquals(h.dms, ["c1"]);
});

Deno.test("a row left in sending is never retried", async () => {
  const h = harness([guide("c1")]);
  h.rows.set("c1", { status: "sending", retryable: false, attempts: 1 });
  await h.go();
  assertEquals(h.dms, []);
});

Deno.test("a rate-limited DM stops the run and succeeds on a later one", async () => {
  const h = harness([guide("c1"), guide("c2")]);
  h.failDm.push("rate_limit");
  const first = await h.go();
  assertEquals(first.stopped, "rate_limited");
  assertEquals(h.rows.get("c1"), { status: "failed", retryable: true, attempts: 1, error: "dm rate_limit" });
  assertEquals(h.rows.has("c2"), false);
  await h.go();
  assertEquals(h.dms, ["c1", "c2"]);
  assertEquals(h.rows.get("c1")?.attempts, 2);
});

Deno.test("rate-limited DMs give up after 3 attempts", async () => {
  const h = harness([guide("c1")]);
  h.failDm.push("rate_limit", "rate_limit", "rate_limit", "rate_limit");
  await h.go();
  await h.go();
  await h.go();
  await h.go();
  assertEquals(h.rows.get("c1")?.attempts, 3);
  assertEquals(h.rows.get("c1")?.retryable, false);
  assertEquals(h.dms, []);
  assertEquals(h.failDm.length, 1);
});

Deno.test("other DM failures aren't retried and the run continues", async () => {
  for (const kind of ["other", "server", "network"] as const) {
    const h = harness([guide("c1"), guide("c2")]);
    h.failDm.push(kind);
    await h.go();
    await h.go();
    assertEquals(h.rows.get("c1")?.status, "failed");
    assertEquals(h.rows.get("c1")?.attempts, 1);
    assertEquals(h.dms, ["c2"]);
  }
});

Deno.test("a failed public reply is logged and the DM still counts as sent", async () => {
  const h = harness([guide("c1")]);
  h.setFailReply(true);
  await h.go();
  assertEquals(h.rows.get("c1")?.status, "sent");
  assertEquals(h.rows.get("c1")?.public_reply_error, "reply failed");
});

Deno.test("a rejected token while reading stops the run and alerts", async () => {
  const h = harness([guide("c1")]);
  h.setFailRead("token");
  const summary = await h.go();
  assertEquals(summary.stopped, "token_rejected");
  assertEquals(h.alerts.length, 1);
  assertEquals(h.dms, []);
});

Deno.test("a rejected token while sending alerts and the DM retries after the fix", async () => {
  const h = harness([guide("c1")]);
  h.failDm.push("token");
  const summary = await h.go();
  assertEquals(summary.stopped, "token_rejected");
  assertEquals(h.alerts.length, 1);
  await h.go();
  assertEquals(h.dms, ["c1"]);
});

Deno.test("a read error on one video doesn't alert", async () => {
  const h = harness([guide("c1")]);
  h.setFailRead("other");
  const summary = await h.go();
  assertEquals(summary.read_errors, ["m1: read failed"]);
  assertEquals(h.alerts, []);
});

Deno.test("the summary reports Meta's rate limit usage", async () => {
  const summary = await harness([]).go();
  assertEquals(summary.peak_usage_percent, 12);
});

Deno.test("someone who commented before the rule gets nothing, while new people do", async () => {
  const earlier = { ...guide("old1", "handled"), timestamp: "2026-10-20T10:00:00+0000" };
  const h = harness([earlier, guide("new1", "handled"), guide("new2", "newcomer")]);
  await h.go();
  assertEquals(h.dms, ["new2"]);
  assertEquals(h.rows.has("old1"), false);
  assertEquals(h.rows.has("new1"), false);
});

Deno.test("many rules still check only 3 videos a run", async () => {
  const rules = Array.from({ length: 10 }, (_, i) => ({ ...rule, id: i + 1, media_id: `m${i + 1}` }));
  const summary = await harness([], rules).go();
  assertEquals(summary.rules, 10);
  assertEquals(summary.rules_checked, 3);
});
