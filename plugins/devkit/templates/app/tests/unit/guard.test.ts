import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser, Permission } from "@/server/auth/permissions";

const current = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/server/auth/session", () => ({ getCurrentUser: async () => current.user }));
// 案件の権限表に依存させない（サンプルを消しても動くように）
vi.mock("@/server/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/permissions")>();
  const table: Record<string, readonly string[]> = { "items.read": ["admin", "viewer"], "items.create": ["admin"] };
  return {
    ...actual,
    can: (user: CurrentUser | null, p: string) => !!user && user.roles.some((r) => (table[p] ?? []).includes(r)),
  };
});
const READ = "items.read" as Permission;
const CREATE = "items.create" as Permission;

const { allowAnonymous, deniedResponse, requirePermission, requireUser } = await import("@/server/auth/guard");

describe("guard（画面と API の入口）", () => {
  beforeEach(() => {
    current.user = null;
  });

  it("ログインしていなければ 401", async () => {
    expect(await requireUser()).toEqual({ ok: false, status: 401, message: "ログインしてください" });
    expect(await requirePermission(READ)).toMatchObject({ ok: false, status: 401 });
  });

  it("権限がなければ 403、あれば利用者を返す", async () => {
    current.user = { id: "u-viewer", name: "閲覧者", roles: ["viewer"] };
    expect(await requirePermission(CREATE)).toEqual({
      ok: false,
      status: 403,
      message: "閲覧する権限がありません",
    });
    expect(await requirePermission(READ)).toEqual({ ok: true, user: current.user });
  });

  it("deniedResponse は拒否を JSON で返す", async () => {
    const res = deniedResponse({ ok: false, status: 403, message: "閲覧する権限がありません" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "閲覧する権限がありません" });
  });

  it("allowAnonymous は理由がなければ止める", () => {
    expect(() => allowAnonymous("ヘルスチェック")).not.toThrow();
    expect(() => allowAnonymous("  ")).toThrow();
  });
});
