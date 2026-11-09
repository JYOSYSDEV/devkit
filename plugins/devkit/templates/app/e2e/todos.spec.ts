import { asRole, expect, test } from "./fixtures";

// サンプル機能（やること）。権限表: todos.read = admin / member / viewer、todos.create = admin / member
test.describe("やること（サンプル機能）", () => {
  test("一般の利用者が登録すると一覧に表示される", async ({ page, context, baseURL }) => {
    await asRole(context, "member", baseURL);
    const title = `請求書を送る ${Date.now()}`;

    await page.goto("/todos");
    await page.getByLabel("タイトル").fill(title);
    await page.getByRole("button", { name: "登録する" }).click();

    await expect(page.getByRole("status")).toHaveText("登録しました");
    await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();
  });

  test("タイトルが空なら登録せず、欄の下にエラーを表示する", async ({ page, context, baseURL }) => {
    await asRole(context, "member", baseURL);

    await page.goto("/todos");
    await page.getByRole("button", { name: "登録する" }).click();

    await expect(page.getByRole("status")).toHaveText("入力内容を確認してください");
    await expect(page.getByText("タイトルは必須です")).toBeVisible();
  });

  test("閲覧のみの利用者には一覧だけを表示し、登録欄を出さない", async ({ page, context, baseURL }) => {
    await asRole(context, "viewer", baseURL);

    await page.goto("/todos");
    await expect(page.getByRole("heading", { name: "一覧" })).toBeVisible();
    await expect(page.getByText("閲覧のみの権限のため、登録はできません。")).toBeVisible();
    await expect(page.getByRole("button", { name: "登録する" })).toHaveCount(0);
    await expect(page.getByLabel("タイトル")).toHaveCount(0);
  });
});
