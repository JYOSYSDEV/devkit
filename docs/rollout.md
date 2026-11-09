# 社内展開の手順（管理者向け）

## 0. 役割を決める

| 役割 | 人数の目安 | 担うこと |
| --- | --- | --- |
| 標準オーナー | 1〜3人 | 社内標準と devkit の管理・改訂、例外の承認、技術ゲート（データモデル・外部接続・個人情報・安全の中心・本番リリース）、夜間の実行環境 |
| 業務担当者 | 案件ごとに1人 | 依頼・仕様の判断、業務ゲート、業務の判断依頼への回答 |

案件ごとに、業務担当者と標準オーナーの名前とメール（git の `user.email` と同じもの）を `docs/profile.json` の `owners` に書きます。承認のとき、承認した人がその役割の担当者かを照合します。

## 1. リポジトリを社内の GitHub に置く

1. このリポジトリを社内 GitHub の private リポジトリとして push する。
2. 検証する（CI にも入れる）:
   ```bash
   claude plugin validate . --strict
   node --test tests/runtime tests/standard
   ```
3. 版を上げるときは、`plugins/devkit/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の version、`plugins/devkit/runtime/scripts/devkit/version.mjs`、`CHANGELOG.md` をそろえて更新する（`claude plugin tag` で検証付きのタグを作れる）。社内標準を変えたら `plugins/devkit/runtime/docs/standard/VERSION` と `CHANGELOG.md` も更新する。

## 2. 利用者に配る

**各自で入れる（試行段階）**

```
/plugin marketplace add <社内の org>/<このリポジトリ>
/plugin install devkit@devkit-marketplace
```

**組織の設定で全員に配る（本格展開）**: managed settings に次を入れる。

```json
{
  "extraKnownMarketplaces": {
    "devkit-marketplace": { "source": { "source": "github", "repo": "<社内の org>/<このリポジトリ>" } }
  },
  "enabledPlugins": { "devkit@devkit-marketplace": true }
}
```

private リポジトリなら、利用者の環境から GitHub に認証できること（`gh auth login` など）。夜間に回す機械のユーザーにも、プラグインを有効にしておく。

## 3. 利用者の前提

| 項目 | 推奨 | 確認 |
| --- | --- | --- |
| Claude Code | 2.1.319 以上（`--agent`・`--json-schema`・`--max-budget-usd`・`--permission-mode dontAsk` を使う） | `claude --version` |
| Node.js | 24 LTS（22.12 以上で可） | `node --version` |
| pnpm | `corepack enable` | `pnpm --version` |
| Git | `user.name` / `user.email` が `docs/profile.json` の owners と一致 | `git config --get user.email` |
| Playwright のブラウザ | `pnpm exec playwright install chromium`（手元で E2E を動かすとき。ランナーの検証はコンテナのイメージのブラウザを使う） | |
| コンテナ（ランナーを回す機械） | Docker Engine 24 以上（Linux）か Docker Desktop（macOS・WSL2）、または Podman 4 以上。検証用のイメージ（既定 `mcr.microsoft.com/playwright:v<@playwright/test の版>-noble`）を取得できること | `docker version` |
| AI のサンドボックス（ランナーを回す機械） | Linux・WSL2 は `bubblewrap` と `socat`（`sudo apt-get install bubblewrap socat`）。macOS は不要。Windows ネイティブは使えない（WSL2 にする） | `bwrap --version` |
| フック | managed settings で `disableAllHooks` や `allowManagedHooksOnly` を有効にしていないこと（ガードが動かなくなる。合否は機械検証が決めるが、事前の抑止がなくなる） | `/hooks` |

## 4. 隔離（検証のコンテナと AI のサンドボックス）

ランナーは、AI が書いたコードを、承認・計画・判断の記録のある本体のリポジトリから切り離して動かす。

| 何を | どう隔離するか | 設定（`.devkit/config.json`） |
| --- | --- | --- |
| 検証（lint・型・テスト・ビルド・E2E） | 対象のコミットを git の外のフォルダに取り出し、コンテナの中で実行する。依存のインストールの段階だけネットワークあり（キャッシュに書ける）。検証の段階は `--network none`・root 以外・読み取り専用のルート・`--cap-drop ALL`。本体のリポジトリはマウントしない | `isolation`（既定 `mode: "container"`） |
| AI の作業（実装・レビュー・再計画） | 作業ディレクトリと取り出しをリポジトリの外（既定 `~/.cache/devkit/<案件>/work`）に作り、AI の Bash を Claude Code のサンドボックスで動かす（作業ディレクトリの外に書けない、ネットワークなし、使えなければ起動しない）。サンドボックスは Edit・Write には効かないので、実装担当の Edit・Write の書き込み先はガードが作業ディレクトリの中に限る（`aiSandbox: "off"` でも同じ） | `aiSandbox`（既定 `"required"`）、`workDir` |
| 権限 | ランナーが役割ごとに渡す許可（`--allowedTools`）のほかは拒否する | `permissionMode`（既定 `dontAsk`。`auto` も可。`bypassPermissions` は受け付けない） |

`.devkit/config.json` は人（標準オーナー）が手で書き、コミットする（Claude からは編集できない。CODEOWNERS の対象にする）。例:

```json
{
  "permissionMode": "dontAsk",
  "aiSandbox": "required",
  "isolation": {
    "mode": "container",
    "engine": "docker",
    "installNetwork": "bridge",
    "memory": "6g",
    "cpus": 4
  }
}
```

| 項目 | 既定 | 説明 |
| --- | --- | --- |
| `isolation.engine` | `docker` | `podman` も使える（rootless は `--userns=keep-id` で動かす） |
| `isolation.image` | `@playwright/test` の版に合わせた `mcr.microsoft.com/playwright:v<版>-noble`（なければ `node:24-bookworm-slim`） | 社内のレジストリに置いたものを指定してよい。pnpm がなければ、インストールの段階で `packageManager` の版をキャッシュに入れる |
| `isolation.installNetwork` | `bridge` | プロキシが `127.0.0.1` にある機械では `host`。`HTTP(S)_PROXY`・`NO_PROXY`・`NODE_EXTRA_CA_CERTS` はインストールの段階にだけ渡す（`passProxy: false` で渡さない） |
| `isolation.memory` / `cpus` / `pids` | `6g` / 制限なし / `4096` | 1つの検証のコンテナの上限 |
| `isolation.installArgs` / `verifyArgs` | なし | エンジンに足す引数。検証の段階のネットワーク・権限・マウントを広げる引数は受け付けない |
| `isolation.cacheDir` | `~/.cache/devkit/<案件>/cache` | pnpm のストアと pnpm 本体。検証の段階では pnpm 本体だけを読み取り専用で見せる |
| `isolation.mode` | `container` | `none` は隔離なし（検証コマンドを取り出したフォルダでそのまま実行する）。テストと、どうしてもコンテナを使えない機械で、人が理由を決めたときだけ |
| `aiSandbox` | `required` | AI の Bash は作業ディレクトリ（と Claude Code の一時ディレクトリ）にだけ書け、本体のリポジトリへの書き込みは明示的に拒否する。`off` にすると、AI のコマンドが作業ディレクトリの外にも書ける。その場合も改ざんの検出（下）は働く |
| `workDir` | `~/.cache/devkit/<案件>/work` | AI の作業ディレクトリと取り出しの置き場所。リポジトリの外で、`/tmp` の下（サンドボックスが書き込みを許す一時ディレクトリ）にしない |

ランナーは実行中、承認・計画・判断の記録・devkit 自身のファイル（`.devkit/state.json`・`controls.json`・`graph.json`・`config.json`、`docs/decisions.md`・`exceptions.json`・`profile.json`、`scripts/devkit/`・`scripts/standard/`・`docs/standard/`・`.claude/`）が、ランナー自身と人のコマンド（`.devkit/journal.jsonl` に記録が残る）以外から変わっていないかを確かめ、変わっていたら止まってコミットしない（`.devkit/reports/tamper-<時刻>.md`）。これは隔離を補うもので、置き換えではない。

## 5. 夜間の実行環境

- **常時動く機械** で回す（社内のサーバー・VM・開発用 PC を常時稼働にする）。ノート PC はスリープすると止まる。
- 起動のしかた（どれか1つ）:

  ```bash
  # その場で切り離して起動（ログは .devkit/logs/runner-<時刻>.log）
  pnpm devkit run --until 07:00 --detach

  # macOS: スリープさせずに
  caffeinate -i pnpm devkit run --until 07:00

  # Claude Code の背景ジョブとして（agent view から見える。research preview）
  claude --bg --exec "pnpm devkit run --until 07:00"
  ```

- 毎晩決まった時刻に始める:

  ```cron
  # cron（平日 21:13 に開始し、翌 7:00 に新しい作業を止める）
  13 21 * * 1-5 cd /srv/projects/equipment && /usr/bin/env pnpm devkit run --until 07:00 >> .devkit/logs/cron.log 2>&1
  ```

  ```ini
  # systemd: /etc/systemd/system/devkit-equipment.service（Type=oneshot、User=<実行するユーザー>）
  [Service]
  Type=oneshot
  User=devkit
  WorkingDirectory=/srv/projects/equipment
  ExecStart=/usr/bin/env pnpm devkit run --until 07:00
  # 同じ名前の .timer で OnCalendar=Mon..Fri 21:13
  ```

  Windows のタスク スケジューラなら、WSL2 の中で `wsl -d Ubuntu -- bash -lc "cd ~/projects/equipment && pnpm devkit run --until 07:00"` を登録する。

- ランナーが落ちても、次の起動で中断した作業を照合して続ける（途中のマージは取り消してやり直し、途中の作業は同じブランチの続きから）。二重起動はロックで断る。
- 1晩の上限: `--max-cost-usd`（ランナー全体）、`limits.taskBudgetUsd`（1回の実装）、`limits.taskTimeoutMinutes`・`verifyTimeoutMinutes`。

## 5b. Supervisor（判断の後の自動の再開）と定時ブリーフィング（4.3.0）

Supervisor は、ランナーの外側で「今ランナーを1つ起動してよいか」を決め続ける常駐のプロセスです（ADR-0006）。人が朝に判断（承認・回答）すると、だれかが `pnpm devkit run` を打たなくても続きを進めます。毎朝の定時ブリーフィングも Supervisor が作って送ります。

- **起動するのは、次がすべてそろったときだけ**: ランナーが動いていない・状態が進行中・計画が承認済み・記録に不整合がない・再試行の待ちを過ぎた・時間帯の中・日ごとの上限の中・人の決定を反映した状態で実行できる作業がある（誤った役割の判断・古い版への承認では作業が増えないので起動しない）。起動の直前にも確かめ直す。
- **止まる・待つ**: 一時的な障害は待って最大3回、利用上限は復帰の時刻まで待つ。認証切れ・環境の問題・上限・記録の不整合では止まり、標準オーナーに知らせる。止まったら、原因を直してから標準オーナーが端末で `pnpm devkit supervisor clear --role 技術 --note "<直したこと>"`。手動で止めるのは `pnpm devkit supervisor stop <理由>`（実行中のランナーは止めない。止めるなら `pnpm devkit pause`）。
- **API の課金に切り替えない**: `ANTHROPIC_API_KEY` などは、`supervisor.allowApiKey: true` にしない限り、Supervisor が起動するランナーに渡さない。Claude Code の通常のログイン（サブスクリプション）で回す前提。

```bash
pnpm devkit supervisor run            # 前面で動かす（Ctrl-C で止める）
pnpm devkit supervisor start          # 切り離して動かす（ログは .devkit/logs/supervisor-<時刻>.log）
pnpm devkit supervisor status         # 状態・次の照合での判断・再試行の予定・配信の状況
pnpm devkit briefing --print          # 今朝のブリーフィングを表示だけ（--partial で前回の締切から今まで）
pnpm devkit briefing --send           # 作って保存し、送る（同じ締切の分は2回送らない）
```

常時動かすときは、OS のサービスとして登録する（落ちたら起動し直す。起動し直しても、試行回数・日ごとの起動回数は数え直さない）。

```ini
# systemd: /etc/systemd/system/devkit-supervisor-equipment.service
[Unit]
Description=devkit supervisor (equipment)
After=network-online.target docker.service

[Service]
User=devkit
WorkingDirectory=/srv/projects/equipment
Environment=DEVKIT_NOTIFY_CMD=node scripts/devkit/notify-slack.mjs
EnvironmentFile=-/etc/devkit/equipment.env
ExecStart=/usr/bin/env pnpm devkit supervisor run
Restart=always
RestartSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

```xml
<!-- macOS launchd: ~/Library/LaunchAgents/com.example.devkit-supervisor.plist（スリープさせない設定と併用） -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.devkit-supervisor</string>
  <key>WorkingDirectory</key><string>/Users/devkit/projects/equipment</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/usr/bin/env</string><string>pnpm</string><string>devkit</string><string>supervisor</string><string>run</string></array>
  <key>KeepAlive</key><true/>
</dict></plist>
```

`.devkit/config.json`（人が編集する。Claude からは変えられない）の設定:

| 設定 | 既定 | 意味 |
| --- | --- | --- |
| `briefing.time`・`briefing.timeZone` | `"08:00"`・`"Asia/Tokyo"` | 締切。前回の締切から今回の締切までを集計する |
| `briefing.to` | `"common"` | 送り先（`DEVKIT_NOTIFY_CMD`。なければ技術・業務の送り先）。`technical`・`business` も選べる |
| `briefing.enabled` | `true` | ブリーフィングを作るか |
| `supervisor.intervalSeconds` | `20` | 照合の間隔（5〜60 秒。判断はファイルの変更の通知でも検知する） |
| `supervisor.hours` | `null` | 自動で起動してよい時間帯（例 `"22:00-07:00"`。`briefing.timeZone` で判定）。ランナーには終わりの時刻を ISO 8601 で `--until` に渡す（機械のタイムゾーンに左右されない） |
| `supervisor.maxParallel` | `1` | 自動で起動したランナーの AI の並列数 |
| `supervisor.retry` | `maxAttempts: 3`・`baseSeconds: 60`・`maxWaitMinutes: 30`・`totalHours: 6`・`maxRateLimitWaitHours: 8` | 一時的な障害と利用上限の待ち方 |
| `supervisor.limits` | `maxRunsPerDay: 48`・`maxCostUsdPerDay: null`・`maxNoProgressRuns: 3` | 日ごとの上限（超えたら止まり、人が解除する） |
| `supervisor.allowApiKey` | `false` | API の課金に切り替わる設定をランナーに渡すか |

ブリーフィングの中身（構造化データから決まった形で作る。AI は使わない）: 夜間の成果（新しく完了した作業・マイルストーンと、受入基準・検証・コミット・証跡・残った懸念）、今朝の判断（判断の ID・役割・質問・優先度・推奨と代替・影響・対象の版・確認先・端末のコマンド）、判断後に進む作業（ランナーと同じ判断で求めたもの）、運用状態（ランナーと Supervisor・再試行の予定・残りの上限・使用量の目安・集計の欠落）。保存先は `.devkit/briefings/`、送信待ちは `.devkit/cache/supervisor/outbox/`。

## 6. 状態の確認と通知

- 別の端末から: `pnpm devkit status`（ランナーの生死・最終応答・誰の番か）、`pnpm devkit status --watch`、`pnpm devkit logs`、`.devkit/status.html`（30秒ごとに自動で読み込み直す1ファイルのページ）。
- 朝: 定時ブリーフィング（`.devkit/briefings/<日付-時刻>.md`。5b）と、実行ごとの `.devkit/reports/run-<時刻>.md`（できたこと・人の判断待ち・止まった作業・AI が自分で決めたこと・費用）。
- 通知: 環境変数で送り先を分ける（メッセージは `DEVKIT_MESSAGE` で渡り、コマンド文字列には埋め込まれない）。

  ```bash
  export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  export DEVKIT_NOTIFY_CMD="node scripts/devkit/notify-slack.mjs"                                      # 共通（開始・終了など）
  export DEVKIT_NOTIFY_BUSINESS_CMD="SLACK_WEBHOOK_URL=$BIZ_URL node scripts/devkit/notify-slack.mjs"  # 業務ゲート・業務の判断依頼
  export DEVKIT_NOTIFY_TECH_CMD="SLACK_WEBHOOK_URL=$TECH_URL node scripts/devkit/notify-slack.mjs"     # 技術ゲート・技術の判断依頼・停止・環境の問題
  ```

- 組織で集めるなら、Claude Code の OpenTelemetry（`CLAUDE_CODE_ENABLE_TELEMETRY=1` と exporter の設定を managed settings で）で、費用・トークン・ツールの判定を集められる。リポジトリの設定からは有効にできない。
- `claude --bg` で動かした場合は `claude agents`・`claude logs` でも見られ、Remote Control を使えばスマートフォンからも見られる（機械が起きている間だけ）。

## 7. 承認の信頼性（必須）

devkit の人のコマンド（approve など）は、Claude Code の中から実行されたもの（環境変数・親のプロセス）を断り、端末で番号を打ち込んでもらい、承認した人の git のメールを `docs/profile.json` の担当者と照合する（担当者が空なら断る）。それでも、同じ利用者の権限で動くプログラムを完全には見分けられず、なりすましも防げない。案件のリポジトリを GitHub に置くときは、次を必ず設定する。

- `.github/CODEOWNERS` で、`docs/exceptions.json`・`docs/profile.json`・`docs/decisions.md`・`docs/standard/`・`src/server/auth/`・`.devkit/controls.json`・`.devkit/state.json`・`.devkit/config.json`・`.devkit/journal.jsonl`・`scripts/devkit/`・`scripts/standard/`・`.claude/` を標準オーナーのチームに割り当てる（雛形の `.github/CODEOWNERS.example`）
- 既定のブランチをブランチ保護し、CODEOWNERS のレビューを必須にする。統合ブランチのマージは人が PR で行う
- 対話で Claude Code を使うときは、Bash を確認なしで許す権限モード（`bypassPermissions` など）を使わない

## 8. 社内標準と devkit の運用

- 標準の正本は `plugins/devkit/runtime/docs/standard/`。改訂したら VERSION と CHANGELOG を更新し、`node --test tests/standard` と、雛形での `pnpm verify` を通してから版を上げて配る。
- 案件は作成時の版に固定される。上げるときは、その案件で `/devkit:devkit-update`（入れ替わるファイルと、案件で手を入れたため残るファイルを先に示す）。
- 四半期に1回、各案件で `devkit-standard-feedback` を実行して改訂案を集める（同じ例外が3案件以上で出たら許可リストに取り込む、など）。

## 9. 段階的な展開

1. **パイロット（2〜3週間）**: 推進担当が小さな社内ツールを2件作る。少なくとも1回は夜間に無人で回す。止まった箇所・差し戻しの理由・費用を記録し、雛形・goal の書き方・許可リストに反映する。
2. **勉強会**: 「仕様の受入基準がそのまま合否になる」「承認は端末で、確認資料を見て」「夜間に回して朝に確かめる」を中心に。
3. **展開**: 組織の設定で全員に配る。依頼の窓口と、標準オーナーを決める。
4. **改善の回し方**: 失敗は個別に直すだけでなく、仕組み（雛形・標準・ガード・goal の書き方・ランナー）に反映して、次の案件で同じことが起きないようにする。

## トラブル対応

| 症状 | 原因と対処 |
| --- | --- |
| `計画が承認されていません` | 端末で `pnpm devkit approve plan --role 業務` と `--role 技術` |
| `docs/profile.json の owners.<役割> が空なので、承認できません` | 担当者の名前と git のメールを書いてコミットしてから承認する |
| `計画が承認の後に変わっています` | `git log .devkit/graph.json docs/spec` で何が変わったかを確かめ、人が承認し直す |
| `担当者として docs/profile.json の owners に載っていません` | git の `user.email` と owners を合わせる。代理なら `--delegate-of <本人> --note "<理由>"` |
| `環境の問題で止まりました`（ログイン切れ・利用上限・コンテナのエンジン・イメージの取得） | 対処してから `pnpm devkit run`（試行には数えない） |
| `検証用のコンテナ（docker）を使えません` | `docker version` が通るようにする（デーモンの起動、利用者を docker グループに入れる、Podman なら `isolation.engine: "podman"`） |
| `AI のサンドボックスを使えません` | Linux なら `sudo apt-get install bubblewrap socat`。コンテナの中で回していて bubblewrap が動かないときは、ランナーを VM か実機で回す（`aiSandbox: "off"` は最後の手段） |
| `保護されたファイルが、ランナーと人のコマンド以外から変わった` | `.devkit/reports/tamper-<時刻>.md` と `git diff` で何が変わったかを確かめる。正しい変更なら人がコミットし、そうでなければ `git checkout -- <ファイル>` で戻す。隔離の設定（`aiSandbox`・`isolation.mode`）を確かめてから `pnpm devkit run` |
| `devkit のコマンドの記録と合わない未コミットの変更があります` | 上と同じ。人が手で `.devkit/` や `docs/decisions.md` を編集した場合も出る（人の判断は devkit のコマンドで残す） |
| `devkit のコマンドとランナーが書いたものではない内容の記録があります（コミット済みのものも含む）` | `git log -p -- <ファイル>` でだれが何を変えたかを確かめる。改ざんなら `git revert` などで戻す。正しい内容（人が手で直した上限など）なら、標準オーナーが端末で `pnpm devkit seal accept --role 技術 --note "<確かめたこと>"` |
| Supervisor が `limit_stop`・`env_stop`・`policy_stop` | `pnpm devkit supervisor status` で理由を見る。原因（上限・ログイン切れ・環境・記録の不整合）を直してから、標準オーナーが端末で `pnpm devkit supervisor clear --role 技術 --note "<直したこと>"` |
| Supervisor が判断の後に再開しない | `pnpm devkit supervisor status` の「次の照合での判断」を見る（一時停止中・時間帯の外・再試行の待ち・計画の承認待ち・作業がない、など）。手動停止（`manual_stop`）なら解除が要る |
| ブリーフィングが届かない | `pnpm devkit supervisor status` の配信の状況。`no_target` は送り先の環境変数がない（`DEVKIT_NOTIFY_CMD`）。`failed` でも `.devkit/briefings/` に保存されている |
| `Claude Code の中からは実行できません` | 人のコマンドは Claude Code の外の端末で実行する（Claude Code の `!` や、Claude Code から開いた端末も断る） |
| `開始時点のコードで検証が通りません` | 統合ブランチで `pnpm verify` を手で実行して直す（雛形・環境・ブラウザ） |
| `別のランナーが実行中です` | 二重起動の防止。落ちたランナーのロックは、プロセスがなく、ハートビートが途絶えていれば次の起動で外れる |
| 同じ作業が何度も不合格 | `pnpm devkit logs` と `.devkit/state.json` の history を見る。goal があいまいなら計画を直して承認し直す。`devkit-diagnose` で調べる |
| `再計画が上限に達した` / `2回続けて進捗がない` | `devkit-diagnose` で原因を調べ、計画を直して人が承認し直し、`pnpm devkit resume` |
| 技術承認が「リリース前検査が通っていない」で断られる | `pnpm standard:release` の結果を見て、運用手順書・担当者・認証方式を整える |
