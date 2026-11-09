import { deniedResponse, requireUser } from "@/server/auth/guard";

export const dynamic = "force-dynamic";

// ログイン中の利用者（ID と役割だけ）。ログインしていなければ 401。
// ルートハンドラの入口の書き方の例でもある（ガードを呼び、ok でなければすぐに deniedResponse を返す）。
export async function GET() {
  const access = await requireUser();
  if (!access.ok) return deniedResponse(access);
  return Response.json({ id: access.user.id, roles: access.user.roles });
}
