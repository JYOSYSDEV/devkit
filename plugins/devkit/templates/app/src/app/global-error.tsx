"use client";

import "./globals.css";

// ルートレイアウトでエラーが起きたときの表示（ルートレイアウトの代わりに html と body を持つ）。
// エラーの内容（メッセージやスタック）は画面に出さない。digest はサーバーのログと突き合わせるための番号。
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    error && typeof error === "object" && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;

  return (
    <html lang="ja">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <title>エラーが発生しました</title>
        <main className="mx-auto max-w-2xl space-y-4 p-8">
          <h1 className="text-2xl font-bold">エラーが発生しました</h1>
          <p>処理中に問題が起きました。時間をおいてもう一度お試しください。</p>
          {digest && <p className="text-sm text-gray-600">問い合わせ番号: {digest}</p>}
          <button
            type="button"
            onClick={() => retry()}
            className="rounded bg-blue-700 px-4 py-2 font-medium text-white"
          >
            もう一度試す
          </button>
        </main>
      </body>
    </html>
  );
}
