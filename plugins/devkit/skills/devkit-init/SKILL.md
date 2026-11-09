---
name: devkit-init
description: devkit を案件に用意する。空のフォルダに社内標準のアプリの雛形と devkit を作るとき、既存のアプリに devkit と社内標準だけを入れるときに使う。devkit-kickoff の手順0から呼ばれる。
argument-hint: "[new | adopt] [プロジェクト名]"
---

# devkit-init: 案件を用意する

引数: $ARGUMENTS

devkit は「考える部分」（スキル・エージェント）をプラグインに、「実行する部分」（ランナー・検査・ガード・社内標準）を案件の中に版を固定して持ちます。このスキルは、案件の中に実行部品と雛形を置きます。

## 新しく作る（空のフォルダ）

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" new --title "<日本語のプロジェクト名>" --slug <英小文字-ハイフン>
pnpm install
pnpm exec playwright install chromium     # 社内ネットワークで落とせなければ E2E_CHANNEL=chrome を使う
pnpm verify
git add -A && git commit -m "devkit: 雛形から作成"
```

- `pnpm verify`（lint・型・標準チェック・テスト）が通ることを必ず確かめる。通らなければ環境（Node.js 24、pnpm、Playwright のブラウザ、プロキシ）を直してから進む。
- ランナーは、検証をコンテナ（Docker か Podman）の中で、AI の Bash をサンドボックス（Linux では bubblewrap と socat が要る）の中で動かす。`docker version` で確かめ、なければ管理者に依頼するよう伝える（docs/rollout.md の「隔離」）。

## 既存のアプリに入れる

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" adopt --title "<システム名>"
```

- アプリのコードには触れず、実行部品（`scripts/devkit/`・`scripts/standard/`）・社内標準（`docs/standard/`）・設定（`.claude/`）・案件の文書（`docs/profile.json` など）だけを入れる。
- `.claude/settings.json` が既にあれば、devkit の設定は `.claude/settings.devkit.json` に置かれる。permissions と hooks を利用者と一緒に統合する。
- 既存の技術が社内標準と違えば、`pnpm standard:check` が多くの違反を出す。その一覧を利用者と標準オーナーに見せ、「例外として登録する（`devkit-standard-exception`）」か「標準への移行をマイルストーンにする」かを決めてもらう。
- ランナーは、検証コマンドがテストの結果を `test-reports/vitest.json`（Vitest の json レポーター形式）と `test-reports/e2e.json`（Playwright の json レポーター形式）に出すことを前提にする。出していなければ、その設定を最初のマイルストーンに入れる。

## 終わったら

`devkit-kickoff` の手順1に戻る。
