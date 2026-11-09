import { expect, test } from "./fixtures";

test("トップページが表示される", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // スクリプトの読み込みまで待つ（CSP で止められたら fixtures.ts がテストを失敗にする）
  await page.waitForLoadState("load");
});

test("ヘルスチェックが DB まで ok を返す", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ status: "ok", db: "ok" });
});

test("セキュリティヘッダーが付いている", async ({ request }) => {
  const res = await request.get("/", { headers: { "x-request-id": "spoofed" } });
  const headers = res.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toContain("max-age=63072000");
  // リクエスト ID は利用者が送った値を使わず、サーバーが作り直す
  expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // 画面のスクリプトは nonce 付きのものだけを実行する（'unsafe-inline' を使わない）
  const scriptSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  expect(scriptSrc).toMatch(/^script-src 'self' 'nonce-[^']+' 'strict-dynamic'$/);
});
