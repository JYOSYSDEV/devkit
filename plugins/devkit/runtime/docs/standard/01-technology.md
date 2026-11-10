# 1. 技術標準

この案件で使う技術を決める。AI エージェントはこの範囲で設計・実装する。ここにない技術が必要になったら、自分で導入せずに止まる（[5. 例外ルール](05-exceptions.md) の ESC-01）。

技術を選んだ理由と、AI がよく間違える点（Next.js 16 の `proxy.ts`、プリレンダリング、Zod 4 の書き方など）は `docs/devkit/stack.md` にある。実装の前に読む。

## 標準スタック

| 用途 | 採用 | バージョン |
|---|---|---|
| 言語 | TypeScript（strict） | 6.0 |
| 実行環境 | Node.js LTS / pnpm | 24 / 10 |
| フレームワーク | Next.js（App Router・Server Actions） | 16 |
| UI | Tailwind CSS + shadcn/ui | 4 |
| DB | PostgreSQL + Drizzle ORM | 17 / 0.45 |
| テスト用 DB | PGlite（インプロセスの PostgreSQL 17） | 0.5 |
| 入力検証 | Zod | 4 |
| 単体・結合テスト | Vitest | 5 |
| E2E テスト | Playwright | 1.65 |
| 整形・lint | Biome | 2.6 |
| CI | GitHub Actions | - |
| 配布 | Docker（Next.js standalone） | - |

## 必要になったら使う標準

最初からは入れない。必要になったマイルストーンで追加する（依存の追加は共有ファイルの変更なので、基盤の作業で行う）。例外承認は要らない。

| 用途 | 標準 | 補足 |
|---|---|---|
| 認証 | Better Auth | 社内 SSO は OIDC（Microsoft Entra ID / Google Workspace / LINE WORKS）。資格情報が要るので人間ゲートを付ける |
| 日付 | `date-fns` + `@date-fns/tz` | 表示は `Asia/Tokyo` |
| メール送信 | 社内の SMTP を `nodemailer` で | 送信先と資格情報が要るので人間ゲートを付ける。呼び出しは `src/server/external/` |
| ファイル保存 | S3 互換ストレージ（`@aws-sdk/client-s3`） | 開発時は MinIO。呼び出しは `src/server/external/` |
| ログ | `pino` | 構造化ログ（JSON）。テンプレートの `src/lib/logger.ts` で足りるなら入れない |
| UI の部品 | shadcn/ui（`pnpm dlx shadcn@latest add <名前>`） | 部品が使う `class-variance-authority`・`lucide-react`・`tw-animate-css`・`radix-ui`・`@radix-ui/react-*` |
| フォーム | React 19 の `useActionState` + Server Actions + Zod | クライアントのフォームライブラリは使わない |
| 定期実行 | デプロイ先のスケジューラ + API ルート | キューが必要になったら ADR を書く |

## 依存の許可リスト（dependencies.json）

使ってよい依存は [dependencies.json](dependencies.json) で決める。

| 項目 | 意味 |
|---|---|
| `core` | 標準の構成要素（テンプレートの package.json にあるもの） |
| `preApproved` | 申請なしで追加してよいもの（上の「必要になったら使う標準」） |
| 名前の `*` | パターン。`*` は `/` を含まない1文字以上に当てはまる（`@radix-ui/react-*` は `@radix-ui/react-dialog` に当てはまり、`@radix-ui/react-dialog/x` には当てはまらない） |
| `builtDependencies` | インストール時のスクリプト（postinstall など）の実行を許すパッケージ。`onlyBuiltDependencies` に書いてよいのはこれと core・preApproved だけ |
| `node` | Node.js のメジャー版。`.nvmrc` と Dockerfile の node イメージをこれに合わせる |

ここにない依存は、案件で例外を承認する（subject `dependency:<名前>`）か、標準を改訂して加える。

## ルール

- **TECH-01** 依存は許可リストか、承認済みの例外にあるものだけ。dependencies・devDependencies・optionalDependencies・peerDependencies のすべてが対象。ワークスペースのサブパッケージの package.json、`pnpm-workspace.yaml` の catalog、`pnpm.packageExtensions` が足す依存、`onlyBuiltDependencies` も同じ
- **TECH-02** 依存のバージョンは `"1.2.3"` の完全一致で書く。`^` `~` `*` `latest`・範囲・git・URL・ファイル（`file:` `link:`）・別名（`npm:`）は使わない。`pnpm.overrides`・`overrides`・`resolutions`・`pnpm.packageExtensions`・`pnpm-workspace.yaml` の overrides と catalog（`catalog:` で参照した版）も同じ。依存へのパッチ（`patchedDependencies`）とインストール時のフック（`.pnpmfile.cjs`）は使わない（必要なら例外承認）。`packageManager` に pnpm の版を固定し、`pnpm-lock.yaml` をコミットする。ほかのロックファイル（package-lock.json など）は置かない
- **TECH-03** Node.js は標準のメジャー版を使う。`.nvmrc`（なければ `.node-version`）と Dockerfile の `FROM node:<版>`（`ARG NODE_VERSION=24` と `FROM node:${NODE_VERSION}` の形は既定値で確かめる）を `dependencies.json` の `node` と一致させる
- **DEPS** 依存の変更（追加・版の変更・pnpm の設定・overrides・resolutions・packageManager・`pnpm-workspace.yaml`・`.npmrc`）は、差分（`--base`）から検出して技術ゲートで確かめる
- **TECH-04** 次の技術は、ADR と例外承認なしに導入しない

| 技術 | 標準で使わない理由 | 導入を検討する条件 |
|---|---|---|
| Kubernetes | 運用の負荷が大きい | 多数のサービスと高度な運用制御が必要 |
| マイクロサービス分割 | 分散トランザクションと障害の解析が複雑になる | 独立したデプロイや組織の境界が必要 |
| Kafka | 運用のコストが大きい | 大量のイベントストリームと再生が必要 |
| Redis | キャッシュの整合性と障害点が増える | 性能を測って必要だと確かめた |
| Elasticsearch / OpenSearch | データの同期と索引の管理が増える | PostgreSQL の全文検索では足りない |
| MongoDB | DB を増やす理由が弱い | ドキュメント型に明確な利点がある |
| GraphQL | スキーマとキャッシュの運用が増える | 複雑なクライアントをまたぐ取得が必要 |
| 別言語のバックエンド（Python など） | 言語とツールが2系統になり、検証のループが重くなる | AI・機械学習の処理が中心で、TypeScript では実現できない |
| 別の ORM（Prisma など） | コード生成の手順があり、書き方が2系統になる | なし（Drizzle で足りる） |
| クライアントのフォームライブラリ | Server Actions + Zod と検証が2か所になる | 複雑な入力（動的な行の追加など）で、標準の書き方では作れない |
| TypeScript 7（ネイティブ版） | Next.js のビルドが TypeScript の JS API を使う | Next.js が対応した |

## 更新の方針

- 標準の版（VERSION）は「年.月.修正番号」。案件は作成時の版に固定され、勝手には変わらない
- 半年に1回（4月・10月の Node.js LTS の更新に合わせて）依存を更新し、テンプレートで `pnpm verify:full` が通ることを確かめて新しい版を出す
- 既存の案件を新しい版に上げるときは、新しい版のチェッカーを `--standard <新しい版の docs/standard>` で実行し、新しく出る違反を直してから差し替える
