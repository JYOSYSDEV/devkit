---
name: devkit-run
description: devkit の計画を実行するランナーと Supervisor を起動・見守り・止めるときに使う。計画の承認と開始のあと、「始めて」「続けて」「再開して」「夜のあいだ回して」「判断したら自動で続けて」「毎朝まとめを送って」「止めて」と言われたとき、ランナーが止まっていて続きがあるときに使う。
argument-hint: "[attended | night | supervise | stop]"
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

**判断の後も自動で続ける・毎朝まとめを送る（supervise）**: Supervisor を常駐させる（ADR-0006）。人が承認・回答すると、Supervisor が条件を確かめてランナーを起動し、一時的な障害は待って再試行し、毎朝 08:00（`briefing.time`）に「夜間の成果・今朝の判断・判断後に進む作業・運用状態」を1通にまとめて送る。

```bash
pnpm devkit supervisor start     # 切り離して起動（常時動かすなら OS のサービスに登録: docs/rollout.md の 5b）
pnpm devkit supervisor status    # 状態と「次の照合での判断」
pnpm devkit briefing --print     # 今朝のブリーフィングを表示（--partial で前回の締切から今まで）
```

- Supervisor の起動は利用者に確認してから（常駐するプロセスになる）。常時動かすのは、OS のサービス（systemd・launchd）として登録するよう管理者に案内する。
- Supervisor が止まった（`limit_stop`・`env_stop`・`policy_stop`・`manual_stop`）ときの解除は、原因を直してから標準オーナーが端末で `pnpm devkit supervisor clear --role 技術 --note "…"`（Claude からは実行できない）。
- Supervisor は API の課金に切り替わる設定（`ANTHROPIC_API_KEY` など）をランナーに渡さない（`.devkit/config.json` の `supervisor.allowApiKey` を人が変えた場合を除く）。

ランナーが起動する AI の権限は `.devkit/config.json` の `permissionMode`（既定 `dontAsk`: 許可していない操作は確認を待たずに拒否する）で決まります。ランナーは、Docker か Podman（検証の隔離。`isolation`）と、Linux では bubblewrap と socat（AI のサンドボックス。`aiSandbox`）がないと起動しません。足りないと言われたら、管理者の手順（docs/rollout.md の「隔離」）を案内します。ランナーを起動する前と、起動時に止まったときは、`pnpm -s devkit doctor` を実行して、直すこと（コンテナのエンジン・サンドボックス・AI の担当・未コミットの変更・記録の照合・人が編集するファイルの形）をまとめて利用者に伝えます（1つずつ直して起動し直す、を繰り返させない）。承認・`seal accept` などの人のコマンドは、Claude Code を動かしているのとは別の端末で実行してもらいます（入力欄の `!` からも実行できません）。`.devkit/config.json` は人が手で変えるファイルで、Claude は編集しません。

## 止めるとき

`pnpm devkit pause <理由>`（Claude から実行してよい）。ランナーは実行中の作業が終わり次第止まる。再開は `pnpm devkit resume`。Supervisor の自動の起動も止めるなら `pnpm devkit supervisor stop <理由>`（ブリーフィングは続く。解除は標準オーナーの `supervisor clear`）。急ぐときは、ランナーのプロセスに SIGINT（Ctrl+C）を送る。次の起動で、中断した作業を照合してから続ける（途中のマージは取り消してやり直し、途中の作業は同じブランチの続きから）。

## 止まったときの案内

| 止まった理由 | 利用者に伝えること |
| --- | --- |
| 人の判断待ち | 誰の、何の判断か（`devkit-gate-review`）。承認・差し戻し・回答は人が端末で |
| 時間・費用の上限 | そのまま。続きは次の `pnpm devkit run` |
| サイクル上限 | 人が端末で `pnpm devkit resume --add-cycles <N>`（増やすかは人が判断） |
| 停止（進捗なし・再計画の上限） | 原因の調査を提案する（`devkit-diagnose`）。計画を直すなら kickoff の手順で直し、人がもう一度承認する |
| 環境の問題（ログイン切れ・ネットワーク・コンテナのエンジン・サンドボックス） | 対処してから `pnpm devkit run`（試行回数には数えない） |
| 保護されたファイルの変更を検出（改ざん） | `.devkit/reports/tamper-<時刻>.md` を利用者と見る。Claude は戻したりコミットしたりせず、人が `git diff` で確かめて片付けてから `pnpm devkit run` |
| 記録が devkit の書いたものと合わない（コミット済みのものも） | `git log -p -- <ファイル>` を利用者と見る。改ざんなら人が戻す。正しい内容なら標準オーナーが端末で `pnpm devkit seal accept --role 技術 --note "…"` |
| 計画が承認の後に変わった | 誰が何を変えたか（`git log .devkit/graph.json`）。人が確かめて承認し直す |

## してはいけないこと

- ランナーの実行中に、このセッションで計画・テスト・設定ファイルを変更する
- 人の判断（approve・reject・answer・proposal accept・resume --add-cycles・seal accept・supervisor clear）を代わりに実行する（フックとコマンド自身が止める）
- `.devkit/config.json`（Supervisor・ブリーフィングの設定を含む）を編集する（人が変える）
- ランナーを使わずに、自分で作業を実装して「完了」にする（完了はランナーの検証だけが決める）
