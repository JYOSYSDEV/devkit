# devkit v4.3 — Claude Code 開発の社内標準キット（プラグイン）

Claude Code に作りたいものを伝えると、社内標準に沿った雛形の用意、業務の言葉での要件の聞き取り、仕様と計画づくりまでを AI が行います。人が計画を承認すると、**ランナー**が作業ごとに AI を呼び出し、実装・機械検証・独立レビュー・統合を進めます。人は要所の承認（業務ゲート・技術ゲート）と、AI が決められないことへの回答だけを行います。セッションを閉じたままの夜間の無人実行と、どこからでも分かる状態の確認に対応しています。4.3 からは、常駐の **Supervisor** が、人の判断を受けてランナーを自動で再開し、一時的な障害を待って再試行し、毎朝「夜間の成果・今朝の判断・判断後に進む作業」を1通にまとめて送ります。

```
「備品の貸出を Excel から Web にしたい」
  ↓ devkit-kickoff（対話）: 業務の言葉で聞き取り → 仕様書・案件プロファイル → マイルストーンと作業の計画 → 機械の検査 → 別の AI のレビュー
  ↓ 業務担当者と標準オーナーが、端末で計画を承認
  ↓ pnpm devkit run --until 07:00 --detach（夜間でも）
  ↓   作業ごとに: リポジトリの外の作業ディレクトリで AI が実装（サンドボックス） → ランナーが取り込んでコミット
  ↓              → 機械検証（検証コマンドはコンテナの中） → 別の AI がレビュー → 統合 → 統合後の検証
  ↓   マイルストーンごとに: ビルド・E2E・受入基準の照合 → 変更内容から承認者を決める → 確認資料 → 人間ゲート
  ↓ 朝 08:00: 定時ブリーフィング（夜間の成果・今朝の判断・判断後に進む作業・運用状態を1通に）
  ↓ 人が端末で承認・回答 → Supervisor が確かめてランナーを自動で再開（pnpm devkit supervisor start）
  ↓ 最後: リリース前検査・最終レビュー → 承認 → リリース判断とデプロイは人
```

devkit-template v3 を土台に、claude-devkit v2.0.0 の統治の仕組み（社内標準の検査、業務と技術の人間ゲート、変更検出、判断の記録、例外の管理）を取り込んで1つにしたものです。違いと理由は [docs/adr/0004-merge-and-runner.md](docs/adr/0004-merge-and-runner.md)、検証の隔離は [docs/adr/0005-isolated-verification.md](docs/adr/0005-isolated-verification.md)、仕組みの全体図は [docs/architecture.md](docs/architecture.md) にあります。

## このリポジトリ

```
.claude-plugin/marketplace.json   社内マーケットプレイスの定義
plugins/devkit/                   プラグイン本体
  skills/                         kickoff・run・status・gate-review・init・update・作法（要件・TDD・デバッグ・検証・診断）・標準の例外と改訂案
  agents/                         implementer・reviewer・replanner・final-reviewer・plan-reviewer・spec-reader
  hooks/                          devkit 未導入のフォルダでの案内と、版の違いの案内
  scripts/init.mjs                案件の新規作成・既存アプリへの導入・更新・版の照合
  runtime/                        案件にコピーする実行部品（ランナー・標準チェッカー・社内標準・ガード・権限）
  templates/app/                  社内標準のアプリの雛形（Next.js + Drizzle + PGlite + Vitest + Playwright）
docs/                             仕組み・展開手順・ADR
tests/                            ランナー・ガード・導入・標準チェッカーのテスト（偽の claude を使う）
```

## 使い方（利用者）

1. 空のフォルダで Claude Code を起動し、作りたいものを伝える（フォルダの信頼を求められたら許可する）。ランナーを回す機械には Docker（か Podman）と、Linux では bubblewrap・socat が要ります（[docs/rollout.md](docs/rollout.md) の 3・4）。
   ```
   総務の備品貸出を Excel から Web に移したい。誰が何をいつまで借りているか分かるようにして
   ```
2. 業務についての質問に答え、仕様書の内容を確かめる。
3. 計画ができたら、Claude Code の外の端末で承認する（業務担当者と標準オーナーがそれぞれ。画面に出る番号を打ち込みます）。
   ```bash
   pnpm devkit approve plan --role 業務
   pnpm devkit approve plan --role 技術
   ```
4. Claude に「始めて」と伝える。夜間に回すなら「夜のあいだ回して」（`pnpm devkit run --until 07:00 --detach`）。
5. 確認をお願いされたら、確認資料（`.devkit/gates/<ID>.html`）を見て、端末で承認か差し戻しをする。
   ```bash
   pnpm devkit approve M2 --role 業務
   pnpm devkit reject M2 --role 業務 --note "一覧に返却予定日を出してほしい"
   ```

困ったら Claude に「進捗は？」「なぜ止まった？」と聞いてください。承認・差し戻し・回答は、人が端末で行います（Claude からは実行できません）。

## よく使うコマンド

| やりたいこと | コマンド |
| --- | --- |
| 状況（ランナーの生死・誰の番か・費用） | `pnpm devkit status`（`--watch` で10秒ごと、`--json`） |
| ランナーを起動 | `pnpm devkit run`（夜間は `--until 07:00 --detach`。`--max-hours`・`--max-cost-usd`・`--max-parallel`） |
| 判断の後に自動で再開・毎朝のまとめ | `pnpm devkit supervisor start`（常駐。`status`・`stop`。OS のサービスへの登録は docs/rollout.md の 5b） |
| 定時ブリーフィング | `pnpm devkit briefing --print`（表示）／ `--send`（保存して送る） |
| 止める・再開 | `pnpm devkit pause <理由>`（実行中の作業が終わり次第止まる）／ `pnpm devkit resume` |
| ログの要約 | `pnpm devkit logs` |
| 確認資料を作り直す | `pnpm devkit gate <マイルストーン>` |
| 計画の検査 | `pnpm devkit check` |
| 承認・差し戻し・回答（人が端末で） | `pnpm devkit approve` / `reject` / `answer` / `proposal accept` |
| 上限の追加・停止からの再開（人が端末で） | `pnpm devkit resume [--add-cycles N]` |
| 標準の例外の登録（標準オーナーが端末で） | `pnpm devkit exception add …` |
| 判断の記録（devkit の更新など。人が端末で） | `pnpm devkit record --role 技術 --target … --decision …` |
| Supervisor の停止の解除・記録の受け入れ（標準オーナーが端末で） | `pnpm devkit supervisor clear --role 技術 --note …` ／ `pnpm devkit seal accept --role 技術 --note …` |

## 夜間に回す

- 常時動く機械（社内のサーバー・VM。macOS なら `caffeinate -i`、Windows は WSL2）で回します。ノート PC はスリープすると止まります。
- 毎晩決まった時刻に始めるには、OS のスケジューラに登録します（例は [docs/rollout.md](docs/rollout.md)）。
- 止まった・承認待ち・判断依頼・完了のときに通知を受け取るには、`DEVKIT_NOTIFY_BUSINESS_CMD`（業務）・`DEVKIT_NOTIFY_TECH_CMD`（技術）・`DEVKIT_NOTIFY_CMD`（共通）を設定します。Slack なら `node scripts/devkit/notify-slack.mjs` と `SLACK_WEBHOOK_URL`。
- 朝は `pnpm devkit status` と `.devkit/reports/run-<時刻>.md`（できたこと・人の判断待ち・止まった作業・AI が自分で決めたこと・費用）。

## 安全のための仕組み

- **合否はコードが決める**: 作業の完了は、ランナーの機械検証（範囲・保護パス・リンク・テストの弱体化・標準チェッカーはホストの取り出しで、検証コマンド・テストの棚卸し・実行されたテストでの受入基準の照合はコンテナの中で）と独立レビューに合格し、統合後の検証も通ったときだけ。AI の自己申告では決まりません。
- **AI が書いたコードは隔離して動かす**: 検証コマンドは、対象のコミットを git の外に取り出し、コンテナの中（検証の段階はネットワークなし・root 以外・読み取り専用）で実行します。AI の作業ディレクトリはリポジトリの外で、AI の Bash はサンドボックスの中です。承認・計画・判断の記録が、ランナーと人のコマンド以外から変わったら止まります。
- **人の判断は人だけが**: 承認・差し戻し・回答・再計画の案の承認・標準の例外・上限の追加・判断の記録は、Claude Code の外の端末からのコマンドだけが受け付け（番号の打ち込み）、担当者を `docs/profile.json` と照合し、`docs/decisions.md` に残します。役割も確かめます（判断依頼には依頼の種別の役割だけが、依頼の ID を付けて回答でき、差し戻しはそのマイルストーンの承認者、再計画の案は確認者の役割だけ。受け付けるときと状態に反映するときの両方で）。承認は計画のハッシュや検証したコミットに紐づきます。CODEOWNERS とブランチ保護を必ず併用します。
- **自動の再開は、既存の判断の経路の上だけで**: Supervisor は「今ランナーを1つ起動してよいか」だけを決めます。判断を反映した状態で実行できる作業があり、一時停止・上限・記録の不整合がないときだけ起動します（誤った役割の判断・古い版への承認では起動しない）。上限・認証切れ・記録の不整合で止まったら、標準オーナーが端末で解除するまで自動では解除しません。API の課金には自動で切り替えません。コミット済みの記録の改変も、起動の前に見つけて止めます（ADR-0006）。
- **計画を勝手に変えない**: 承認の後の計画の変更は、ランナーが「受入基準・マイルストーン・制限・依存・完了済み・着手前の承認を変えない」と機械で分類した再計画だけ。それ以外は人の確認に回ります。
- **ガード**（PreToolUse フック）: テストの弱体化（編集を当てはめた後の内容で）、状態ファイル・判断の記録・社内標準・設定・`.git` の中の編集（パスとリンクを解いてから。git の `--output`・`format-patch -o`・`archive -o`・`clone`・`worktree add` などの書き込み先も）、`.env` の参照（Read・Grep も）、承認などの人のコマンド（包んだ書き方も）、git にコマンドを実行させる書き方（`rebase --exec`・`bisect run`・`submodule foreach`・`difftool -x` など）と設定の注入（`-c`・`--config-env`・`GIT_CONFIG_*`）、作業を失う git 操作、役割ごとの制限（レビューは読み取り専用でコマンド置換も不可、実装はブランチ・設定を変えず、Edit・Write・Bash で作業ディレクトリの外に書かない）。ガードは補助で、合否は機械検証が決めます。
- **社内標準**: `docs/standard/`（5層・ルール一覧）と `pnpm standard:check`（`verify` に含まれる）、リリース前検査 `pnpm standard:release`。
- **本番には触れない**: デプロイ・既定のブランチへの push・本番 DB の操作は人が行います。

## 管理者の方へ

展開の手順（社内 GitHub への配置、managed settings での配布、前提条件、隔離（コンテナ・サンドボックス・`.devkit/config.json`）、夜間の実行環境、通知、使用量の管理、CODEOWNERS）は [docs/rollout.md](docs/rollout.md) にあります。

## 開発（このリポジトリ）

```bash
node --test tests/runtime tests/standard     # ランナー・ガード・導入・標準チェッカーのテスト
claude plugin validate . --strict            # マーケットプレイスとプラグインの検証
```

ランナーのテストは、偽の claude（`tests/runtime/fixtures/fake-claude.mjs`）・偽のコンテナエンジン（`fake-docker.mjs`。ランナーが組み立てた `docker run` の引数を記録する）と小さな案件で、計画の承認からゲート・差し戻し・判断依頼・再計画・環境の問題・二重起動・改ざんの検出・lookahead のやり直しまでを通します。
