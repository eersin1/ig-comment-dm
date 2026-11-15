import { type Instagram, InstagramError } from "./instagram.ts";
import { type Comment, earlierCommenters, normalize, pickRules, type Rule, shouldRetry, shouldSkip } from "./logic.ts";

export type ExistingEvent = { comment_id: string; status: string; retryable: boolean };

export type Store = {
  loadRules(): Promise<Rule[]>;
  existingEvents(commentIds: string[]): Promise<ExistingEvent[]>;
  // Both return the attempt number if this run won the comment, or null if another run did.
  claim(comment: Comment, ruleId: number): Promise<number | null>;
  reclaim(commentId: string): Promise<number | null>;
  markSent(commentId: string): Promise<void>;
  markFailed(commentId: string, retryable: boolean, error: string): Promise<void>;
  markPublicReplyError(commentId: string, error: string): Promise<void>;
};

export type Summary = {
  rules: number;
  rules_checked: number;
  read: number;
  sent: number;
  failed: number;
  page_cap_hit: string[];
  fallback_used: string[];
  read_errors: string[];
  peak_usage_percent: number;
  stopped: "token_rejected" | "rate_limited" | null;
};

export type Deps = {
  store: Store;
  instagram: Instagram;
  alert: (message: string) => Promise<void>;
  ownUsername: string;
  now: number;
};

export async function run(deps: Deps): Promise<Summary> {
  const summary = await poll(deps);
  summary.peak_usage_percent = deps.instagram.peakUsage();
  return summary;
}

async function poll({ store, instagram, alert, ownUsername, now }: Deps): Promise<Summary> {
  const allRules = await store.loadRules();
  const rules = pickRules(allRules, now);
  const summary: Summary = {
    rules: allRules.length,
    rules_checked: rules.length,
    read: 0,
    sent: 0,
    failed: 0,
    page_cap_hit: [],
    fallback_used: [],
    read_errors: [],
    peak_usage_percent: 0,
    stopped: null,
  };

  const stop = async (kind: "token" | "rate_limit", detail: string) => {
    if (kind === "token") {
      summary.stopped = "token_rejected";
      await alert(`Meta rejected the Instagram token or blocked API access, so comment DMs have stopped. ${detail}`);
    } else {
      summary.stopped = "rate_limited";
      console.warn(`Rate limited, stopping until the next run. ${detail}`);
    }
  };

  for (const rule of rules) {
    let comments: Comment[];
    try {
      const page = await instagram.listComments(rule.media_id);
      comments = page.comments;
      if (page.hitPageCap) summary.page_cap_hit.push(rule.media_id);
      if (page.usedFallback) summary.fallback_used.push(rule.media_id);
    } catch (error) {
      if (!(error instanceof InstagramError)) throw error;
      if (error.kind === "token" || error.kind === "rate_limit") {
        await stop(error.kind, error.message);
        return summary;
      }
      summary.read_errors.push(`${rule.media_id}: ${error.message}`);
      continue;
    }
    summary.read += comments.length;

    const handled = earlierCommenters(comments, rule);
    const candidates = comments
      .filter((comment) => !shouldSkip(comment, rule, ownUsername, now))
      .filter((comment) => !handled.has(normalize(comment.username ?? "")));
    if (candidates.length === 0) continue;
    const existing = new Map(
      (await store.existingEvents(candidates.map((comment) => comment.id)))
        .map((event) => [event.comment_id, event]),
    );

    for (const comment of candidates) {
      const event = existing.get(comment.id);
      let attempt: number | null = null;
      if (!event) attempt = await store.claim(comment, rule.id);
      else if (event.status === "failed" && event.retryable) attempt = await store.reclaim(comment.id);
      if (attempt === null) continue;

      try {
        await instagram.sendPrivateReply(comment.id, rule.dm_text);
      } catch (error) {
        if (!(error instanceof InstagramError)) throw error;
        await store.markFailed(comment.id, shouldRetry(error.kind, attempt), error.message);
        summary.failed++;
        if (error.kind === "token" || error.kind === "rate_limit") {
          await stop(error.kind, error.message);
          return summary;
        }
        continue;
      }
      await store.markSent(comment.id);
      summary.sent++;

      if (rule.public_reply) {
        try {
          await instagram.postPublicReply(comment.id, rule.public_reply);
        } catch (error) {
          await store.markPublicReplyError(comment.id, (error as Error).message);
        }
      }
    }
  }
  return summary;
}
