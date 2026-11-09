// 権限がない・ログインしていないときに、画面の代わりに表示する（requireUser / requirePermission の結果を渡す）。
//
// 画面の HTTP ステータスは 200 のまま。Next.js で画面から 401 / 403 を返す unauthorized() / forbidden() は
// experimental.authInterrupts（実験的な機能。版の更新で変わりうる）が要るため、標準では使わない。
// 画面のデータは描画されない（page.tsx は guard の結果を確かめてすぐに return する）。ルートハンドラは deniedResponse() で 401 / 403 を返す。
export function AccessDenied({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <meta name="robots" content="noindex" />
      <div role="alert" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-4">
        <h1 className="text-lg font-bold">表示できません</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
