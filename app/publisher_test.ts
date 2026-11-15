import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createMeta, videoBitrate } from "./clients.ts";
import { type Hosting, type Meta, MetaError, newJob, type PublishInput, type Rules, runPublish, validateKeywordPair, validatePublish } from "./publisher.ts";

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  video: new Uint8Array(4),
  caption: "Comment GUIDE",
  rule: { keyword: "GUIDE", dm_text: "Here's the code", public_reply: null },
  ...overrides,
});

function harness(overrides: Partial<Meta> = {}, ruleError = false) {
  const calls: string[] = [];
  const added: Record<string, unknown>[] = [];
  const meta: Meta = {
    account: () => Promise.resolve({ id: "ig", username: "me" }),
    posts: () => Promise.resolve([]),
    createContainer: () => {
      calls.push("create");
      return Promise.resolve({ id: "c1" });
    },
    containerStatus: () => {
      calls.push("status");
      return Promise.resolve({ code: "FINISHED", message: "" });
    },
    publish: () => {
      calls.push("publish");
      return Promise.resolve("m1");
    },
    permalink: () => Promise.resolve("https://instagram.com/reel/x"),
    sharedToFeed: () => Promise.resolve(false),
    ...overrides,
  };
  const rules: Rules = {
    list: () => Promise.resolve([]),
    add: (rule) => {
      if (ruleError) return Promise.reject(new Error("db down"));
      added.push(rule);
      return Promise.resolve({ id: 1, enabled: true, ...rule });
    },
    setEnabled: () => Promise.resolve(),
  };
  const removed: string[] = [];
  const hosting: Hosting = {
    put: () => Promise.resolve({ url: "https://host/v.mp4", name: "v.mp4" }),
    remove: (name) => {
      removed.push(name);
      return Promise.resolve();
    },
  };
  return { meta, rules, hosting, calls, added, removed };
}

const options = { sleep: () => Promise.resolve(), now: () => new Date("2026-11-03T12:00:00Z") };
const states = (job: ReturnType<typeof newJob>) => job.steps.map((step) => step.state);

Deno.test("posts the reel, then turns on its keyword from before it went live", async () => {
  const h = harness();
  const job = newJob("j", true, false);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "done");
  assertEquals(h.calls, ["create", "status", "publish"]);
  assertEquals(job.mediaId, "m1");
  assertEquals(h.added[0].media_id, "m1");
  assertEquals(h.added[0].active_from, "2026-11-03T12:00:00.000Z");
  assertEquals(states(job), ["done", "done", "done", "done"]);
});

Deno.test("a post without a keyword skips that step", async () => {
  const h = harness();
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "done");
  assertEquals(h.added, []);
  assertEquals(states(job), ["done", "done", "done", "skipped"]);
});

Deno.test("waits for processing before posting", async () => {
  const codes = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  const h = harness({ containerStatus: () => Promise.resolve({ code: codes.shift()!, message: "" }) });
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, options);
  assertEquals(codes.length, 0);
  assertEquals(job.status, "done");
});

Deno.test("a video Instagram can't process is never posted", async () => {
  const h = harness({ containerStatus: () => Promise.resolve({ code: "ERROR", message: "Bad codec" }) });
  const job = newJob("j", true, false);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "failed");
  assertEquals(job.publishAttempted, false);
  assertEquals(h.calls.includes("publish"), false);
  assertStringIncludes(job.error!, "nothing was posted");
  assertStringIncludes(job.error!, "Bad codec");
});

Deno.test("stops waiting if processing never finishes", async () => {
  const h = harness({ containerStatus: () => Promise.resolve({ code: "IN_PROGRESS", message: "" }) });
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, { ...options, maxPolls: 3 });
  assertEquals(job.status, "failed");
  assertEquals(h.calls.includes("publish"), false);
});

Deno.test("an unconfirmed publish warns against posting twice and isn't retried", async () => {
  let publishes = 0;
  const h = harness({
    publish: () => {
      publishes++;
      return Promise.reject(new MetaError("timeout"));
    },
  });
  const job = newJob("j", true, false);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, options);
  assertEquals(publishes, 1);
  assertEquals(job.publishAttempted, true);
  assertStringIncludes(job.error!, "before trying again");
  assertEquals(h.added, []);
});

Deno.test("a keyword failure says the reel is live", async () => {
  const h = harness({}, true);
  const job = newJob("j", true, false);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "failed");
  assertEquals(job.mediaId, "m1");
  assertStringIncludes(job.error!, "The reel is live");
});

Deno.test("a dry run uploads but never posts or adds a keyword", async () => {
  const h = harness();
  const job = newJob("j", true, true);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, { ...options, dryRun: true });
  assertEquals(job.status, "done");
  assertEquals(h.calls.includes("publish"), false);
  assertEquals(job.publishAttempted, false);
  assertEquals(h.added, []);
});

Deno.test("validation needs a keyword and a DM together", () => {
  assertEquals(validateKeywordPair("", ""), null);
  assertEquals(validateKeywordPair("guide", "Here you go"), null);
  assertEquals(validateKeywordPair("guide", " "), "Write the DM this keyword should send.");
  assertEquals(validateKeywordPair("", "Here you go"), "Add the keyword that should send this DM.");
  assertStringIncludes(validateKeywordPair("guide", "x".repeat(1001))!, "1,000");
});

Deno.test("validation rejects long captions", () => {
  assertEquals(validatePublish({ caption: "hi" }), null);
  assertStringIncludes(validatePublish({ caption: "x".repeat(2201) })!, "2,200");
});

Deno.test("a reel Meta reports as not on Feed counts as a trial", async () => {
  const h = harness();
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, options);
  assertEquals(job.postedAsNormal, false);
});

Deno.test("a reel Meta reports as on Feed is flagged as normal, and keeps its keyword", async () => {
  const h = harness({ sharedToFeed: () => Promise.resolve(true) });
  const job = newJob("j", true, false);
  await runPublish(job, input(), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "done");
  assertEquals(job.postedAsNormal, true);
  assertEquals(h.added.length, 1);
});

Deno.test("a failed Feed check doesn't fail the post or claim a result", async () => {
  const h = harness({ sharedToFeed: () => Promise.reject(new MetaError("down")) });
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "done");
  assertEquals(job.postedAsNormal, null);
});

Deno.test("the hosted video is removed after posting, after a failure and after a dry run", async () => {
  const posted = harness();
  await runPublish(newJob("j", false, false), input({ rule: null }), posted.meta, posted.rules, posted.hosting, options);
  assertEquals(posted.removed, ["v.mp4"]);

  const failed = harness({ containerStatus: () => Promise.resolve({ code: "ERROR", message: "bad" }) });
  await runPublish(newJob("j", false, false), input({ rule: null }), failed.meta, failed.rules, failed.hosting, options);
  assertEquals(failed.removed, ["v.mp4"]);

  const dry = harness();
  await runPublish(newJob("j", false, true), input({ rule: null }), dry.meta, dry.rules, dry.hosting, { ...options, dryRun: true });
  assertEquals(dry.removed, ["v.mp4"]);
});

Deno.test("a video that couldn't be hosted never reaches Instagram", async () => {
  const h = harness();
  h.hosting.put = () => Promise.reject(new MetaError("too big"));
  const job = newJob("j", false, false);
  await runPublish(job, input({ rule: null }), h.meta, h.rules, h.hosting, options);
  assertEquals(job.status, "failed");
  assertEquals(job.publishAttempted, false);
  assertEquals(h.calls, []);
  assertEquals(h.removed, []);
});

Deno.test("compression keeps quality up and refuses videos too long for the limit", () => {
  assertEquals(videoBitrate(10), 10_000_000);
  assertEquals(videoBitrate(45)! > 8_000_000, true);
  assertEquals(videoBitrate(90)! > 4_000_000, true);
  assertEquals(videoBitrate(180), null);
});

Deno.test("every reel is created as a manual trial reel", async () => {
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Promise.resolve(Response.json({ id: "c1", uri: "u" }));
  }) as typeof fetch;
  try {
    await createMeta("t", "v26.0").createContainer("ig", "hello", "https://host/v.mp4");
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(sent[0], {
    media_type: "REELS",
    video_url: "https://host/v.mp4",
    caption: "hello",
    trial_params: { graduation_strategy: "MANUAL" },
  });
});
