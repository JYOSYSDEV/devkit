import { afterEach, describe, expect, it, vi } from "vitest";
import { devAuthBuildEnabled } from "@/lib/env";
import { devRole, e2eTokenMatches, resolveDevUser, UnknownDevRoleError } from "@/server/auth/session";

const TOKEN = "a".repeat(64);

describe("開発用の利用者（AUTH_MODE=dev）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("使えるビルドでは、Cookie の役割の利用者になる", () => {
    const user = resolveDevUser({ env: { AUTH_MODE: "dev" }, buildEnabled: true, cookieRole: "admin" });
    expect(user).toEqual({ id: "dev-admin", name: "開発用ユーザー", roles: ["admin"] });
  });

  it("通常の本番ビルドでは、AUTH_MODE=dev と Cookie がそろっても誰もログインしていない扱い", () => {
    const user = resolveDevUser({
      env: { AUTH_MODE: "dev", DEV_AUTH_ROLE: "admin" },
      buildEnabled: false,
      cookieRole: "admin",
    });
    expect(user).toBeNull();
  });

  it("E2E 用のビルドでは、トークンの Cookie が一致するときだけログインさせる（残ったビルドを別に起動しても使えない）", () => {
    const base = { env: { AUTH_MODE: "dev" as const }, buildEnabled: true, e2eBuild: true, expectedToken: TOKEN };
    expect(resolveDevUser({ ...base, cookieRole: "admin", cookieToken: TOKEN })?.roles).toEqual(["admin"]);
    expect(resolveDevUser({ ...base, cookieRole: "admin" })).toBeNull();
    expect(resolveDevUser({ ...base, cookieRole: "admin", cookieToken: "b".repeat(64) })).toBeNull();
    // トークンを埋め込まずにビルドしたもの（手で DEVKIT_E2E_AUTH=1 でビルドしたなど）は、誰もログインできない
    expect(resolveDevUser({ ...base, expectedToken: "", cookieRole: "admin", cookieToken: "" })).toBeNull();
  });

  it("E2E 用のビルドでは、役割の一覧にない役割名の Cookie はエラーにする", () => {
    const base = { env: { AUTH_MODE: "dev" as const }, buildEnabled: true, e2eBuild: true, expectedToken: TOKEN };
    expect(() => resolveDevUser({ ...base, cookieRole: "root", cookieToken: TOKEN })).toThrow(UnknownDevRoleError);
  });

  it("next dev（E2E 用のビルドではない）ではトークンは要らない", () => {
    expect(resolveDevUser({ env: { AUTH_MODE: "dev" }, buildEnabled: true, cookieRole: "viewer" })?.roles).toEqual([
      "viewer",
    ]);
  });

  it("トークンの比較は、短すぎる期待値を常に不一致にする", () => {
    expect(e2eTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(e2eTokenMatches("short", "short")).toBe(false);
    expect(e2eTokenMatches(TOKEN, undefined)).toBe(false);
  });

  it("AUTH_MODE が dev 以外なら Cookie は無視する", () => {
    expect(resolveDevUser({ env: { AUTH_MODE: "none" }, buildEnabled: true, cookieRole: "admin" })).toBeNull();
    expect(resolveDevUser({ env: { AUTH_MODE: "better-auth" }, buildEnabled: true, cookieRole: "admin" })).toBeNull();
  });

  it("役割は Cookie → DEV_AUTH_ROLE → 既定（member）の順で、権限表にない値は使わない", () => {
    expect(devRole("viewer", "admin")).toBe("viewer");
    expect(devRole(undefined, "admin")).toBe("admin");
    expect(devRole("root", undefined)).toBe("member");
    expect(devRole("root", "superuser")).toBe("member");
  });

  it("使えるかどうかは NODE_ENV と DEVKIT_E2E_AUTH で決まる（Next.js のビルドではビルド時の値に置き換わる）", () => {
    expect(devAuthBuildEnabled()).toBe(true); // Vitest は NODE_ENV=test
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEVKIT_E2E_AUTH", "0");
    expect(devAuthBuildEnabled()).toBe(false);
    vi.stubEnv("DEVKIT_E2E_AUTH", "1");
    expect(devAuthBuildEnabled()).toBe(true);
  });
});
