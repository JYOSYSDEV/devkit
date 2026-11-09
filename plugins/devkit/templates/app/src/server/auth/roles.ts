// 役割の一覧（ここだけで決める）。権限表（permissions.ts）・開発用の利用者（session.ts）・E2E（playwright.config.ts と e2e/fixtures.ts）が使う。
// 仕様書の「目的と利用者」に合わせて変える。並びは強い順（最後が最も弱い役割）。
// このファイルは Next.js や DB に依存させない（Playwright の設定からも読むため）。
export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  member: "一般",
  viewer: "閲覧のみ",
};

// 開発用の利用者（AUTH_MODE=dev）の既定の役割。Cookie devkit-dev-role や DEV_AUTH_ROLE で切り替えられる。
export const DEV_DEFAULT_ROLE: Role = "member";

// 開発用の利用者の役割を切り替える Cookie と、E2E 用のビルドで開発用ログインに要るトークンの Cookie
export const DEV_ROLE_COOKIE = "devkit-dev-role";
export const E2E_AUTH_TOKEN_COOKIE = "devkit-e2e-token";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
