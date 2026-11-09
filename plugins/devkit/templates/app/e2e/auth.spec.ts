import { DEV_ROLE_COOKIE, E2E_AUTH_TOKEN_COOKIE } from "../src/server/auth/roles";
import { asRole, expect, test } from "./fixtures";

// 開発用ログイン（AUTH_MODE=dev）は、E2E 用のビルドでも、このときの Playwright が作ったトークンの Cookie がないと働かない。
// サンプル（todos）を消しても動くように、ログイン中の利用者を返す GET /api/me で確かめる。
test.describe("開発用ログイン（E2E 用のビルド）", () => {
  test("トークンの Cookie があれば、役割の Cookie の利用者としてログインする", async ({ page, context, baseURL }) => {
    await asRole(context, "admin", baseURL);
    const res = await page.request.get("/api/me");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ id: "dev-admin", roles: ["admin"] });
  });

  test("トークンの Cookie がなければ、役割の Cookie があってもログインしていない扱いになる", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.clearCookies();
    await context.addCookies([{ name: DEV_ROLE_COOKIE, value: "admin", url: baseURL ?? "" }]);
    const res = await page.request.get("/api/me");
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "ログインしてください" });
  });

  test("トークンが違えば、ログインしていない扱いになる", async ({ page, context, baseURL }) => {
    await context.clearCookies();
    await context.addCookies([
      { name: DEV_ROLE_COOKIE, value: "admin", url: baseURL ?? "" },
      { name: E2E_AUTH_TOKEN_COOKIE, value: "0".repeat(64), url: baseURL ?? "" },
    ]);
    const res = await page.request.get("/api/me");
    expect(res.status()).toBe(401);
  });

  test("役割の一覧にない役割名の Cookie はエラーにする（テストの書き間違いに気づくため）", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: DEV_ROLE_COOKIE, value: "root", url: baseURL ?? "" }]);
    const res = await page.request.get("/api/me");
    expect(res.status()).toBe(500);
    // 応答には内部のエラーの内容を出さない
    expect(await res.text()).not.toContain("root");
  });
});
