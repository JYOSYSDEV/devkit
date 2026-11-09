import { type NextRequest, NextResponse } from "next/server";
import { isDevServer } from "@/lib/env";
import { contentSecurityPolicy, REQUEST_ID_HEADER } from "@/lib/security-headers";

// すべてのリクエスト（静的ファイルを除く）の前に動く。
// - CSP の nonce をリクエストごとに作り、応答の Content-Security-Policy（next.config.ts の既定を上書き）とリクエストに入れる。
//   Next.js はリクエストの CSP から nonce を読み取り、画面のスクリプトに付ける。
//   nonce はリクエスト時の描画でしか付かないので、ルートレイアウト（src/app/layout.tsx）が全画面をリクエスト時の描画にしている。
// - リクエスト ID（x-request-id）を作る。利用者が送ってきた x-request-id は信用せず、必ず上書きする。
//   応答にも付けるので、問い合わせのときにログと監査ログをたどれる。
// 認証や権限の確認はここでは行わない（画面・API・Server Action の入口で guard.ts と defineAction が行う）。
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy({ nonce, dev: isDevServer() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  const requestId = crypto.randomUUID();
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // ビルド済みの静的ファイルと画像の最適化は除く（CSP もリクエスト ID も要らない）
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
