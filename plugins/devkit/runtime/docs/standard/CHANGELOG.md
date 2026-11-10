# 変更履歴

## 2026.11.3（LINE WORKS の SSO と、パスキーの公開鍵の置き場所）

- 認証: 社内 SSO に LINE WORKS（OAuth 2.0 + OpenID Connect）を加えた。`docs/profile.json` の `auth` に `sso-lineworks` を書ける（Better Auth の汎用の OIDC で受ける。リリース前検査の扱いは `sso-entra`・`sso-google` と同じ）
- `owners.json`（標準オーナーの名前・メール・パスキーの公開鍵）と `hub.json`（ハブの origin と rpId）を加えた。パスキーで署名された決定を、案件の側で確かめるために使う（devkit の ADR-0008）。どちらも空で配り、ハブを置くときに標準オーナーが書いて版を上げる
- ルールの追加・変更はない（47 件のまま）

## 2026.11.2（独立レビューの指摘を直した版）

標準チェッカーの独立レビューで見つかった抜け道と誤検出を直した。ルールは 47 件（ARCH-11 と DEPS を加えた）。

抜け道をふさいだ変更:

- SEC-11: ガードを呼ぶだけでは合格にしない。結果を変数に受け、次の文で `if (!結果.ok)` から return / redirect() / notFound() / throw で抜けることを確かめる。結果を捨てる・分割代入するのは違反。layout・template・not-found・generateMetadata・opengraph-image・twitter-image・icon・sitemap・robots・manifest も、DB や src/server の処理に触れるなら対象にした。メソッドの分割代入・let の export は違反（Better Auth の `export const { GET, POST } = toNextJsHandler(auth)` だけは app/api/auth/ の下で可）。pages/ と、src/app と並ぶルートの app/ は違反
- 検査の範囲: src の外のコード（ルートの actions/ など）も検査する。テストとして扱うのは `*.test.*`・`*.spec.*` とルート直下の tests/・e2e/ だけ（src/app/(app)/tests/ や src/app/api/e2e/ はアプリのコード）
- ARCH-11（新規）: シンボリックリンク・NUL を含むコード・5MB を超えるコード・読めないディレクトリを違反にする（読み飛ばさない）。tsconfig*.json の paths に `@/*` 以外の対応を足すのも違反
- ARCH-03: `export const a = defineAction(…), b = …` の宣言子をすべて検査する。export let / var と分割代入の export は違反
- ARCH-02: src/server・src/db の外で @/db/* に触れてよいのは、`import { getDb } from "@/db/client"` を src/server の関数の引数に直接渡す形（`listTodos(await getDb())`）と、@/db/schema の `import type` だけにした。変数に入れる・別名にする・Db 型で受けて操作するのは違反
- SEC-04: src/server でも、文字列の変数の実行、`sql["raw"]`、分割代入の raw、再公開した別名の `q.raw(…)` を検出する
- SEC-05: dbPassword・smtpAuth.pass のような camelCase の名前への直書き、Stripe の `sk_live_` など、src の外の設定ファイル（drizzle.config.prod.ts など）を検出する。NUL を含むファイル・20MB を超えるファイルは違反
- ESC-02: 行頭のコメントの後の fetch、`"$schema"` と同じ行の URL、public/ の JS、`globalThis.fetch` の別名、child_process、`new window.WebSocket`、.env のクオートなしのホストを検出する
- SEC-12: src/lib/security-headers.ts と next.config・proxy が読み込むファイル、tsconfig*.json、権限表が読み込むファイル、can() の実装の変更、シンボリックリンクの追加を加えた。権限表が読み込むファイルの変更は ESC-03（業務ゲート）にもする
- TECH-01・TECH-02: ワークスペースのサブパッケージの package.json、pnpm-workspace.yaml の overrides と catalog（catalog: の参照も解決する）、pnpm.packageExtensions、patchedDependencies、onlyBuiltDependencies（dependencies.json の builtDependencies に加えた esbuild など）、.pnpmfile.cjs を検査する
- DEPS（新規のフラグ）: `--base` のとき、依存の追加と版の変更、pnpm の設定・overrides・resolutions・packageManager・pnpm-workspace.yaml・.npmrc の変更を技術ゲートに回す
- OPS-04: SQL の文字列を先に除いてからコメントを消す（`'--'` の後ろの DROP が隠れない）。ADD と並べた DROP、COLUMN を省いた ALTER … DROP / TYPE、DROP FUNCTION・TRIGGER・POLICY など、$$ の中と EXECUTE の文字列も検査し、中身を読めない動的な SQL は違反にする
- SEC-08: address1・tel1 などの番号付きの列、sei・mei、contact（jsonb を含む）、`pgTable(` の後で改行する書き方を検出する
- 出力: 大きな JSON をパイプに書いた直後に終わって途中で切れることがあったので、書き切ってから終える
- findRoot: git のルートより上には上らない（標準がなければ終了コード 2）

誤検出を直した変更:

- TECH-03: `ARG NODE_VERSION=24` と `FROM node:${NODE_VERSION}` を解決する
- ARCH-05: クライアントのコードの `process.env.NODE_ENV` と `process.env.NEXT_PUBLIC_*` は可（`import * as p from "node:process"` や default import の env は違反にした）
- ARCH-02: DB を読み込まないファイルの `db.transaction`（IndexedDB など）は対象外
- SEC-04: 正規表現の `.exec(…)` は対象外
- SEC-05: 手順書の `postgres://USER:PASSWORD@HOST/…` のようなプレースホルダ、compose の開発用 DB サービスの接続文字列、テストの中の接続文字列、Cookie の名前などは対象外
- OPS-04: 列名 "truncate" のような、引用符の中の識別子は対象外
- SEC-09: `ENV AUTH_MODE dev`（旧い書き方）も検出し、コメントのある Dockerfile でも行番号がずれない
- テキストの出力の「自動検査 N 項目」は、フラグを数えない

## 2026.11.1（claude-devkit の標準を devkit-template の構成に統合）

devkit v4 で、claude-devkit v2.0.0 の社内標準（2026.11.0）を、devkit-template v3 のテンプレート（Next.js App Router・pnpm・`src/server/` と `src/db/`・PGlite）の構成に合わせて移した。ルールの考え方は 2026.11.0 と同じで、パスと確かめ方を新しい構成に合わせ、レビューで見つかった抜け道をふさいだ。

構成に合わせた変更:

- 技術の出典を `docs/devkit/stack.md` にした。許可リスト（dependencies.json）の core はテンプレートの package.json、preApproved は stack.md の「必要になったら使う標準」と shadcn/ui の部品が使うパッケージ。名前のパターン（`@radix-ui/react-*`）に対応した
- パッケージマネージャーを pnpm（`pnpm-lock.yaml`・`packageManager`）、Node.js の版のファイルを `.nvmrc`（なければ `.node-version`）にした
- DB アクセスの置き場所を `src/server/**`・`src/db/**`・テストにした（2026.11.0 の `features/<機能>/repository.ts` に当たるのは `src/server/<機能>.ts`）
- ランナーが確かめるルール（QA-01〜03・ESC-05）の確かめ方を `runner` にした
- データモデルの変更を技術ゲートに回すフラグ `DATA` を加えた（ルールは 45 件）
- `docs/profile.json` の担当者を `owners.business` / `owners.technical`（名前とメール）にし、`personalData` を加えた
- 開発用の認証の指定を `AUTH_MODE=dev` と、E2E 用のビルドだけで使う `DEVKIT_E2E_AUTH` にした

抜け道をふさいだ変更:

- TECH-02: `pnpm.overrides`・`overrides`・`resolutions` も完全固定を求め、git・URL・ファイル・`npm:` の別名の指定を拒む
- TECH-03: Dockerfile の node イメージのメジャー版も確かめる
- SEC-01: defineAction の別名・値としての受け渡し・計算されたキー・重複したキーを拒む。権限表は `PERMISSIONS` のオブジェクトの中だけを読む
- SEC-05: Slack の Webhook URL、パスワード付きの接続文字列（localhost の開発用は除く）、Google の API キー、Microsoft Entra ID のクライアントシークレットを加えた。バイナリ・ロックファイル・node_modules は読まない
- SEC-06: ヘッダは `headers()` の定義（参照している定数と、import した関数をたどる）の中だけで確かめ、コメントは除く。Strict-Transport-Security と、CSP の `object-src 'none'`・`base-uri`・`frame-ancestors 'none'` を必須にした
- SEC-09: Dockerfile・compose・`.env.production*`・deploy / infra / terraform / k8s / helm の中の `AUTH_MODE=dev` と `DEVKIT_E2E_AUTH`、本番のビルドと起動のスクリプトの中の指定を検出する（`.github/workflows` の CI のテストは対象外）
- SEC-11: ガードは関数の最初の文で呼ぶことにした。メソッドを `export { }` でまとめて公開する書き方を拒む
- OPS-03: Dockerfile の CMD / ENTRYPOINT、compose の command、package.json の start でのマイグレーションも検出する
- OPS-04: 破壊的な変更に TRUNCATE・DELETE・制約や型・ビュー・インデックスの削除を加えた。リリース済みのマイグレーションのファイルの変更・削除を、差分（`--base`）で違反にする
- SEC-08: 「人 + 名前・番号・コード」の列名（borrower_name・employee_no・staff_code）とローマ字（shimei・jusho・denwa など）を、テーブル名に関係なく検出する
- ESC-02: ネットワークを使うパッケージ（@aws-sdk/*・pg・nodemailer・axios など）の `src/server/external/` の外での import を検出する
- SEC-12: ロガー・Dockerfile・compose・`.github/`・`.gitattributes`・案件プロファイル・例外・標準そのものも安全の仕組みの中心に加えた
- ESC-06: 日付は実在する日付だけを認め、ESC-06 自体は例外にできない。案件の外の ADR は認めない
- 差分は `git diff --text --no-ext-diff --no-textconv --no-renames` で取り、`.gitattributes` の `-diff` でも行を隠せない。`--base` の値がない・空・コミットでない、git が失敗した、のどれでも SEC-12 のフラグにして人の確認に倒す
- 検査そのものが失敗したルールは違反として扱う。CRLF・BOM・空白を含むパス・Windows のパスでも止まらない

## 2026.11.0（初版。claude-devkit v2.0.0）

- 5層の標準（技術・設計・品質とセキュリティ・運用・例外）を制定
- ルール 44 件。うち自動検査 23 件（リリース前の検査 2 件を含む）と変更検出 4 件を標準チェッカーで実装
- 運用レベル Lite / Standard / HA と、業務担当者向けの選び方の質問を定義
- 止まる条件（ESC-01〜05）と、判断依頼・例外の承認の手順、例外の記録の要件（ESC-06）を定義
