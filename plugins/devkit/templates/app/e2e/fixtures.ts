import { mkdirSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, test as base, expect } from "@playwright/test";
import { DEV_ROLE_COOKIE, isRole, ROLES, type Role } from "../src/server/auth/roles";
import { screenshotFileName } from "./names";

// E2E のテストは @playwright/test ではなく、このファイルの test と expect を import する。
// - E2E_SCREENSHOT_DIR を指定すると、各テストの最後の画面を <dir>/<ファイル名 - describe - テスト名>.png に保存する
//   （devkit のランナーが確認資料に使う。名前の作り方は e2e/names.ts）
// - 画面が CSP（Content-Security-Policy）に違反したら、そのテストを失敗にする（nonce が付かずにスクリプトが止まった、など）
// - asRole で開発用の利用者の役割を切り替えられる（権限のテスト用）。開発用ログインのトークンの Cookie は
//   playwright.config.ts の storageState が入れている（E2E 用のビルドは、トークンがないとログインさせない）

export { ROLES, type Role };

export async function asRole(context: BrowserContext, role: Role, baseURL: string | undefined) {
  if (!baseURL) throw new Error("baseURL が未設定です（playwright.config.ts の use.baseURL）");
  if (!isRole(role)) throw new Error(`役割「${role}」は src/server/auth/roles.ts の ROLES にありません`);
  await context.addCookies([{ name: DEV_ROLE_COOKIE, value: role, url: baseURL }]);
}

export const test = base.extend<{ cspViolations: undefined; screenshotOnEnd: undefined }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error" && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
      });
      await use(undefined);
      expect(violations, "CSP に違反した読み込みがある").toEqual([]);
    },
    { auto: true },
  ],
  screenshotOnEnd: [
    async ({ page }, use, testInfo) => {
      await use(undefined);
      const dir = process.env.E2E_SCREENSHOT_DIR;
      if (!dir || page.isClosed() || page.url() === "about:blank") return;
      mkdirSync(dir, { recursive: true });
      try {
        await page.screenshot({ path: path.join(dir, screenshotFileName(testInfo.titlePath)), fullPage: true });
      } catch {
        // 画面を保存できなくても、テストの結果は変えない
      }
    },
    { auto: true },
  ],
});

export { expect };
