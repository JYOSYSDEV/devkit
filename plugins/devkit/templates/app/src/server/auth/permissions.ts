// 権限表。誰が何をできるかは、ここでだけ決める（画面・API・Server Action はこの表を can() で引く）。
// 仕様書（docs/spec/）の「権限表」と一致させる。役割や権限を変えるのは業務の判断なので、人間の確認を受ける。
// 役割の一覧は roles.ts（E2E の設定からも読むので別のファイルにしている）。
import type { Role } from "./roles";

export { DEV_DEFAULT_ROLE, isRole, ROLE_LABELS, ROLES, type Role } from "./roles";

// 権限名は "<機能>.<操作>"（キーは引用符付きで書く。devkit の検査がこの表を読む）。値はその操作ができる役割。
export const PERMISSIONS = {
  "todos.read": ["admin", "member", "viewer"],
  "todos.create": ["admin", "member"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export type CurrentUser = { id: string; name: string; roles: readonly Role[] };

export function can(user: CurrentUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return user.roles.some((role) => allowed.includes(role));
}
