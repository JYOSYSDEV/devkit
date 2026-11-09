import Link from "next/link";

// 存在しない URL のときの表示
export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-bold">ページが見つかりません</h1>
      <p>URL を確かめてください。</p>
      <Link href="/" className="text-blue-700 underline">
        トップページへ
      </Link>
    </main>
  );
}
