import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "devkit app",
  description: "devkit 標準テンプレートから作成したアプリ",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // すべての画面をリクエスト時に描画する。CSP の nonce（src/proxy.ts）はリクエスト時の描画でしか付かず、
  // ビルド時に作った静的な画面のスクリプトは CSP で止まってしまうため。
  await connection();
  return (
    <html lang="ja">
      <body className="min-h-screen bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
