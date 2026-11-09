---
name: devkit-run
description: devkit の計画を実行するランナーを起動・見守り・止めるときに使う。計画の承認と開始のあと、「始めて」「続けて」「再開して」「夜のあいだ回して」「止めて」と言われたとき、ランナーが止まっていて続きがあるときに使う。
argument-hint: "[attended | night | stop]"
---

# devkit-run: ランナーを動かす

引数: $ARGUMENTS

ランナー（`pnpm devkit run`）は、計画を実行する決定的な制御部分です。作業ごとにリポジトリの外に作業ディレクトリを作り、AI に実装させ（AI の Bash はサンドボックスの中）、ファイルを取り込んでコミットし、機械検証（変更範囲・テストの弱体化・標準チェックはホストで、lint・型・テストは対象のコミットを取り出してコンテナの中で。受入基準は実行されたテストで照合）を行い、別の AI にレビューさせ、合格したものだけを統合ブランチに順にマージし、統合後にも検証します。マイルストーンの区切りでは全体検証と人間ゲートを行います。判断の分岐はすべてコードにあり、このセッションの Claude は**起動と案内だけ**を受け持ちます。

## 起動の前に

1. `pnpm -s devkit status` で状況を確かめる。
   - 計画が未承認 → 人が端末で `pnpm devkit approve plan --role 業務` と `--role 技術`
   - 未開始（`計画中（未開始）`）→ `pnpm -s devkit start`
   - 一時停止・停止（進捗なし）→ 理由を利用者に伝える。再開は人の判断（停止からの再開は、人が端末で `pnpm devkit resume`。サイクル上限なら `pnpm devkit resume --add-cycles <N>`）
   - 人の判断待ち → `devkit-gate-review` で確認を手伝う
   - ランナーが実行中 → 起動しない（二重起動はコマンド自身が断る）
2. 統合ブランチにいて、`.devkit/` 以外に未コミットの変更がないこと（ランナーが確かめて断る）。

## 起動のしかた

**見ているとき（attended）**: Bash のバックグラウンド実行で `pnpm devkit run` を起動する。起動したら、ランナーが止まるまでこのセッションではファイルを変更しない（ランナーと衝突する）。様子は `pnpm -s devkit status` と `pnpm -s devkit logs`。

**夜間に無人で（night）**: このセッションを閉じても動くように、切り離して起動する:

```bash
pnpm devkit run --until 07:00 --detach
```

- `--until` の時刻を過ぎると、新しい作業を始めずに止まる（実行中の作業は終わるまで待つ）。`--max-hours <N>` と `--max-cost-usd <N>` も使える。
- ノート PC はスリープすると止まる。常時動く機械（社内のサーバー・VM、macOS なら `caffeinate -i pnpm devkit run --until 07:00`、Windows は WSL2）で回すよう伝える。
- 毎晩決まった時刻に始めるなら、OS のスケジューラ（cron・launchd・systemd・タスク スケジューラ）に `cd <案件> && pnpm devkit run --until 07:00` を登録する（例は README の「夜間に回す」）。
- 止まったときの通知を受け取るには、`DEVKIT_NOTIFY_CMD`（共通）、`DEVKIT_NOTIFY_BUSINESS_CMD`（業務）、`DEVKIT_NOTIFY_TECH_CMD`（技術）を設定しておく（Slack なら `node scripts/devkit/notify-slack.mjs`）。
- 朝は `pnpm devkit status` と、`.devkit/reports/` の実行のまとめを見る。状況ページは `.devkit/status.html`。

ランナーが起動する AI の権限は `.devkit/config.json` の `permissionMode`（既定 `dontAsk`: 許可していない操作は確認を待たずに拒否する）で決まります。ランナーは、Docker か Podman（検証の隔離。`isolation`）と、Linux では bubblewrap と socat（AI のサンドボックス。`aiSandbox`）がないと起動しません。足りないと言われたら、管理者の手順（docs/rollout.md の「隔離」）を案内します。`.devkit/config.json` は人が手で変えるファイルで、Claude は編集しません。

## 止めるとき

`pnpm devkit pause <理由>`（Claude から実行してよい）。ランナーは実行中の作業が終わり次第止まる。再開は `pnpm devkit resume`。急ぐときは、ランナーのプロセスに SIGINT（Ctrl+C）を送る。次の起動で、中断した作業を照合してから続ける（途中のマージは取り消してやり直し、途中の作業は同じブランチの続きから）。

## 止まったときの案内

| 止まった理由 | 利用者に伝えること |
| --- | --- |
| 人の判断待ち | 誰の、何の判断か（`devkit-gate-review`）。承認・差し戻し・回答は人が端末で |
| 時間・費用の上限 | そのまま。続きは次の `pnpm devkit run` |
| サイクル上限 | 人が端末で `pnpm devkit resume --add-cycles <N>`（増やすかは人が判断） |
| 停止（進捗なし・再計画の上限） | 原因の調査を提案する（`devkit-diagnose`）。計画を直すなら kickoff の手順で直し、人がもう一度承認する |
| 環境の問題（ログイン切れ・ネットワーク・コンテナのエンジン・サンドボックス） | 対処してから `pnpm devkit run`（試行回数には数えない） |
| 保護されたファイルの変更を検出（改ざん） | `.devkit/reports/tamper-<時刻>.md` を利用者と見る。Claude は戻したりコミットしたりせず、人が `git diff` で確かめて片付けてから `pnpm devkit run` |
| 計画が承認の後に変わった | 誰が何を変えたか（`git log .devkit/graph.json`）。人が確かめて承認し直す |

## してはいけないこと

- ランナーの実行中に、このセッションで計画・テスト・設定ファイルを変更する
- 人の判断（approve・reject・answer・proposal accept・resume --add-cycles）を代わりに実行する（フックとコマンド自身が止める）
- ランナーを使わずに、自分で作業を実装して「完了」にする（完了はランナーの検証だけが決める）
