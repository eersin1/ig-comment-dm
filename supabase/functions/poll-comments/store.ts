import { createClient } from "npm:@supabase/supabase-js@2";
import type { Comment, Rule } from "./logic.ts";
import type { ExistingEvent, Store } from "./run.ts";

const ALERT_INTERVAL_MS = 86_400_000;

export function createStore(url: string, serviceRoleKey: string) {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  function check<T>(result: { data: T; error: { message: string } | null }): T {
    if (result.error) throw new Error(`Database error: ${result.error.message}`);
    return result.data;
  }

  const update = async (commentId: string, fields: Record<string, unknown>) => {
    check(
      await db.from("events")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("comment_id", commentId),
    );
  };

  const store: Store = {
    async loadRules() {
      return check(await db.from("rules").select("*").eq("enabled", true)) as Rule[];
    },

    async existingEvents(commentIds) {
      return check(
        await db.from("events").select("comment_id,status,retryable").in("comment_id", commentIds),
      ) as ExistingEvent[];
    },

    async claim(comment: Comment, ruleId) {
      const rows = check(
        await db.from("events")
          .upsert({
            comment_id: comment.id,
            rule_id: ruleId,
            username: comment.username ?? null,
            comment_text: comment.text ?? null,
          }, { onConflict: "comment_id", ignoreDuplicates: true })
          .select("attempts"),
      ) as { attempts: number }[];
      return rows[0]?.attempts ?? null;
    },

    // Compare-and-set on status and attempts, so two overlapping runs can't both retry.
    async reclaim(commentId) {
      const rows = check(
        await db.from("events").select("attempts")
          .eq("comment_id", commentId).eq("status", "failed").eq("retryable", true),
      ) as { attempts: number }[];
      if (!rows[0]) return null;
      const attempts = rows[0].attempts + 1;
      const won = check(
        await db.from("events")
          .update({ status: "sending", retryable: false, attempts, updated_at: new Date().toISOString() })
          .eq("comment_id", commentId).eq("status", "failed").eq("retryable", true)
          .eq("attempts", rows[0].attempts)
          .select("attempts"),
      ) as { attempts: number }[];
      return won[0]?.attempts ?? null;
    },

    markSent: (commentId) => update(commentId, { status: "sent", retryable: false, error: null }),
    markFailed: (commentId, retryable, error) => update(commentId, { status: "failed", retryable, error }),
    markPublicReplyError: (commentId, error) => update(commentId, { public_reply_error: error }),
  };

  // True for at most one caller a day, so an outage sends one email rather than hundreds.
  async function claimAlertSlot(now: number): Promise<boolean> {
    const cutoff = new Date(now - ALERT_INTERVAL_MS).toISOString();
    const rows = check(
      await db.from("settings")
        .update({ last_alert_at: new Date(now).toISOString() })
        .eq("id", 1)
        .or(`last_alert_at.is.null,last_alert_at.lt.${cutoff}`)
        .select("id"),
    ) as { id: number }[];
    return rows.length > 0;
  }

  return { store, claimAlertSlot };
}
