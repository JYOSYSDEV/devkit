import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditLogs } from "@/db/schema";

// 監査ログ。データの更新（登録・更新・削除・権限の変更）と、権限のない操作の試みを残す。
// 書くのは defineAction（src/server/action.ts）で、画面や個別の処理からは呼ばない。
// detail には ID などの識別子だけを入れ、入力値そのものや個人情報は入れない。

export const ANONYMOUS_ACTOR = "anonymous";

// 拒否の記録をまとめる時間枠（秒）。同じ利用者（未ログインはまとめて anonymous）・同じ権限の拒否は、
// この枠の中では1行にまとめ、attempts を数える（未ログインの連続した呼び出しで表が埋まらないように）。
export const DENIED_AUDIT_WINDOW_SECONDS = 60;

export type AuditDetail = Record<string, string | number | boolean | null>;

// 拒否の理由（detail.reason に入る。時間枠でまとめた行は最初の理由を残す）
export type DeniedReason = "login_required" | "forbidden" | "invalid_request";

// 成功した操作の記録。処理と同じトランザクション（tx）で書き、処理が失敗したら一緒に取り消す。
export async function writeAudit(
  db: Db,
  entry: { actorId: string; action: string; target?: string | null; requestId?: string; detail?: AuditDetail },
): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId,
    action: entry.action,
    outcome: "success",
    target: entry.target ?? null,
    requestId: entry.requestId ?? null,
    detail: entry.detail ?? {},
  });
}

export function deniedWindowStart(now: Date, windowSeconds = DENIED_AUDIT_WINDOW_SECONDS): Date {
  const size = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

// 権限のない操作の試み（未ログインを含む）の記録。時間枠ごとに1行にまとめる（一意制約 audit_logs_denied_window_key）。
// 同時に呼ばれても行は増えない（ON CONFLICT で attempts を足す）。最初の試みの request_id を残す。
export async function writeDeniedAudit(
  db: Db,
  entry: { actorId: string; action: string; reason?: DeniedReason; requestId?: string; now?: Date },
): Promise<void> {
  const now = entry.now ?? new Date();
  await db
    .insert(auditLogs)
    .values({
      actorId: entry.actorId,
      action: entry.action,
      outcome: "denied",
      requestId: entry.requestId ?? null,
      windowStart: deniedWindowStart(now),
      attempts: 1,
      createdAt: now,
      lastAttemptAt: now,
      detail: entry.reason ? { reason: entry.reason } : {},
    })
    .onConflictDoUpdate({
      target: [auditLogs.actorId, auditLogs.action, auditLogs.windowStart],
      set: { attempts: sql`${auditLogs.attempts} + 1`, lastAttemptAt: now },
    });
}
