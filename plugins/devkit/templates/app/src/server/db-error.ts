import { DbError, dbErrorInfo } from "@/db/errors";

// 例外から、ログに出してよい項目（SQLSTATE・制約名・Node.js のエラーコード）だけを取り出す。
// DB の例外のメッセージ・detail・SQL・パラメータは入力値を含むので、ログにはこれの結果だけを出す。
// getDb() の Db が投げる例外は、すでに値を含まない DbError になっている（src/db/errors.ts）。
export function describeDbError(err: unknown): {
  isDbError: boolean;
  code?: string;
  constraint?: string;
  errno?: string;
} {
  const { code, constraint, errno } = dbErrorInfo(err);
  return { isDbError: err instanceof DbError || code !== undefined, code, constraint, errno };
}

// 例外の種類（クラス名）。メッセージの代わりにログへ出す
export function errorType(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}
