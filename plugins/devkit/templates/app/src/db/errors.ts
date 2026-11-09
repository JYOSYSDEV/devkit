import { PgPreparedQuery } from "drizzle-orm/pg-core";

// DB の例外を、値を含まない例外（DbError）に包み直す。
// drizzle の例外（DrizzleQueryError）のメッセージは SQL とパラメータ（= 利用者の入力値）を含み、
// ドライバの例外も detail（例: Key (email)=(...) already exists）・メッセージ（例: invalid input syntax for type integer: "..."）・
// query・params に値を持つ。画面やルートハンドラで例外が起きると Next.js がそれを標準エラーに書くので、
// getDb() が返す Db の例外は、元の例外を捨てて SQLSTATE・制約名・表名・列名・Node.js のエラーコードだけを持たせる。

// よく出る SQLSTATE の名前（ログを読む人のため。値は含まない）
const SQLSTATE_NAMES: Record<string, string> = {
  "23505": "unique_violation",
  "23503": "foreign_key_violation",
  "23502": "not_null_violation",
  "23514": "check_violation",
  "22P02": "invalid_text_representation",
  "22001": "string_data_right_truncation",
  "22003": "numeric_value_out_of_range",
  "22007": "invalid_datetime_format",
  "40001": "serialization_failure",
  "40P01": "deadlock_detected",
  "57014": "query_canceled",
  "42P01": "undefined_table",
  "42703": "undefined_column",
  "42883": "undefined_function",
  "42601": "syntax_error",
  "28P01": "invalid_password",
  "3D000": "invalid_catalog_name",
  "53300": "too_many_connections",
};

export type DbErrorInfo = {
  // PostgreSQL のエラーコード（SQLSTATE。DB が返した例外のときだけ）
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  // Node.js のエラーコード（ECONNREFUSED など。接続できなかったとき）
  errno?: string;
};

export class DbError extends Error {
  // declare: 値のない項目を undefined のプロパティとして作らない（ログが読みやすいように）
  declare readonly code?: string;
  declare readonly constraint?: string;
  declare readonly table?: string;
  declare readonly column?: string;
  declare readonly errno?: string;

  constructor(info: DbErrorInfo) {
    const parts = [
      info.code && `SQLSTATE ${info.code}${SQLSTATE_NAMES[info.code] ? ` ${SQLSTATE_NAMES[info.code]}` : ""}`,
      info.constraint && `制約 ${info.constraint}`,
      info.table && `表 ${info.table}`,
      info.column && `列 ${info.column}`,
      info.errno && `errno ${info.errno}`,
    ].filter(Boolean);
    super(`DB の処理に失敗しました${parts.length ? `（${parts.join("、")}）` : ""}`);
    this.name = "DbError";
    for (const [k, v] of Object.entries(info)) if (v !== undefined) Object.assign(this, { [k]: v });
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const NODE_ERRNO = /^E[A-Z0-9_]{2,}$/;
const IDENT = /^[\w$.-]{1,128}$/;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const ident = (v: unknown) => (typeof v === "string" && IDENT.test(v) ? v : undefined);

// 例外（とその cause・AggregateError の errors）から、値を含まない項目だけを取り出す。
// SQLSTATE は DB が返した例外（severity と code を持つもの。pg と PGlite の DatabaseError）からだけ取る。
// ECONNREFUSED などの Node.js のエラーコードは errno に分ける（5文字の EPIPE などを SQLSTATE と取り違えない）。
export function dbErrorInfo(err: unknown): DbErrorInfo {
  if (err instanceof DbError) {
    const { code, constraint, table, column, errno } = err;
    return { code, constraint, table, column, errno };
  }
  const info: DbErrorInfo = {};
  const queue: unknown[] = [err];
  for (let i = 0; i < queue.length && i < 8; i++) {
    const e = queue[i];
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const code = str(o.code);
    if (!info.code && code && SQLSTATE.test(code) && typeof o.severity === "string") {
      info.code = code;
      info.constraint = ident(o.constraint);
      info.table = ident(o.table);
      info.column = ident(o.column);
    } else if (!info.errno && code && NODE_ERRNO.test(code)) {
      info.errno = code;
    }
    if (o.cause) queue.push(o.cause);
    if (Array.isArray(o.errors)) queue.push(...o.errors.slice(0, 3));
  }
  return info;
}

export function toDbError(err: unknown): DbError {
  return err instanceof DbError ? err : new DbError(dbErrorInfo(err));
}

// drizzle の SQL の実行（PgPreparedQuery.queryWithCache。pg と PGlite の両方が通る）を包み、例外を DbError にする。
// drizzle の内部の関数なので、drizzle-orm の版を上げたら tests/unit/db-errors.test.ts で確かめる（版は package.json で固定している）。
const PATCHED = Symbol.for("devkit.db-error-sanitizer");

type Patchable = { queryWithCache?: (...args: unknown[]) => Promise<unknown>; [PATCHED]?: boolean };

export function installDbErrorSanitizer(): void {
  const proto = PgPreparedQuery.prototype as unknown as Patchable;
  if (proto[PATCHED]) return;
  const original = proto.queryWithCache;
  if (typeof original !== "function") {
    throw new Error(
      "drizzle-orm の PgPreparedQuery.queryWithCache が見つかりません。src/db/errors.ts を drizzle-orm の版に合わせて直す",
    );
  }
  proto.queryWithCache = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      throw toDbError(err);
    }
  };
  proto[PATCHED] = true;
}
