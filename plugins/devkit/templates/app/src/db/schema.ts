import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// サンプルテーブル。実際のアプリでは置き換えて `pnpm db:generate` でマイグレーションを作り直す。
export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

// 監査ログ（src/server/audit.ts）。誰が・いつ・何をしたか・拒否されたかを残す。消さずに残す（アプリから更新・削除しない）。
// detail には ID などの識別子だけを入れ、入力値そのものや個人情報は入れない。
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // 利用者 ID。ログインしていなければ "anonymous"
    actorId: text("actor_id").notNull(),
    // 権限名（例: todos.create）
    action: text("action").notNull(),
    outcome: text("outcome", { enum: ["success", "denied"] }).notNull(),
    // 対象のレコードの ID など
    target: text("target"),
    requestId: text("request_id"),
    // 拒否の記録だけに入る、まとめる時間枠の開始時刻。同じ (actor_id, action, window_start) は1行にまとめて attempts を数える
    // （成功の記録は NULL なので、この一意制約の対象にならない）
    windowStart: timestamp("window_start", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("audit_logs_denied_window_key").on(t.actorId, t.action, t.windowStart),
    index("audit_logs_created_at_idx").on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
