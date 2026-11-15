import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createInstagram, InstagramError } from "./instagram.ts";

const comment = (id: string) => ({ id, text: "guide", timestamp: "2026-11-03T10:00:00+0000", username: "someone" });

type Reply = { status?: number; body: unknown; usage?: string };

function stubFetch(respond: (url: URL) => Reply) {
  const calls: string[] = [];
  const auth: (string | null)[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    auth.push(new Headers(init.headers).get("Authorization"));
    const { status = 200, body, usage } = respond(url);
    const headers = usage ? { "x-business-use-case-usage": usage } : undefined;
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
  }) as typeof fetch;
  return { calls, auth, restore: () => (globalThis.fetch = original) };
}

const instagram = () => createInstagram("secret-token", "ig1", "v26.0");

Deno.test("reads both comment lists and walks short and empty pages", async () => {
  const stub = stubFetch((url) => {
    const after = url.searchParams.get("after");
    if (!after) return { body: { data: [comment("a")], paging: { next: "x", cursors: { after: "p2" } } } };
    if (after === "p2") return { body: { data: [], paging: { next: "x", cursors: { after: "p3" } } } };
    return { body: { data: [comment("b")], paging: { cursors: { after: "p4" } } } };
  });
  try {
    const page = await instagram().listComments("m1");
    assertEquals(page.comments.map((c) => c.id), ["a", "b"]);
    assertEquals(page.usedFallback, false);
    assertEquals(page.hitPageCap, false);
    assertEquals(stub.calls.filter((call) => call.includes("/m1/ordered_comments")).length, 3);
    assertEquals(stub.calls.filter((call) => call.includes("/m1/comments")).length, 3);
    assertEquals(stub.auth[0], "Bearer secret-token");
    assertEquals(stub.calls.some((call) => call.includes("secret-token")), false);
  } finally {
    stub.restore();
  }
});

Deno.test("merges comments that only one of the two lists shows", async () => {
  const stub = stubFetch((url) => {
    if (url.pathname.endsWith("/ordered_comments")) return { body: { data: [comment("a"), comment("b")] } };
    return { body: { data: [comment("b"), comment("c")] } };
  });
  try {
    const page = await instagram().listComments("m1");
    assertEquals(page.comments.map((c) => c.id), ["a", "b", "c"]);
    assertEquals(page.usedFallback, false);
  } finally {
    stub.restore();
  }
});

Deno.test("keeps ordered_comments if comments is refused", async () => {
  const stub = stubFetch((url) => {
    if (url.pathname.endsWith("/ordered_comments")) return { body: { data: [comment("a")] } };
    return { status: 400, body: { error: { code: 100, message: "Unsupported" } } };
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const page = await instagram().listComments("m1");
    assertEquals(page.comments.map((c) => c.id), ["a"]);
  } finally {
    console.error = quiet;
    stub.restore();
  }
});

Deno.test("falls back to comments if ordered_comments is refused", async () => {
  const stub = stubFetch((url) => {
    if (url.pathname.endsWith("/ordered_comments")) {
      return { status: 400, body: { error: { code: 100, message: "Unsupported" } } };
    }
    return { body: { data: [comment("a")] } };
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const page = await instagram().listComments("m1");
    assertEquals(page.comments.map((c) => c.id), ["a"]);
    assertEquals(page.usedFallback, true);
  } finally {
    console.error = quiet;
    stub.restore();
  }
});

Deno.test("a rejected token or rate limit doesn't trigger the fallback", async () => {
  for (const [code, kind] of [[190, "token"], [4, "rate_limit"]] as const) {
    const stub = stubFetch(() => ({ status: 400, body: { error: { code, message: "no" } } }));
    try {
      const error = await assertRejects(() => instagram().listComments("m1"), InstagramError);
      assertEquals(error.kind, kind);
      assertEquals(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  }
});

Deno.test("stops at the page cap and says so", async () => {
  const stub = stubFetch(() => ({ body: { data: [comment("a")], paging: { next: "x", cursors: { after: "n" } } } }));
  try {
    const page = await instagram().listComments("m1");
    assertEquals(page.hitPageCap, true);
    assertEquals(stub.calls.length, 40);
  } finally {
    stub.restore();
  }
});

Deno.test("tracks the highest rate limit usage Meta reports", async () => {
  const usage = JSON.stringify({ app: [{ type: "instagram", call_count: 7, total_cputime: 31, total_time: 2 }] });
  const stub = stubFetch(() => ({ body: { data: [] }, usage }));
  try {
    const client = instagram();
    await client.listComments("m1");
    assertEquals(client.peakUsage(), 31);
  } finally {
    stub.restore();
  }
});
