import { createHash, randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_TOKEN_COOKIE } from "./src/server/auth/roles";

// worktree ごとに別のポートを使う（並列ワーカーの E2E が、別の worktree のサーバーに当たらないように）
const portOffset = Number.parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 6), 16) % 800;
const PORT = Number(process.env.E2E_PORT ?? 3100 + portOffset);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

// E2E 用のビルドで開発用ログインに要るトークン。Playwright を起動するたびに作り直し、webServer のビルドに埋め込む（next.config.ts）。
// テストを実行するワーカーはこの環境変数を受け継ぐので、同じ値を Cookie に入れられる（下の storageState と e2e/fixtures.ts）。
process.env.DEVKIT_E2E_AUTH_TOKEN ||= randomBytes(32).toString("hex");
const E2E_AUTH_TOKEN = process.env.DEVKIT_E2E_AUTH_TOKEN;

export default defineConfig({
  testDir: "e2e",
  // E2E のサーバーは1つのメモリ上の PGlite を全テストで共有するので、テストを並列にするとデータが混ざる。
  // 順に実行し、各テストは自分で作ったデータ（固有の名前など）だけを確かめる。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // test-reports/e2e.json は devkit のランナーが結果（どの AC のテストが通ったか）を読むのに使う
  reporter: [[process.env.CI ? "github" : "list"], ["json", { outputFile: "test-reports/e2e.json" }]],
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    // ブラウザと request（API のテスト）の両方に、開発用ログインのトークンの Cookie を入れておく。
    // 役割は既定で DEV_AUTH_ROLE（下の webServer.env）。テストの中で asRole(context, "viewer", baseURL) で変える。
    storageState: {
      cookies: [
        {
          name: E2E_AUTH_TOKEN_COOKIE,
          value: E2E_AUTH_TOKEN,
          domain: HOST,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // 社内ネットワークでブラウザのダウンロードが止められる場合は、
        // インストール済みの Chrome / Edge を使う: E2E_CHANNEL=chrome または E2E_CHANNEL=msedge
        ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
        // または、手元の Chromium の実行ファイルを直接指定する: E2E_EXECUTABLE_PATH=/path/to/chrome
        ...(process.env.E2E_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: process.env.E2E_EXECUTABLE_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    // E2E 用のビルド（DEVKIT_E2E_AUTH=1。出力先は .next-e2e/）を作ってから起動する。
    // 開発用の利用者（AUTH_MODE=dev）は、このビルドで、このときのトークンの Cookie があるときだけ働く（src/lib/env.ts）。
    // pnpm build（.next/）や Docker イメージには影響しない。外から届かないよう 127.0.0.1 だけで待ち受ける。
    command: `pnpm exec next build && pnpm exec next start -H ${HOST} --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    env: {
      DEVKIT_E2E_AUTH: "1",
      DEVKIT_E2E_AUTH_TOKEN: E2E_AUTH_TOKEN,
      AUTH_MODE: "dev",
      DEV_AUTH_ROLE: "member",
      // E2E はメモリ上の PGlite で動かす（Docker も外部 DB も不要。起動時にマイグレーションを適用）
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "pglite://memory",
    },
    // すでに動いているサーバーは使わない（別の worktree や古いビルドのサーバーで E2E が通ってしまうのを防ぐ）。
    // ポートが使われていれば、黙って使い回さずにエラーで止まる。
    reuseExistingServer: false,
    // ビルドを含むので長めに待つ
    timeout: 300_000,
  },
});
