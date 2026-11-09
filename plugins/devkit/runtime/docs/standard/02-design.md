# 2. 設計標準

置き場所と実装の型を決める。見本はテンプレートのサンプル機能（やること。`todos`）で、実際の機能に置き換えた後は、最初に作った機能が見本になる。

## 構成

```
src/
  app/
    page.tsx                     トップ（allowAnonymous で公開を明示）
    layout.tsx・error.tsx・global-error.tsx・not-found.tsx
    (app)/                       DB を読む画面はこの下（layout が force-dynamic。URL に (app) は出ない）
      <画面>/page.tsx            画面（サーバーコンポーネント）。最初の文で requirePermission
      <画面>/actions.ts          データの更新（"use server"）。defineAction だけを書く
      <画面>/components/         その画面だけの部品（"use client" はここ）
    api/health/route.ts          ヘルスチェック（allowAnonymous）
    api/<名前>/route.ts          API。メソッドごとに最初の文で requireUser / requirePermission
  components/                    共通の部品（access-denied.tsx など。"use client" も可）
  server/
    <機能>.ts                    サーバー処理。「Zod で入力検証 → DB 操作」の関数で、Db を引数で受け取る
    action.ts                    defineAction（権限・入力検証・監査ログ・エラーの変換）
    audit.ts                     監査ログ
    auth/permissions.ts          権限表（PERMISSIONS。誰が何をできるか）
    auth/session.ts              ログイン中の利用者（画面と API からは直接呼ばない）
    auth/guard.ts                requireUser / requirePermission / allowAnonymous
    external/                    外部サービスの呼び出し（必要なときだけ）
  db/
    schema.ts                    DB のスキーマ（Drizzle）
    client.ts                    DB の接続（getDb）と Db の型
  lib/
    env.ts                       環境変数の唯一の読み口（loadEnv）
    logger.ts                    構造化ログ
    action-state.ts              Server Action の結果の型と初期値（画面とサーバーで共有）
    security-headers.ts          CSP（next.config.ts と proxy.ts が使う）
  proxy.ts                       リクエストごとの CSP の nonce とリクエスト ID
drizzle/                         生成されたマイグレーション SQL（pnpm db:generate。手で編集しない）
tests/unit/                      単体・結合テスト（PGlite の実物の DB）
e2e/                             E2E テスト（受け入れ基準ごと）
```

## サーバー処理の型

DB を使う処理は `src/server/<機能>.ts` に書く。入力を Zod で検証してから DB を操作し、`Db` は引数で受け取る（テストで PGlite に差し替えるため）。

```ts
export const CreateTodoInput = z.object({
  title: z.string().trim().min(1, "タイトルは必須です").max(200),
});

export async function createTodo(db: Db, input: unknown): Promise<Todo> {
  const { title } = CreateTodoInput.parse(input);
  const [row] = await db.insert(todos).values({ title }).returning();
  if (!row) throw new Error("insert failed");
  return row;
}
```

## データ更新の型（defineAction）

データを更新する Server Action は、`"use server"` のファイルに `export const 名前 = defineAction({ ... })` だけを書く。

```ts
"use server";

export const createTodoAction = defineAction({
  permission: "todos.create",   // 権限表にある権限名を文字列で（SEC-01）
  input: CreateTodoInput,       // Zod スキーマ（SEC-02）
  audit: true,                  // 監査ログに残すか（SEC-07）
  async handler(input, { db }) {
    const todo = await createTodo(db, input);
    revalidatePath("/todos");
    return { message: "登録しました", auditTarget: todo.id };
  },
});
```

defineAction は次の順で処理する: 利用者の確認 → 権限の確認（拒否も監査ログに残す）→ 入力の検証 → 処理と監査ログを1つのトランザクションで → 例外を利用者向けの日本語に変える。handler が受け取る `db` はトランザクションなので、複数のテーブルの更新もそのまま一緒に確定する。handler の中で `redirect()` を呼ばず、移る先は `redirectTo` で返す。

画面からは `useActionState(createTodoAction, initialActionState)` で呼ぶ（`initialActionState` と `ActionState` は `@/lib/action-state` から import する。クライアントコンポーネントは `src/server/` を import しない）。

## 画面と API の入口の型（ガード）

画面（page.tsx）と API（route.ts のメソッドごと）は、関数の**最初の文**で `@/server/auth/guard` のガードを呼び、結果を変数に受ける。**次の文**で `if (!結果.ok)` から抜ける（`return`・`redirect()`・`notFound()`・`throw`）。ガードは拒否を戻り値で返すだけなので、結果を捨てたり確かめなかったりすると、権限がなくても処理が続く。

```tsx
export default async function TodosPage() {
  const access = await requirePermission("todos.read");          // SEC-11
  if (!access.ok) return <AccessDenied message={access.message} />;
  const rows = await listTodos(await getDb());                   // DB は src/server の関数に渡す
  // 更新の操作は can(access.user, "todos.create") のときだけ出す（サーバー側は defineAction が確かめる）
}
```

```ts
export async function GET() {
  const access = await requireUser();
  if (!access.ok) return deniedResponse(access);                 // 401 / 403
}
```

認証なしで公開する画面と API は、`allowAnonymous("理由")` を最初の文に書いて意図を残す（例: トップページ、ヘルスチェック）。理由は空にしない。

- `layout.tsx`・`template.tsx`・`not-found.tsx`・`generateMetadata`・`opengraph-image`・`twitter-image`・`icon`・`sitemap`・`robots`・`manifest` も、DB や `src/server` の処理に触れるなら同じ形にする（ページとは別に動き、データを返せるため）
- メソッドは関数として直接 export する（`export async function GET` か `export const GET = async () => …`）。`export { }`・分割代入・`let` で export しない。例外は Better Auth の認証の API（`src/app/api/auth/[...all]/route.ts` の `export const { GET, POST } = toNextJsHandler(auth)`）だけ
- 画面と API は `src/app/` に置く。`pages/`（Pages Router）と、`src/app/` と並ぶルートの `app/` は使わない（Next.js はルートの `app/` を優先し、`src/app/` を無視する）

## 外部サービスの型

外部 API・メール・ファイル保存の呼び出しは `src/server/external/<相手>.ts` に置き、タイムアウトを必ず付ける（`fetch(url, { signal: AbortSignal.timeout(10_000) })`）。接続先のホストは `docs/profile.json` の `externalHosts` に登録する。外の場所に fetch やネットワークのパッケージ（@aws-sdk/*・nodemailer など）を書くと、標準チェッカーがフラグを出す（ESC-02）。DB の接続（`src/db/client.ts` の `pg`）は例外。

## ルール

- **ARCH-01** 決まった場所に置く（上の構成）
- **ARCH-02** DB アクセスはサーバー処理に閉じる。drizzle-orm・pg・postgres・PGlite の import と `db.select()` などの直接の操作は `src/server/**`・`src/db/**`・テストだけ（`src/` の外のコードも対象）。それ以外で `@/db/*` に触れてよいのは、`import { getDb } from "@/db/client"` を `src/server` の関数の引数に直接渡す形（`listTodos(await getDb())`）と、`@/db/schema` の行の型の `import type` だけ。`getDb()` の結果を変数に入れる・別名で import する・`Db` 型で受けて操作するのは違反
- **ARCH-03** `"use server"` ファイルの export はすべて `export const 名前 = defineAction({ ... })`（1つの `export const` に宣言子を並べたら、すべてこの形）。defineAction は `@/server/action` から import する。関数の中の `"use server"`、`export { }`、`export default`、`export let` / `var`、分割代入の export は使わない
- **ARCH-04** `"use client"` は `src/components/**`・`src/app/**/components/**`・`error.tsx`・`global-error.tsx` だけ。クライアントコンポーネントから `@/server/**`・`@/db/**`・`@/lib/env`・`@/lib/logger` を import しない
- **ARCH-05** `process.env` は `src/lib/env.ts` だけで読む（テストとルートの `*.config.*` を除く。`import * as p from "node:process"`・default import・分割代入・`globalThis` 経由も同じ）。クライアントのコードでは、ビルド時に置き換わる `process.env.NODE_ENV` と `process.env.NEXT_PUBLIC_*` だけを直接読んでよい
- **ARCH-06** 複数のテーブルの更新はトランザクションにする
- **ARCH-07** 外部サービスの呼び出しは `src/server/external/` に置き、タイムアウトを付ける
- **ARCH-08** 例外の内容（メッセージ・スタックトレース・SQL）を画面と API の応答に出さない
- **ARCH-09** `src` では console を使わず `logger` を使う（Biome の `suspicious/noConsole`）
- **ARCH-10** 文言は日本語、日付は `Asia/Tokyo`、入力欄にラベル、エラーは欄の直下（`aria-describedby`）、結果は `role="status"`
- **ARCH-11** コードは検査できる形で置く。シンボリックリンク（`.md` を除く）、NUL を含むコード、5MB を超えるコードは置かない（生成物は `node_modules`・`.next`・`dist`・`build` など、検査から除くディレクトリに出す）。`tsconfig*.json` の `paths` は `{ "@/*": ["./src/*"] }` だけにする（ほかの対応を足すと、検査とビルドで読み込むファイルが変わる）
- **DATA** データモデル（`src/db/schema*.ts`・`drizzle/`）の変更は、技術ゲートでテーブル・列・制約を確かめる。標準チェッカーは変更があれば必ずフラグを出し、どのマイルストーンで技術ゲートを必須にするかはランナーが決める

## 命名

- ファイルは kebab-case（`todo-form.tsx`）、コンポーネントは PascalCase、関数と変数は camelCase
- DB のテーブルと列は snake_case、権限は `<機能>.<操作>`（`todos.create`）。権限表のキーは引用符付きで書く
- 受け入れ基準は `AC-1`、業務ルールは `BR-1`。テスト名に番号を入れる（`[AC-1] 申請すると一覧に「申請中」で出る`）
