// Content-Security-Policy（CSP）。ブラウザが読み込んでよいものを、このアプリ自身（'self'）に限る。
// next.config.ts（すべての応答に付ける既定）と src/proxy.ts（画面ごとに nonce を入れて上書きする）の両方がこれを使う。
//
// - script-src: 画面では、リクエストごとの nonce を持つスクリプトと、それが読み込むスクリプト（'strict-dynamic'）だけを実行する。
//   Next.js は応答の CSP から nonce を読み取り、自分のスクリプトに付ける（node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md）。
//   nonce なし（next.config.ts の既定）は 'self' だけで、インラインのスクリプトは動かない（proxy が外れたら画面が動かなくなり、気づける）。
//   開発サーバー（next dev）だけは、React のデバッグ機能が eval を使うので 'unsafe-eval' を足す。
// - style-src: React や Next.js が style 属性を使うので 'unsafe-inline' を残す（スタイルの注入はスクリプトより危険が小さい）。
// 外部のサービス（画像・API・フォントなど）を使うときは、その host をここに足す（仕様書の「個人情報と外部連携」に書いてから）。
export function contentSecurityPolicy(opts: { nonce?: string; dev?: boolean } = {}): string {
  const scriptSrc = ["'self'"];
  if (opts.nonce) scriptSrc.push(`'nonce-${opts.nonce}'`, "'strict-dynamic'");
  if (opts.dev) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

// リクエスト ID のヘッダー。src/proxy.ts がリクエストごとに作り（利用者が送った値は上書きする）、
// src/server/request-context.ts の getRequestId() が読む。ログと監査ログに残し、同じリクエストの記録をたどれるようにする。
export const REQUEST_ID_HEADER = "x-request-id";
