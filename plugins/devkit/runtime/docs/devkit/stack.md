# 標準技術スタック

社内の業務 Web アプリ（申請・承認、台帳管理、ダッシュボード、社内ポータルなど）を対象にした標準です。選定の基準は **Claude Code が迷わず正しく書ける量の多さ**、**部品の少なさ**、**テストのしやすさ** の3つです。

## 採用一覧（2026年11月時点で動作確認済みのバージョン）

| 用途             | 採用                         | バージョン               | 選んだ理由                                                        |
| ---------------- | ---------------------------- | ------------------------ | ----------------------------------------------------------------- |
| 言語             | TypeScript（strict）         | 6.0                      | 型が仕様の一部として働き、AI の誤りを早く検出できる               |
| 実行環境         | Node.js LTS / pnpm           | 24（22.12 以上で可）/ 10 | 作業ディレクトリごとの install が速い（pnpm のストア共有）               |
| フレームワーク   | Next.js（App Router）        | 16                       | 画面と API を1つのアプリで書ける。情報量が最も多い                |
| UI               | Tailwind CSS + shadcn/ui     | 4                        | 部品をコピーして持つ方式で、外部依存が少ない                      |
| DB | PostgreSQL + Drizzle ORM | 17 / 0.45 | スキーマが TypeScript で、コード生成の手順がない。開発用は Docker Compose で起動（`pnpm db:setup`） |
| テスト用 DB | PGlite | 0.5 | インプロセスの PostgreSQL 17。自動テストと E2E で使う。Docker 不要で、並列の作業ディレクトリや検証のコンテナでも衝突しない |
| 入力検証         | Zod                          | 4                        | フォーム・API・環境変数を同じ書き方で検証できる                   |
| 単体・結合テスト | Vitest                       | 5                        | 速い。Jest と同じ書き方                                           |
| E2E テスト       | Playwright                   | 1.65                     | 画面の流れを確かめる最終関門                                      |
| 整形・lint       | Biome                        | 2.6                      | 1つのツールで完結し、速い                                         |
| CI               | GitHub Actions               | -                        | `pnpm verify` → ビルド → E2E                                      |
| 配布             | Docker（Next.js standalone） | -                        | デプロイ先（AWS / Google Cloud / Azure / 社内基盤）を選ばない     |

## 必要になったら使う標準

最初から入れず、必要になったノードで基盤ノードに追加します（依存の追加は共有ファイルの変更なので）。

| 用途                 | 標準                                                | 補足                                                                                                                                                                 |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 認証                 | Better Auth                                         | Auth.js の開発チームは 2025年9月に Better Auth に合流した。社内 SSO は OIDC（Microsoft Entra ID / Google Workspace）で接続する。資格情報が要るので人間ゲートを付ける |
| 権限                 | 権限表 `src/server/auth/permissions.ts` + 入口のガード `src/server/auth/guard.ts` + `defineAction` | 画面ではなくサーバー処理の入口で必ず確認する（社内標準 SEC-01・SEC-11）                                                                                                                         |
| フォーム             | React 19 の `useActionState` + Server Actions + Zod | クライアントのフォームライブラリは原則使わない                                                                                                                       |
| 日付                 | `date-fns` + `@date-fns/tz`                         | 表示は `Asia/Tokyo`                                                                                                                                                  |
| メール送信           | 社内の SMTP を `nodemailer` で                      | 送信先・資格情報が要るので人間ゲート                                                                                                                                 |
| ファイル保存         | S3 互換ストレージ（`@aws-sdk/client-s3`）           | 開発時は MinIO                                                                                                                                                       |
| ログ                 | `pino`                                              | 構造化ログ（JSON）                                                                                                                                                   |
| 定期実行・非同期処理 | まず cron（デプロイ先のスケジューラ）+ API ルート   | キューが必要になったら ADR を書く                                                                                                                                    |

## AI がよく間違える点（kickoff と実装の前に読む）

- **Next.js 16** では `middleware.ts` は `proxy.ts` に変わり、`proxy` という名前の関数を export する。`params` / `searchParams` / `cookies()` / `headers()` は Promise なので `await` する。`next lint` はないので lint は Biome。
- **Next.js はリクエスト時の API を使わない画面を `next build` でプリレンダリングする**（既定の動き。DB の読み取りはリクエスト時の API に数えられない）。DB を読む画面をそのまま作ると、ビルド中に DB へ接続しようとして失敗するか、ビルド時点のデータで固定された画面になる。DB を読む画面は `src/app/(app)/` の下に置く（このグループの layout が `export const dynamic = "force-dynamic"`）。ルートハンドラで DB を読むときも `force-dynamic` を付ける。外に置いた場合は、ビルド中に `getDb()` が原因の分かるエラーで止める。`cacheComponents` を有効にすると `dynamic` の指定は使えなくなるので、有効にするなら ADR を書いて方式を決め直す。
- **Tailwind CSS v4** には `tailwind.config.js` がない。CSS の `@import "tailwindcss";` と `@theme` で設定する。
- **Zod 4** では `z.email()`・`z.url()` のようにトップレベルの関数を使う（`z.string().email()` は非推奨）。
- **React 19** のフォームは `useActionState`（`useFormState` は古い名前）。
- **Drizzle** のスキーマ変更は `pnpm db:generate` でマイグレーションを作ってコミットする。`drizzle-kit push` は本番で使わない。
- **TypeScript 7**（ネイティブ版）はまだ採用しない。Next.js のビルドが TypeScript の JS API を使うため。
- DB を使うテストは必ず `createTestDb()`（PGlite）で書く。開発用の PostgreSQL（Docker）に依存させない。E2E のサーバーは `pglite://memory` で起動する（playwright.config.ts）。
- E2E のサーバーは1つのメモリ上の PGlite を全テストで共有するので、テストは1つずつ順に実行する（`workers: 1`）。各テストは自分で作ったデータ（固有の名前など）だけを確かめ、ほかのテストのデータの有無に依存しない。サーバーは作業ディレクトリごとに別のポートで起動し、すでに動いているサーバーは使わない。
- Vitest は `.test.ts` と `.test.tsx` を実行する。環境は node なので DOM は使えない。画面の振る舞いは E2E で確かめる。
- `DATABASE_URL` が未設定のとき、開発は Docker Compose の PostgreSQL、テストはメモリ上の PGlite に接続する。本番は未設定なら起動に失敗する（`src/lib/env.ts`）。

## 標準から外れるとき

`docs/adr/_template.md` を使って ADR を書き、人間の承認を得てから採用します。kickoff は、標準外の技術が必要な場合はその採否を人間ゲートにします。

## 別のスタックにしたいとき

devkit の4層（`.claude/`、`.devkit/`、`scripts/devkit/`、`docs/devkit/`）はスタックに依存しません。別のスタックの標準を作るときは、アプリ部分を差し替え、`package.json` の `verify` スクリプト（lint・型チェック・テストを1コマンドで）と、CLAUDE.md・この文書の表を書き換えます。goal 条件は `pnpm verify` を証明方法にしているので、そのまま使えます。
