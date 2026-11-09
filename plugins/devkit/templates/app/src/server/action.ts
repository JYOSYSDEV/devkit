import { redirect } from "next/navigation";
import { ZodError, type z } from "zod";
import { type Db, getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { logger } from "@/lib/logger";
import { ANONYMOUS_ACTOR, type DeniedReason, writeAudit, writeDeniedAudit } from "@/server/audit";
import { type CurrentUser, can, type Permission } from "@/server/auth/permissions";
import { getCurrentUser } from "@/server/auth/session";
import { describeDbError, errorType } from "@/server/db-error";
import { getRequestId } from "@/server/request-context";

// データを更新する Server Action は、すべて defineAction で作る（"use server" のファイルは
// `export const xxx = defineAction({...})` だけを書く）。次の順で必ず処理する:
//   1. ログイン中の利用者を取る
//   2. 権限表（src/server/auth/permissions.ts）で確かめる。拒否したら監査ログに残す（時間枠ごとに1行にまとめる）
//   3. 受け取った値（FormData。そうでなければ入力の誤りとして拒否を記録する）をオブジェクトにし、Zod で検証する
//   4. 処理（handler）と監査ログの書き込みを1つのトランザクションで行う（どちらかが失敗したら両方取り消す）
//   5. 例外を利用者向けの日本語に置き換える（内部の情報は画面に出さず、ログにはコードだけを残す）
// 画面側は useActionState(action, initialActionState) で呼ぶ（initialActionState は @/lib/action-state から import する）。

export type { ActionState } from "@/lib/action-state";

export const MESSAGES = {
  loginRequired: "ログインしてください",
  forbidden: "この操作を行う権限がありません",
  invalidInput: "入力内容を確認してください",
  duplicate: "同じ内容がすでに登録されています",
  referenced: "関連するデータがあるため、この操作はできません",
  conflict: "ほかの操作と重なりました。もう一度お試しください",
  failed: "処理に失敗しました。時間をおいてもう一度お試しください",
} as const;

// 利用者に見せてよい業務上のエラー（状態の不正など）。handler の中で throw すると、message をそのまま返す。
// それ以外の例外は、一般的なメッセージに置き換える。
export class ActionError extends Error {
  constructor(
    message: string,
    readonly errors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export type ActionContext = { db: Db; user: CurrentUser; requestId?: string };

export type ActionResult<T> = {
  message?: string;
  data?: T;
  // 監査ログの対象（例: 作成・更新したレコードの ID）
  auditTarget?: string | number | null;
  // 確定した後に移る画面（例: 作成したレコードの詳細）。handler の中で redirect() を呼ぶと
  // トランザクションが取り消されて保存されないので、代わりにこれを返す（defineAction が確定後に redirect する）
  redirectTo?: string;
};

export type ActionDefinition<S extends z.ZodType, T> = {
  // ログに出す名前（省略すると権限名）。同じ権限の Server Action が複数あるときに付ける
  name?: string;
  // 権限表の権限名
  permission: Permission;
  // 入力の Zod スキーマ。項目名はフォームの name と合わせる
  input: S;
  // 監査ログに残すか。登録・更新・削除・権限の変更は true
  audit: boolean;
  // ctx.db はトランザクション。ここで行う DB 操作は、監査ログと一緒に確定するか、一緒に取り消される
  handler: (input: z.output<S>, ctx: ActionContext) => Promise<ActionResult<T>>;
};

// テストから時刻と DB を差し替えられる、defineAction の中身（Next.js に依存しない）
export type ExecuteContext = { db: Db; user: CurrentUser | null; requestId?: string; now?: Date };
export type ExecutedState<T> = ActionState<T> & { redirectTo?: string };

function fieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_form");
    out[key] ??= issue.message;
  }
  return out;
}

type ZodDef = { type?: string; innerType?: unknown; in?: unknown; out?: unknown; shape?: Record<string, unknown> };
const defOf = (schema: unknown): ZodDef | undefined => (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;

// optional・nullable・default・pipe（preprocess / transform）などの包みを外して、中のスキーマの定義を返す
function unwrapDef(schema: unknown, want: (def: ZodDef) => boolean): ZodDef | undefined {
  let current: unknown = schema;
  for (let i = 0; i < 10; i++) {
    const def = defOf(current);
    if (!def) return undefined;
    if (want(def)) return def;
    if (def.type === "pipe") {
      const inner = defOf(def.in);
      current = inner && inner.type !== "transform" ? def.in : def.out;
    } else {
      current = def.innerType;
    }
  }
  return undefined;
}

// 入力スキーマ（z.object）で配列として受け取る項目の名前（チェックボックスや複数選択）
function arrayFields(schema: unknown): Set<string> {
  const obj = unwrapDef(schema, (d) => d.type === "object");
  const out = new Set<string>();
  for (const [key, field] of Object.entries(obj?.shape ?? {})) {
    if (unwrapDef(field, (d) => d.type === "array" || d.type === "set")) out.add(key);
  }
  return out;
}

// フォームの値をオブジェクトにする（Next.js が付ける $ACTION_ 系の項目は除く）。
// 入力スキーマで配列の項目は、値が1つでも0個でも配列にする。それ以外は、同じ name が複数あれば配列にする（スキーマが拒否する）。
export function formDataToObject(
  formData: FormData,
  schema?: z.ZodType,
): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const arrays = schema ? arrayFields(schema) : new Set<string>();
  const out: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const key of arrays) out[key] = [];
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = formData.getAll(key);
    out[key] = arrays.has(key) || values.length > 1 ? values : (values[0] ?? "");
  }
  return out;
}

function dbErrorMessage(code: string | undefined): string {
  if (code === "23505") return MESSAGES.duplicate; // unique_violation
  if (code === "23503") return MESSAGES.referenced; // foreign_key_violation
  if (code === "40001" || code === "40P01") return MESSAGES.conflict; // serialization_failure / deadlock_detected
  return MESSAGES.failed;
}

// 拒否の記録。監査ログ自体の失敗で、利用者への応答は変えない（失敗はコードだけをログに残す）。
async function auditDenied(
  db: Db,
  permission: Permission,
  actorId: string,
  reason: DeniedReason,
  requestId?: string,
  now?: Date,
) {
  try {
    await writeDeniedAudit(db, { actorId, action: permission, reason, requestId, now });
  } catch (err) {
    const { code, constraint, errno } = describeDbError(err);
    logger.error("audit_write_failed", { action: permission, userId: actorId, requestId, code, constraint, errno });
  }
}

export async function executeAction<S extends z.ZodType, T>(
  def: ActionDefinition<S, T>,
  ctx: ExecuteContext,
  raw: unknown,
  opts: { requireFormData?: boolean } = {},
): Promise<ExecutedState<T>> {
  const { db, user, requestId, now } = ctx;
  const actionName = def.name ?? def.permission;

  if (!user) {
    await auditDenied(db, def.permission, ANONYMOUS_ACTOR, "login_required", requestId, now);
    return { status: "error", message: MESSAGES.loginRequired };
  }
  if (!can(user, def.permission)) {
    await auditDenied(db, def.permission, user.id, "forbidden", requestId, now);
    return { status: "error", message: MESSAGES.forbidden };
  }

  // 権限を確かめてから、受け取った値を読む。Server Action は任意の値で直接呼べるので、FormData でなければ入力の誤りにする
  let values: unknown = raw;
  if (raw instanceof FormData) values = formDataToObject(raw, def.input);
  else if (opts.requireFormData) {
    await auditDenied(db, def.permission, user.id, "invalid_request", requestId, now);
    return { status: "error", message: MESSAGES.invalidInput };
  }

  try {
    // 非同期の検証（.refine(async …)）の例外も、下の catch で日本語のメッセージにする
    const parsed = await def.input.safeParseAsync(values);
    if (!parsed.success) {
      return { status: "error", message: MESSAGES.invalidInput, errors: fieldErrors(parsed.error) };
    }
    const input = parsed.data;
    const result = await db.transaction(async (tx) => {
      const r = await def.handler(input, { db: tx, user, requestId });
      if (def.audit) {
        await writeAudit(tx, {
          actorId: user.id,
          action: def.permission,
          target: r.auditTarget == null ? null : String(r.auditTarget),
          requestId,
        });
      }
      return r;
    });
    return { status: "success", message: result.message, data: result.data, redirectTo: result.redirectTo };
  } catch (err) {
    if (err instanceof ActionError) return { status: "error", message: err.message, errors: err.errors };
    if (err instanceof ZodError) {
      return { status: "error", message: MESSAGES.invalidInput, errors: fieldErrors(err) };
    }
    const dbError = describeDbError(err);
    if (dbError.isDbError) {
      // DB の例外: メッセージ（SQL と入力値を含む）は出さず、コードと制約名だけを残す
      logger.error("action_failed", {
        action: actionName,
        userId: user.id,
        requestId,
        errorType: errorType(err),
        code: dbError.code,
        constraint: dbError.constraint,
        errno: dbError.errno,
      });
      return { status: "error", message: dbErrorMessage(dbError.code) };
    }
    // それ以外の例外: メッセージは調査に要るのでログに残す（例外のメッセージに入力値や個人情報を入れないこと）
    logger.error("action_failed", {
      action: actionName,
      userId: user.id,
      requestId,
      errorType: errorType(err),
      message: err instanceof Error ? err.message : undefined,
    });
    return { status: "error", message: MESSAGES.failed };
  }
}

export function defineAction<S extends z.ZodType, T = undefined>(def: ActionDefinition<S, T>) {
  return async (_prev: ActionState<T>, formData: FormData): Promise<ActionState<T>> => {
    const [user, requestId] = await Promise.all([getCurrentUser(), getRequestId()]);
    let db: Db;
    try {
      db = await getDb();
    } catch (err) {
      const { code, errno } = describeDbError(err);
      logger.error("db_unavailable", {
        action: def.name ?? def.permission,
        requestId,
        errorType: errorType(err),
        code,
        errno,
      });
      return { status: "error", message: MESSAGES.failed };
    }
    const { redirectTo, ...state } = await executeAction(def, { db, user, requestId }, formData, {
      requireFormData: true,
    });
    if (state.status === "success" && redirectTo) redirect(redirectTo);
    return state;
  };
}
