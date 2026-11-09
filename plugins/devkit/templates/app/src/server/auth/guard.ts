import { type CurrentUser, can, type Permission } from "./permissions";
import { getCurrentUser } from "./session";

// 画面（page.tsx）とルートハンドラ（route.ts の各メソッド）の先頭で、必ずどれか1つを呼ぶ。
//
//   const access = await requirePermission("todos.read");
//   if (!access.ok) return <AccessDenied message={access.message} />;   // 画面
//   if (!access.ok) return deniedResponse(access);                      // ルートハンドラ
//
// 認証なしで公開する画面・API は allowAnonymous("理由") を書いて、公開してよい理由を残す。
// データの更新は defineAction（src/server/action.ts）が権限を確かめるので、ここでは表示の可否だけを決める。

export type Access = { ok: true; user: CurrentUser } | { ok: false; status: 401 | 403; message: string };
export type AccessDenied = Extract<Access, { ok: false }>;

export const LOGIN_REQUIRED_MESSAGE = "ログインしてください";
export const FORBIDDEN_MESSAGE = "閲覧する権限がありません";

export async function requireUser(): Promise<Access> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, message: LOGIN_REQUIRED_MESSAGE };
  return { ok: true, user };
}

export async function requirePermission(permission: Permission): Promise<Access> {
  const access = await requireUser();
  if (!access.ok) return access;
  if (!can(access.user, permission)) return { ok: false, status: 403, message: FORBIDDEN_MESSAGE };
  return access;
}

// 認証なしで公開することの宣言。理由はレビューで確かめる（空の理由は認めない）。
export function allowAnonymous(reason: string): void {
  if (!reason.trim()) throw new Error("allowAnonymous には、認証なしで公開してよい理由を書く");
}

// ルートハンドラ用: 拒否を 401 / 403 の JSON で返す
export function deniedResponse(access: AccessDenied): Response {
  return Response.json({ error: access.message }, { status: access.status });
}
