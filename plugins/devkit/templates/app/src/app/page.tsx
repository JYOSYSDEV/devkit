import Link from "next/link";
import { allowAnonymous } from "@/server/auth/guard";

export default function Home() {
  allowAnonymous("案内だけのページで、データを表示しない");
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">devkit app</h1>
      <p className="mt-4 text-gray-600">
        このページは雛形です。Claude Code に作りたいものを伝えると、計画（.devkit/）が作られ、ここから実装が進みます。
      </p>
      <p className="mt-4">
        <Link href="/todos" className="text-blue-700 underline">
          サンプル機能（やること）
        </Link>
      </p>
    </main>
  );
}
