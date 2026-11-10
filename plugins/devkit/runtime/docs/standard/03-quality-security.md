# 3. 品質・セキュリティ基準

「完了」と「安全」の基準を決める。目標は OWASP ASVS 5.0 の Level 2 相当。機械で確かめられるものは標準チェッカーとランナーが、確かめにくいものは独立レビューと人間ゲートが確かめる。

## 完了の定義

`pnpm verify` が exit 0 であること。中身は次のとおり。

1. lint と整形（Biome。`pnpm lint`）
2. 型チェック（`pnpm typecheck`）
3. 標準チェック（`pnpm standard:check`。1〜4 層の自動検査）
4. 単体・結合テスト（Vitest。`pnpm test`）

仕上げ（マイルストーンの統合や最終確認）は `pnpm verify:full` で、ビルドと E2E（Playwright）を加える。

ランナーはこれに加えて、作業ごとに次を確かめる: 受け入れ基準とテストの対応（QA-01。実際に実行して合格したテストの名前で照合する）、テストの弱体化（QA-02）、`pnpm verify` を自分で実行した結果（QA-03）、保護ファイルの変更（ESC-05）。そのあと独立レビューを行う。

## テストのルール

- **QA-01** 受け入れ基準 `AC-n` ごとにテストを書き、テスト名に `AC-n` を入れる。画面の流れは E2E
- **QA-02** テストを弱めない（skip・only・todo・fixme の追加、テストや expect の削除、期待値の緩和）。テストが仕様と食い違うと思ったら、変えずに報告する
- **QA-03** 完了の定義は `pnpm verify` の成功。「できた」は、その場で実行した検証の出力で示す
- **QA-04** 業務ルール `BR-n` は単体テストで境界値と例外のケースまで確かめる。DB は PGlite の実物（`createTestDb()`）を使い、モックは外部のものだけにする
- **QA-05** E2E は利用者の目線（ラベル・役割・表示の文字）で要素を探す。自分で作ったデータだけを確かめる

## セキュリティのルール

| ID | ルール | 確かめ方 |
|---|---|---|
| SEC-01 | すべての操作に権限を文字列で指定し、権限表に存在させる（defineAction の引数はその場で書いたオブジェクト。スプレッドや別名で検査を避けない） | 自動検査 |
| SEC-02 | 入力はサーバー側で Zod で検証する（`z.any()`・`z.unknown()` は使わない） | 自動検査 |
| SEC-03 | HTML を直接差し込まない（dangerouslySetInnerHTML・innerHTML への代入など） | 自動検査 |
| SEC-04 | SQL を文字列で実行しない（`sql.raw` とその別名・`sql["raw"]`・文字列や文字列の変数を渡す `.execute(…)` など。src/server も対象）。`sql` のタグ付きテンプレートは可 | 自動検査 |
| SEC-05 | 秘密情報（キー・トークン・パスワード・秘密鍵・Webhook URL・パスワード付きの接続文字列）をリポジトリに書かない。`dbPassword`・`smtpAuth.pass` のような名前への直書きも検出する | 自動検査 |
| SEC-06 | セキュリティヘッダ（nosniff・Referrer-Policy・HSTS・CSP。CSP は object-src 'none'・base-uri・frame-ancestors 'none' を含む）をすべてのパスに付ける | 自動検査 |
| SEC-07 | 監査ログの要否を defineAction に明示する（更新系は audit: true）。処理と監査ログを1つのトランザクションで書くことは独立レビューでも確かめる | 自動検査 |
| SEC-08 | 個人情報の項目を DB に追加したら、保護の方法を確かめる | 変更検出→人間ゲート |
| SEC-09 | 本番で開発用の認証を使わない | 自動検査（リリース前） |
| SEC-10 | ログに個人情報・秘密情報を出さない（logger はキー名で値を伏せるが、それに頼らない） | 独立レビュー（AI） |
| SEC-11 | 画面と API の入口（関数の最初の文）でガードを呼び、次の文で結果（`.ok`）を確かめて抜ける。公開するものは `allowAnonymous("理由")`。DB に触れるレイアウトとメタデータも同じ | 自動検査 |
| SEC-12 | 安全の仕組みの中心（defineAction・監査・認証・環境変数・ロガー・DB 接続・セキュリティヘッダとその読み込み先・proxy・tsconfig・権限表の読み込み先と can()・配布・CI・標準）を変えたら差分を確かめる。差分が取れないときも確かめる | 変更検出→人間ゲート |

標準チェッカーは、よくある抜け道（`src/` の外に置いたコード、相対パスでのスキーマの import、関数の中の `"use server"`、1つの `export const` に並べた宣言子、`export { }` でのまとめた公開、defineAction の別名、ガードの結果を確かめないこと、文字列の SQL、シンボリックリンク、`tsconfig` の `paths` での読み替え、`.gitattributes` で差分を隠すことなど）も検出する。検査できないもの（読めないファイル・取れない差分）は、違反か技術ゲートでの確認に倒す。ただし、すべての書き方を網羅するものではない。検出できない書き方で規約を避けることは禁止で、独立レビューと技術ゲートで確かめる。

## ASVS Level 2 との対応

| ASVS の領域 | この標準で受け持つもの |
|---|---|
| エンコードと無害化 | SEC-03（React の表示に任せる）、SEC-04（プレースホルダ） |
| 入力の検証と業務ロジック | SEC-02（Zod）、QA-04（業務ルールの境界のテスト） |
| Web フロントエンドの安全 | SEC-06（CSP・HSTS など）、ARCH-04（サーバーのコードをブラウザに出さない） |
| 認証・セッション | Better Auth（HttpOnly・Secure・SameSite の Cookie）、SEC-09 |
| 認可 | SEC-01・SEC-11（権限表で決め、画面と更新の両方で確かめる）、ESC-03 |
| 設定と秘密情報 | SEC-05、ARCH-05（環境変数の検証）、SEC-12 |
| データの保護 | SEC-08、SEC-10、`docs/profile.json` の personalData |
| ログとエラー処理 | SEC-07（監査ログ）、ARCH-08、ARCH-09、SEC-10 |
| 安全な構成 | ARCH-02・ARCH-07（DB と外部連携の置き場所）、ESC-02（外部の接続先） |

## 認証と認可

- 認証は Better Auth（ID・パスワード、社内 SSO は OIDC で Microsoft Entra ID / Google Workspace / LINE WORKS）。セッションは HttpOnly・Secure・SameSite の Cookie で、トークンをブラウザの JavaScript に持たせない
- 認証の方式は `AUTH_MODE`（`src/lib/env.ts`）で決まる。`dev` は開発用の利用者（役割は Cookie か `DEV_AUTH_ROLE` で切り替える）、`none` は誰もログインしていない扱い、`better-auth` は本番の認証
- 開発用の利用者が働くのは `next dev` と E2E 用のビルドだけ。E2E 用のビルドは、ビルドのときの `DEVKIT_E2E_AUTH=1`（playwright.config.ts だけが付ける。出力先も分ける）で決まり、起動時の環境変数では有効にできない。通常の `pnpm build` のビルドでは、`AUTH_MODE=dev` で起動しても誰もログインしていない扱いになる（エラーで止めず、安全側に倒す）
- `AUTH_MODE=dev` と `DEVKIT_E2E_AUTH` は、デプロイの設定（Dockerfile・compose・`.env.production*`・deploy / infra / terraform / k8s / helm）と、本番のビルドと起動のスクリプト（package.json の build・start と、Dockerfile から呼ぶもの）に書かない。CI のテスト（`.github/workflows`）で使うのは可。リリース前の検査（SEC-09）が検出する
- リリース前の検査は、`docs/profile.json` の `auth` と実装が合っているかも確かめる。`better-auth`・`sso-entra`・`sso-google`・`sso-lineworks` なら、better-auth が dependencies にあり、`src/server/auth/session.ts`（かそれが読む `src/server/auth/` のモジュール）が Better Auth を使っていること。`dev` のままではリリースできない。`none`（認証なしの公開）は標準の例外承認（rules: SEC-09、subject: `auth:none`）が必要
- 認可は権限表（`src/server/auth/permissions.ts`）だけで決める。画面の入口（SEC-11）とデータの更新（SEC-01）の両方で確かめ、画面でボタンを隠すだけにしない
- 社外の利用者や複数の取引先が使う場合は、データの範囲（自社のデータしか見えない）を受け入れ基準に入れてテストする
