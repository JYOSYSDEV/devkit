import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // .tsx のテストも拾う（拾わないと、書いたテストが黙って実行されない）。環境は node なので DOM は使えない。
    // 画面の振る舞いは e2e/ の Playwright で確かめる。
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", ".pnpm-store/**", ".claude/worktrees/**", ".devkit/tmp/**"],
    testTimeout: 30_000,
    // 画面への表示に加えて、test-reports/vitest.json に結果を書く（devkit のランナーがどのテストが通ったかを読む）
    reporters: ["default", "json"],
    outputFile: { json: "test-reports/vitest.json" },
  },
});
