import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { devAuthBuildEnabled, type Env, e2eAuthToken, isE2eBuild, loadEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { CurrentUser } from "./permissions";
import { DEV_DEFAULT_ROLE, DEV_ROLE_COOKIE, E2E_AUTH_TOKEN_COOKIE, isRole, ROLES, type Role } from "./roles";

export { DEV_ROLE_COOKIE, E2E_AUTH_TOKEN_COOKIE } from "./roles";

const warned = new Set<string>();
function warnOnce(event: string, fields: Record<string, unknown>) {
  if (warned.has(event)) return;
  warned.add(event);
  logger.warn(event, fields);
}

// 開発用の利用者の役割。Cookie → DEV_AUTH_ROLE → 既定（DEV_DEFAULT_ROLE）の順に、役割の一覧にある値を使う。
export function devRole(cookieValue: string | undefined, envRole: string | undefined): Role {
  for (const candidate of [cookieValue, envRole, DEV_DEFAULT_ROLE]) {
    if (isRole(candidate)) return candidate;
  }
  return ROLES[ROLES.length - 1] as Role;
}

// E2E 用のビルドのトークンが一致するか（長さが足りないトークンは、設定の誤りとして常に不一致）
export function e2eTokenMatches(expected: string, given: string | undefined): boolean {
  if (expected.length < 32 || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class UnknownDevRoleError extends Error {
  constructor(role: string) {
    super(
      `開発用ログインの Cookie ${DEV_ROLE_COOKIE} の役割「${role}」は役割の一覧（src/server/auth/roles.ts）にありません`,
    );
    this.name = "UnknownDevRoleError";
  }
}

// AUTH_MODE=dev のときの利用者。
// - buildEnabled（devAuthBuildEnabled() の値）が false のビルド（通常の本番ビルド）では、環境変数・Host ヘッダー・Cookie が
//   どうであっても null（誰もログインしていない）を返す。
// - e2eBuild（E2E 用のビルド）では、Cookie devkit-e2e-token がビルドに埋め込んだトークンと一致するときだけログインさせる。
//   知らない役割名の Cookie は、テストの書き間違いなのでエラーにする。
export function resolveDevUser(opts: {
  env: Pick<Env, "AUTH_MODE" | "DEV_AUTH_ROLE">;
  buildEnabled: boolean;
  e2eBuild?: boolean;
  expectedToken?: string;
  cookieRole: string | undefined;
  cookieToken?: string;
}): CurrentUser | null {
  if (opts.env.AUTH_MODE !== "dev" || !opts.buildEnabled) return null;
  if (opts.e2eBuild) {
    if (!e2eTokenMatches(opts.expectedToken ?? "", opts.cookieToken)) return null;
    if (opts.cookieRole !== undefined && !isRole(opts.cookieRole)) throw new UnknownDevRoleError(opts.cookieRole);
  }
  const role = devRole(opts.cookieRole, opts.env.DEV_AUTH_ROLE);
  return { id: `dev-${role}`, name: "開発用ユーザー", roles: [role] };
}

// ログイン中の利用者を返す。ログインしていなければ null。
// 画面と API は直接呼ばず、src/server/auth/guard.ts の requireUser / requirePermission を使う。
// データの更新は defineAction（src/server/action.ts）がこれを呼んで権限を確かめる。
//
// 本番の認証を入れるときは、AUTH_MODE=better-auth の分岐を Better Auth のセッション取得に置き換え、
// docs/profile.json の auth を更新する。
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const env = loadEnv();
  switch (env.AUTH_MODE) {
    case "dev": {
      const buildEnabled = devAuthBuildEnabled();
      if (!buildEnabled) {
        // 通常の本番ビルドでは開発用の利用者を使えない。設定の誤りなので一度だけ警告し、安全側（ログインなし）に倒す。
        warnOnce("dev_auth_disabled_in_this_build", { mode: env.AUTH_MODE });
        return null;
      }
      const jar = await cookies();
      const user = resolveDevUser({
        env,
        buildEnabled,
        e2eBuild: isE2eBuild(),
        expectedToken: e2eAuthToken(),
        cookieRole: jar.get(DEV_ROLE_COOKIE)?.value,
        cookieToken: jar.get(E2E_AUTH_TOKEN_COOKIE)?.value,
      });
      if (!user && isE2eBuild()) warnOnce("dev_auth_token_rejected", { mode: env.AUTH_MODE });
      return user;
    }
    case "better-auth":
      // 認証を実装するまでは、誰もログインしていない扱い
      warnOnce("auth_not_implemented", { mode: env.AUTH_MODE });
      return null;
    case "none":
      return null;
  }
}
