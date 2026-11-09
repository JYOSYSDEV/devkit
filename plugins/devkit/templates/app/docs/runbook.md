# 運用手順書: __PROJECT_TITLE__

本番リリースの前に、すべての節を埋めます（「（記入）」が残っていると、リリース前検査 `pnpm standard:release` が通りません）。技術的な手順（起動・デプロイ・マイグレーション）は最後のマイルストーンで AI が下書きし、体制に関わる節（バックアップ・監視・連絡先）は人が書きます。

## 1. 起動と停止

（記入）

雛形の構成での例（案件に合わせて書き直し、「（記入）」を消す）:

- 起動: `docker run -d --name <名前> -p 3000:3000 --env-file <本番の環境変数のファイル> <名前>`。待ち受けは 3000 番。
- 本番の環境変数: `DATABASE_URL`（必須。ないと起動しない）、`AUTH_MODE`（本番の認証方式）、`LOG_LEVEL`（既定は info）。
  開発用の認証の指定は本番の設定に書かない。
- 起動の確認: `GET /api/health` が `{"status":"ok","db":"ok"}` を返す。設定に誤りがあると、起動時に `startup_env_invalid` のログを出して止まる。
- 停止: `docker stop <名前>`。

## 2. デプロイ

（記入）

雛形の構成での例:

1. `docker build -t <名前>:<版> .`（Next.js の standalone 出力のイメージ）
2. マイグレーションがあれば、先に「3. マイグレーション」を行う
3. 古いコンテナを止め、新しいイメージで起動する（「1. 起動と停止」）
4. `GET /api/health` と、主な画面を開いて確かめる

Host を書き換えるリバースプロキシ（ロードバランサー）の後ろに置き、プロキシが `x-forwarded-host` を渡さない場合は、
Server Action が「別のオリジンからの呼び出し」として拒否される。利用者がブラウザで開くホストを、ビルドの時点で渡す:
`docker build --build-arg SERVER_ACTIONS_ALLOWED_ORIGINS=app.example.co.jp -t <名前>:<版> .`（カンマ区切りで複数。next.config.ts）。

## 3. マイグレーション

（記入）

雛形の構成での例（アプリの起動時には流さない。デプロイの前に人が実行する）:

1. `docker build --target migrate -t <名前>-migrate:<版> .`（`drizzle/` のマイグレーションと drizzle-kit を含むイメージ）
2. `docker run --rm -e DATABASE_URL=<本番の DB> <名前>-migrate:<版> ./node_modules/.bin/drizzle-kit migrate`（`pnpm db:migrate` と同じ）
3. 本番に適用した最後のマイグレーション名を `docs/profile.json` の `releasedMigration` に書く

リリース後のマイグレーションは、追加 → 移行 → 削除の段階に分ける（列の削除や名前の変更を1回でしない）。

## 4. バックアップと復元

（記入）

## 5. 監視と通知

（記入）

## 6. 障害時の連絡先

（記入）
