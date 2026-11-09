import type { ReactNode } from "react";

// DB を読む画面は、この (app) グループの下に置く（URL には (app) は出ない。例: src/app/(app)/expenses/page.tsx → /expenses）。
// Next.js は、リクエスト時の API を使わない画面を `next build` でプリレンダリングする。
// DB の内容はリクエストごとに変わるので、このグループ全体をリクエスト時の描画にする。
// （next.config.ts で cacheComponents を有効にする場合は、この指定は使えない。ADR を書いて方式を決め直す）
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return children;
}
