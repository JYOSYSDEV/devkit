import type { NextConfig } from "next";
import { contentSecurityPolicy } from "./src/lib/security-headers";

// E2E 用のビルドか（playwright.config.ts の webServer だけが DEVKIT_E2E_AUTH=1 でビルドする）。
// - 下の env で、コードの中の process.env.DEVKIT_E2E_AUTH をビルド時の値（"1" か "0"）に置き換える。
//   開発用の利用者（AUTH_MODE=dev）を使えるかはこの値で決まり（src/lib/env.ts の devAuthBuildEnabled）、起動時の環境変数では変えられない。
// - E2E 用のビルドでは、Playwright が起動のたびに作るトークン（DEVKIT_E2E_AUTH_TOKEN）も埋め込む。開発用ログインには
//   このトークンの Cookie が要るので、残った .next-e2e/ を別に起動しても、開発用ログインは使えない。
// - 出力先を .next-e2e/ に分ける。E2E 用のビルドが .next/（pnpm start と Docker イメージが使う）に入ることはない。
const e2eBuild = process.env.DEVKIT_E2E_AUTH === "1";

// Host を書き換えるリバースプロキシの後ろに置くときに、Server Action を受け付ける利用者側のホスト（カンマ区切り。例: app.example.co.jp）。
// プロキシが x-forwarded-host を渡すなら要らない。Docker イメージ（standalone）では next build の時点の値が使われる（docs/runbook.md）。
const allowedOrigins = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// セキュリティヘッダー（すべての応答に付ける）。
// CSP の中身は src/lib/security-headers.ts。画面の応答では src/proxy.ts が nonce 入りの CSP に置き換える。
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy({ dev: process.env.NODE_ENV === "development" }),
  },
];

const nextConfig: NextConfig = {
  // Docker イメージを作るときだけ standalone 出力にする（Dockerfile が NEXT_OUTPUT=standalone を設定）。
  // 通常のビルドでは `next start` がそのまま動く。
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  distDir: e2eBuild ? ".next-e2e" : ".next",
  env: {
    DEVKIT_E2E_AUTH: e2eBuild ? "1" : "0",
    DEVKIT_E2E_AUTH_TOKEN: e2eBuild ? (process.env.DEVKIT_E2E_AUTH_TOKEN ?? "") : "",
  },
  // PGlite は WebAssembly とデータファイルを持つので、バンドルせずに Node.js から読み込む。
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  turbopack: {
    // src/instrumentation.ts は Edge のランタイム用にもビルドされる。Edge では起動時の検査（src/server/startup-check.ts）を
    // 呼ばない（IS_NODE_RUNTIME）が、静的な解析が process.exit・process.stderr の使用を警告するので、その警告だけを消す。
    ignoreIssue: [
      { path: "**/src/server/startup-check.ts", title: /Node\.js API is used/ },
      { path: "**/src/lib/logger.ts", title: /Node\.js API is used/ },
    ],
  },
  ...(allowedOrigins.length ? { experimental: { serverActions: { allowedOrigins } } } : {}),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
