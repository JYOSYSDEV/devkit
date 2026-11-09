# このリポジトリでの作業ルール

社内標準の開発キット **devkit** で作られたリポジトリです。開発は「仕様と計画 → 人の承認 → ランナーが作業ごとに実装・機械検証・独立レビュー・統合 → 人間ゲート」で進めます（解説: `docs/devkit/model.md`）。技術の判断は社内標準 `docs/standard/` に従います。

## 最初に判断すること

- **開発の指示**（新しいシステム、機能追加、複数ファイルにまたがる改修）を受けたら、コードを書く前に **devkit-kickoff スキル** で仕様と計画を作る。
- **小さな修正**（1〜2ファイル、バグ1件、文言修正）は計画なしで、`devkit-tdd` の手順（不具合なら先に `devkit-debugging`）で直し、`pnpm verify` を通してコミットする。
- **ランナーが実行中**（セッション開始時の `[devkit]` 表示や `pnpm -s devkit status` で分かる）は、計画・テスト・設定ファイルを変更しない。状況の確認と案内だけを行う（`devkit-status`・`devkit-gate-review`）。
- 「始めて」「続けて」「夜のあいだ回して」「止めて」は **devkit-run スキル**。

## devkit のスキル

| 場面 | 使うもの |
| --- | --- |
| 開発の指示を受けた | `devkit-kickoff`（要件の聞き出しは、その中で `devkit-requirements`） |
| ランナーを起動・再開・停止する | `devkit-run` |
| 進捗・止まった理由・誰の番か | `devkit-status` |
| 人間ゲート・判断依頼の確認を手伝う | `devkit-gate-review` |
| 実装する（計画の外の小さな修正でも） | `devkit-tdd` |
| テストの失敗・不具合・原因の分からない振る舞い | `devkit-debugging` |
| 完了・成功を言う前、コミット・PR の前 | `devkit-verification` |
| 自走がうまくいかなかった理由を調べる | `devkit-diagnose` |
| 標準の例外・標準の改訂案・devkit の更新（標準オーナー） | `devkit-standard-exception`・`devkit-standard-feedback`・`devkit-update` |

ランナーが起動する担当（エージェント）: `implementer`（作業の実装）、`reviewer`（独立レビュー）、`replanner`（再計画の案）、`final-reviewer`（最終レビュー）。kickoff で使う担当: `spec-reader`（仕様書の読み合わせ）、`plan-reviewer`（計画のレビュー）。

## 必ず守ること

1. 「できた」は、その場で実行した検証コマンドの出力で示す（`devkit-verification`）。標準は `pnpm verify`（lint・型チェック・標準チェック・テスト）。仕上げは `pnpm verify:full`（ビルドと E2E を加える）。
2. テストの削除・skip・期待値の緩和で検証を通さない。テストが仕様と食い違うと思ったら、変えずに報告する。
3. 受入基準 `AC-n` と業務ルール `BR-n` は、番号をテスト名に入れたテストで確かめる（ランナーは、実行されて合格したテストの名前で照合する）。
4. 技術は社内標準（`docs/standard/`）から外れない。外れる必要があれば実装せずに判断依頼を出し、標準オーナーの例外の承認を得る（`docs/standard/05-exceptions.md`）。
5. 本番デプロイ、既定のブランチ（`main` など）への push、シークレット（`.env`）の操作はしない。人が行う。
6. 人の判断（計画とマイルストーンの承認、差し戻し、判断依頼への回答、再計画の案の承認、標準の例外の登録、サイクル上限の追加）は、人が端末で行う。自分から実行せず、利用者に実行するコマンドを伝える（フックとコマンド自身が止める）。
7. `.devkit/state.json`・`.devkit/controls.json`・`docs/decisions.md`・`docs/exceptions.json`・社内標準・devkit 自身（`scripts/devkit/`・`scripts/standard/`）は直接編集しない（フックが止める）。計画（`.devkit/graph.json`）を書き換えるのは kickoff と、人と相談した再計画のときだけ（承認の後に変えると、もう一度承認が要る）。
8. 未コミットの作業やブランチを失う操作（`git checkout -- .`、`git restore`、`git clean -f`、`git stash drop`、`git branch -D`、強制 push）はしない（フックが止める）。

## 標準技術スタック（詳細: `docs/devkit/stack.md`）

| 用途           | 採用                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| 言語・実行環境 | TypeScript（strict）/ Node.js 24 LTS / pnpm                                                         |
| Web・API       | Next.js（App Router）。画面は Server Components、更新は Server Actions（`defineAction`）か `src/app/api/**/route.ts` |
| UI             | Tailwind CSS v4、部品は shadcn/ui（`pnpm dlx shadcn@latest add <name>`）                            |
| DB | PostgreSQL 17 + Drizzle ORM。開発は Docker Compose の PostgreSQL、自動テストと E2E はメモリ上の PGlite（同じ PostgreSQL 17 系） |
| 入力検証       | Zod（フォーム・API・環境変数のすべて）                                                              |
| テスト         | Vitest（単体・結合）、Playwright（E2E）                                                             |
| 整形・lint     | Biome                                                                                               |
| CI / 配布      | GitHub Actions / Docker（Next.js standalone）                                                       |

## コマンド

| コマンド                                | 用途                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `pnpm db:setup` | 開発用 PostgreSQL の起動とマイグレーション（人が実行する。確認が出る） |
| `pnpm dev` | 開発サーバー（先に `pnpm db:setup`） |
| `pnpm verify`                           | lint + 型チェック + 標準チェック + テスト（goal 条件の標準の証明方法） |
| `pnpm verify:full`                      | verify + ビルド + E2E                                   |
| `pnpm db:generate`                      | スキーマ変更からマイグレーションを生成（`drizzle/`）    |
| `pnpm -s devkit status` / `next` / `check` / `logs` | 状況（ランナーの生死・誰の番か）・次の作業・計画の検査・ログの要約 |
| `pnpm devkit run [--until 07:00 --detach]` | ランナーの起動（devkit-run スキル） |
| `pnpm standard:check` / `pnpm standard:release` | 社内標準の検査 / リリース前検査 |
| `pnpm -s devkit shared` | ノードの owns にできない共有ファイルの一覧 |

## コードの書き方

置き場所（サンプル機能 `todos` が同じ形で書いてある。新しい機能はこれをまねる）:

| 置くもの | 場所 |
| --- | --- |
| 業務の処理（Zod で入力検証 → DB 操作。`Db` を引数で受け取る） | `src/server/<機能>.ts` |
| 画面（DB を読む） | `src/app/(app)/<機能>/page.tsx` |
| データを更新する Server Action | `src/app/(app)/<機能>/actions.ts`（`defineAction` だけを書く） |
| フォームなどのクライアントコンポーネント（`"use client"`） | `src/app/(app)/<機能>/components/` か `src/components/` |
| 外部のサービス（API・メールなど）の呼び出し | `src/server/external/<相手>.ts` |
| 権限表（役割の一覧は `roles.ts`） | `src/server/auth/permissions.ts` |

- **更新は `defineAction`**（`src/server/action.ts`）。`"use server"` のファイルには `export const xxx = defineAction({ permission, input, audit, handler })` だけを書く。defineAction が「利用者の確認 → 権限の確認（拒否は監査ログに残す）→ Zod の入力検証 → handler と監査ログを1つのトランザクションで → 例外を日本語のメッセージに」を必ずこの順で行う。handler は `ctx.db`（トランザクション）を `src/server/<機能>.ts` の関数に渡すだけにする。利用者に見せてよい業務エラーは `ActionError` を throw する。保存後に別の画面へ移るときは、handler の中で `redirect()` を呼ばず（トランザクションが取り消される）`redirectTo` を返す。画面側は `useActionState(action, initialActionState)`（`@/lib/action-state`）で呼ぶ。フォームの値は入力スキーマに合わせてオブジェクトになる（スキーマが配列の項目は、チェックが1つでも0個でも配列。FormData 以外で呼ばれたら入力の誤りとして拒否を記録する）。
- **画面とルートハンドラの入口**: すべての `page.tsx` と、`route.ts` の各メソッドの先頭で、`src/server/auth/guard.ts` の `requirePermission("<権限>")` か `requireUser()` を呼び、`ok` でなければ画面は `<AccessDenied message={access.message} />`、ルートハンドラは `deniedResponse(access)` を返す（`if (!access.ok) return …` の形で、確かめたらすぐに抜ける）。画面の HTTP ステータスは 200 のまま（403 を返す `forbidden()` は Next.js の実験的な機能なので使わない。`src/components/access-denied.tsx`）。認証なしで公開するものは `allowAnonymous("理由")` を書く。表示を権限で変えるときは `can(user, "<権限>")`（例: 登録欄は登録の権限がある人にだけ出す。それでも更新の権限は defineAction が確かめる）。
- **権限表**: 役割は `src/server/auth/roles.ts` の `ROLES`（E2E の設定もここから読む）、権限は `PERMISSIONS`（キーは `"<機能>.<操作>"` を引用符付きで書く。値はできる役割）。仕様書の「権限表」と一致させ、`tests/unit/permissions.test.ts` の表も同じに直す。役割や権限の変更は業務の判断なので、人間の確認を受ける。
- **監査ログ**: 登録・更新・削除・権限の変更は `audit: true` にする（`audit_logs` 表に、誰が・いつ・何を・対象の ID が残る）。権限のない操作の試みは defineAction が自動で残す（同じ利用者・同じ権限は60秒の枠で1行にまとめて回数を数える）。監査ログには ID だけを入れ、入力値や個人情報は入れない。
- **ログ**: `src/lib/logger.ts` の `logger.info("イベント名", { ...ID など })` を使い、`console` は使わない。個人情報・入力値・例外のメッセージを渡さない（DB の例外のメッセージは SQL の値を含む。defineAction はエラーコードと制約名だけを残す）。`getDb()` の Db が投げる例外は、値を含まない `DbError`（SQLSTATE・制約名・表名・列名だけ）に包み直される（`src/db/errors.ts`）ので、画面やルートハンドラで DB の例外が起きても Next.js のログに入力値は出ない。`email`・`name`・`password`・`token` などのキーの値は自動で伏せられるが、それに頼らない。自分で投げる例外のメッセージにも入力値や個人情報を入れない。
- **開発用の利用者**: `AUTH_MODE=dev`（開発の既定）では「開発用ユーザー」としてログインした扱いになり、役割はブラウザの Cookie `devkit-dev-role`（`admin` など）か `DEV_AUTH_ROLE` で切り替える。これが働くのは `pnpm dev`（127.0.0.1 で待ち受ける）と、Playwright が作る E2E 用のビルド（`DEVKIT_E2E_AUTH=1` で `.next-e2e/` に作り、127.0.0.1 で起動する）だけ。E2E 用のビルドでは、Playwright が起動のたびに作るトークン（ビルドに埋め込む）の Cookie `devkit-e2e-token` も要るので、残った `.next-e2e/` を別に起動しても開発用ログインは使えない（Cookie は `playwright.config.ts` が入れる）。E2E 用のビルドで役割の一覧にない役割名の Cookie を送るとエラーになる。`pnpm build` したもの（Docker イメージを含む）では、環境変数や Cookie がどうであってもログインしていない扱いになる（ビルド時に値が埋め込まれる。`src/lib/env.ts` の `devAuthBuildEnabled`）。Dockerfile・compose.yaml・本番の環境変数に `AUTH_MODE=dev` や `DEVKIT_E2E_AUTH` を書かない。
- **セキュリティヘッダー**: `next.config.ts` がすべての応答に付け、`src/proxy.ts` が画面ごとに nonce 入りの CSP（`src/lib/security-headers.ts`）に置き換える。nonce はリクエスト時の描画でしか付かないので、ルートレイアウトが全画面をリクエスト時の描画にしている（`await connection()` を消さない）。外部の画像・スクリプト・API を使うときは CSP に host を足す必要がある（仕様書の「個人情報と外部連携」に書き、人間の確認を受ける）。
- DB を読む画面は `src/app/(app)/` の下に置く（このグループは `force-dynamic`）。Next.js はリクエスト時の API を使わない画面を `next build` でプリレンダリングするので、外に置くとビルド中に DB へ接続しようとして `getDb()` がエラーで止める。ルートハンドラで DB を読むときも `export const dynamic = "force-dynamic"` を付ける。
- DB スキーマは `src/db/schema.ts`。変更したら `pnpm db:generate` でマイグレーションを作り、生成された SQL もコミットする。
- 環境変数は `src/lib/env.ts` で検証してから使う。`src/` の中で `process.env` を読んでよいのは `src/lib/env.ts` だけ。本番（`NODE_ENV=production`）では起動時に検証し、`DATABASE_URL` がないなど誤りがあれば起動しない（`src/instrumentation.ts`）。新しい環境変数は `EnvSchema` に足す。
- テストは `tests/unit/`（関数単位）と `e2e/`（画面の流れ）。DB を使うテストは `tests/helpers/test-db.ts` の `createTestDb()`（PGlite）を使い、開発用の PostgreSQL に依存させない。Server Action は `executeAction(def, { db, user }, 入力)` で権限・入力検証・監査ログまで確かめられる（`tests/unit/action.test.ts`）。
- E2E は `@playwright/test` ではなく `e2e/fixtures.ts` から `test` と `expect` を import する（CSP 違反でテストが失敗する。役割は `asRole(context, "viewer", baseURL)` で切り替える）。`E2E_SCREENSHOT_DIR` を指定すると、最後の画面を `<ファイル名 - describe - テスト名>.png` で保存する。
- 画面の文言は日本語。日付は `Asia/Tokyo` で表示する。
- Next.js の API は学習時の知識と変わっていることがある。迷ったら `node_modules/next/dist/docs/` の同梱ドキュメント（インストール済みのバージョンと一致）を読む。`AGENTS.md` は `next dev` が自動で書き戻すファイルなので消さない。

## このプロジェクトで学んだこと

@.devkit/learnings.md
