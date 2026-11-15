import { classify, type Comment, type FailureKind } from "./logic.ts";

const MAX_PAGES = 20;
const TIMEOUT_MS = 20_000;

export class InstagramError extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
  }
}

export type CommentPage = { comments: Comment[]; hitPageCap: boolean; usedFallback: boolean };

export type Instagram = {
  listComments(mediaId: string): Promise<CommentPage>;
  sendPrivateReply(commentId: string, text: string): Promise<void>;
  postPublicReply(commentId: string, text: string): Promise<void>;
  // Highest share of Meta's rate limit used so far this run, as a percentage.
  peakUsage(): number;
};

function usagePercent(header: string | null): number {
  if (!header) return 0;
  try {
    const entries = Object.values(JSON.parse(header)).flat() as Record<string, number>[];
    return Math.max(
      0,
      ...entries.flatMap((entry) => [entry.call_count ?? 0, entry.total_cputime ?? 0, entry.total_time ?? 0]),
    );
  } catch {
    return 0;
  }
}

export function createInstagram(token: string, igUserId: string, version: string): Instagram {
  const base = `https://graph.facebook.com/${version}`;
  let peak = 0;

  // The token goes in a header so it can't end up in URLs, logs or paging links.
  async function request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new InstagramError("network", `Request failed: ${(cause as Error).name}`);
    }
    peak = Math.max(peak, usagePercent(response.headers.get("x-business-use-case-usage")));
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const { code, error_subcode: subcode, message } = body.error ?? {};
      throw new InstagramError(
        classify(response.status, code, message),
        `HTTP ${response.status} code=${code} subcode=${subcode}: ${message ?? "no message"}`,
      );
    }
    return body;
  }

  async function walk(mediaId: string, edge: string) {
    const comments: Comment[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ fields: "id,text,timestamp,username", limit: "50" });
      if (after) query.set("after", after);
      const body = await request(`/${mediaId}/${edge}?${query}`);
      comments.push(...(body.data ?? []));
      // Pages can come back short or empty with more to follow, so only paging.next ends the walk.
      if (!body.paging?.next) return { comments, hitPageCap: false };
      after = body.paging.cursors?.after;
      if (!after) return { comments, hitPageCap: false };
    }
    return { comments, hitPageCap: true };
  }

  const postJson = (path: string, payload: unknown) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  return {
    // Each list silently leaves out comments the other has: /comments once showed 0 of 22 on a post,
    // and /ordered_comments later missed every keyword comment from one morning. So both are read and
    // merged. Meta documents ordered_comments for Facebook Login only, so if it goes away this
    // carries on with /comments and reports it, rather than stopping.
    async listComments(mediaId) {
      let ordered: Awaited<ReturnType<typeof walk>>;
      try {
        ordered = await walk(mediaId, "ordered_comments");
      } catch (error) {
        if (!(error instanceof InstagramError) || error.kind !== "other") throw error;
        console.error(`ordered_comments failed, using comments: ${error.message}`);
        return { ...await walk(mediaId, "comments"), usedFallback: true };
      }
      let plain: Awaited<ReturnType<typeof walk>>;
      try {
        plain = await walk(mediaId, "comments");
      } catch (error) {
        if (!(error instanceof InstagramError) || error.kind !== "other") throw error;
        console.error(`comments failed, using ordered_comments only: ${error.message}`);
        return { ...ordered, usedFallback: false };
      }
      const seen = new Set(ordered.comments.map((comment) => comment.id));
      return {
        comments: [...ordered.comments, ...plain.comments.filter((comment) => !seen.has(comment.id))],
        hitPageCap: ordered.hitPageCap || plain.hitPageCap,
        usedFallback: false,
      };
    },

    async sendPrivateReply(commentId, text) {
      await postJson(`/${igUserId}/messages`, {
        recipient: { comment_id: commentId },
        message: { text },
      });
    },

    async postPublicReply(commentId, text) {
      await postJson(`/${commentId}/replies`, { message: text });
    },

    peakUsage: () => peak,
  };
}
