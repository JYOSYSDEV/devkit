# devkit: Claude Code 開発の社内標準テンプレート

このテンプレートからリポジトリを作り、Claude Code に作りたいものを伝えるだけで、計画から実装・検証・統合まで自動で進みます。人が関わるのは、最初の要件の相談（何を・なぜ作るか、作り方の案の選択、仕様書の承認）、計画の承認、要所の承認（人間ゲート）、最後のレビューです。

```
「経費精算アプリを作って」
   ↓ kickoff: 要件の相談（質問は答えで作るものが変わるものだけ、1回に1問）→ 作り方の案を選ぶ → 仕様書を承認
   ↓ kickoff（自動）: mission・graph・goal・loop を設計 → 検証 → 独立レビュー
   ↓ 人が計画を承認
   ↓ outer loop（自動）: ready ノードを並列実装 → 別のエージェントが goal を判定 → 統合 → 次のサイクル
   ↓ 人間ゲートでだけ止まって確認
   ↓ 完了: verify:full → PR 作成の確認
```

4層の考え方は [docs/devkit/model.md](docs/devkit/model.md) を参照してください。

1つ1つの作業の中の作法（要件の聞き出し、テスト駆動、デバッグ、完了前の検証、コードレビュー）も devkit のスキルとして同梱しています（[docs/devkit/practices.md](docs/devkit/practices.md)）。配布物は devkit だけで、追加のプラグインは要りません。

## 必要なもの

- Claude Code（v2.1.311 以降を推奨。`claude --version` で確認、`claude update` で更新）。devkit が使う機能のうち、changelog で版が分かるのは `/goal` のチェックイン（v2.1.234）、ワークフローの作成支援（v2.1.248）、`isolation: worktree` の後片付けの修正（v2.1.311）。社内に展開する前に、使う版で小さなミッションを1つ最後まで流して確かめる。
- Node.js 24 LTS（22.12 以上で可）、pnpm（`corepack enable`）
- Git、GitHub CLI（`gh`。PR を作る場合）
- Docker（開発用の PostgreSQL を動かすため。自動テストと E2E はメモリ上の PGlite で動くので、Claude の自走には不要）

## はじめかた

```bash
# 1. テンプレートから新しいリポジトリを作る（GitHub のテンプレートリポジトリにした場合）
gh repo create my-app --template <org>/devkit-template --private --clone
cd my-app

# 2. 準備
corepack enable
pnpm install
cp .env.example .env
pnpm db:setup        # 開発用 PostgreSQL を起動してマイグレーションを適用
pnpm verify          # 雛形の lint・型チェック・テストが通ることを確認

# 3. Claude Code を起動して、作りたいものを伝える
claude
```

初回の起動時にフォルダを信頼するか聞かれたら許可してください（devkit のフックとスキルが有効になります）。

起動したら、普通に頼むだけです。

```
社内の備品貸出を管理するアプリを作って。貸出・返却・延滞の一覧が欲しい
```

Claude が devkit-kickoff スキルで、まず「なぜ作るのか」を聞き、答えで作るものが変わる点だけを1問ずつ確かめ、作り方の案を示して選んでもらってから、仕様書の承認を求めます。続けて計画（graph）の承認を求めてきます。承認すると自走が始まります。席を外すときは `/loop 30m` を実行しておくと、止まった実行や承認待ちを拾ってくれます。

## よく使う操作

| やりたいこと                   | 操作                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| 状況を見る | `pnpm -s devkit status`（依存の図は `.devkit/graph.md`） |
| 止める                         | Claude に「止めて」、または `pnpm devkit pause`                     |
| 再開する                       | Claude に「再開して」、または `pnpm devkit resume` のあと「続けて」 |
| 人間ゲートを承認する | **端末で** `pnpm devkit approve <ノードID>` のあと Claude に「続けて」。Claude からは実行できない（フックとコマンド自身が止める） |
| サイクル上限に達したあと続ける | **端末で** `pnpm devkit resume --add-cycles <N>`（上限を N 増やして再開）のあと「続けて」。`resume` だけでは再開できない |
| 前のミッションを片付ける | Claude に新しい開発を頼めば `pnpm devkit archive` で片付ける。未完了のミッションを捨てるときは、端末で `pnpm devkit archive` |
| 並列実行の様子を見る           | Claude Code で `/workflows`                                         |
| 1ノードだけ手で `/goal` 実行   | `pnpm devkit goal <ノードID>` で出た行を貼る                        |
| PR の CI・レビュー対応を任せる | `/loop` |
| うまくいかなかった理由を調べる | Claude に「なぜ止まったか調べて」（`devkit-diagnose` が `.devkit/diagnosis/` に報告を書く） |
| `claude --worktree` で作業する | `DEVKIT_MAIN_SESSION=1 claude --worktree <名前>`（付けないとワーカー扱いになり、計画を書き換えられない） |

承認とサイクル上限の追加は、端末からの実行かどうかで人の操作と判断します。Windows の Git Bash などで端末と認識されずに断られる場合は、`DEVKIT_HUMAN_TTYLESS=1 pnpm devkit approve <ノードID>` のように実行します（Claude のコマンドではこの設定をフックが止めます）。

## 構成

```
CLAUDE.md                  Claude が毎回読む作業ルール（標準スタック・禁止事項）
.claude/
  settings.json            権限（許可・確認・禁止）とフック
  skills/devkit-kickoff/     指示 → 4層の自動設計
  skills/devkit-outer-loop/  1サイクルの手順・再計画・完了処理
  skills/devkit-*/           作業の作法（要件の聞き出し・TDD・デバッグ・完了前の検証・不調の診断・スキルの保守）
  workflows/devkit-graph.js  graph を並列実行する dynamic workflow
  agents/                    implementer / verifier / integrator / plan-reviewer / spec-reader / final-reviewer
  hooks/                     編集ガード・コマンドガード（テスト弱体化・シークレット・状態ファイル・共有ファイル・危険な git 操作）と自動整形
  loop.md                    /loop の見張り内容
.devkit/                     計画と状態（mission.md, graph.json, state.json, controls.json, progress.md, learnings.md）
                             controls.json はゲートの記録・人の承認・サイクル上限（devkit だけが書き換える）
scripts/devkit/devkit.mjs    計画の検証・ready 算出・outer loop の自走制御（Stop フック）
scripts/devkit/shared.mjs    devkit とフックが共有する定義（共有ファイルの一覧など）
.dockerignore                Docker のビルドコンテキストから node_modules・.env・worktree などを除く
docs/devkit/               4層モデル、作業の作法、goal と graph の書き方、標準スタック、記入例
docs/spec/                 仕様書（kickoff が作る）
docs/adr/                  技術選定の記録
src/ tests/ e2e/           アプリ本体（Next.js + Drizzle + Vitest + Playwright）
THIRD_PARTY_NOTICES.md     同梱した第三者の成果物のライセンス表示（superpowers 由来のスキル）
```

## 安全のための仕組み

- **権限**: テスト・ビルド・git のローカル操作（作業を失わないもの）は自由。`git push`・PR 作成・依存の追加と更新・Docker・DB のマイグレーションは確認付き。`.env` の読み取り、状態ファイル（`.devkit/state.json`・`.devkit/controls.json`）の直接編集、強制 push、`git reset --hard` は禁止。
- **人間ゲートはコードで守る**: ゲートと承認とサイクル上限は `.devkit/controls.json` に記録され、devkit だけが書き換える。一度記録したゲートは graph.json から外しても効き続け、承認のない before ゲートのノードは着手できない（`dispatch` も `set` も断る）。承認なしで done に書き換えたり、ゲート付きのノードを消したりすると、`pnpm devkit check` と Stop フックが止める。承認とサイクル上限の追加は端末からしか実行できない。
- **編集ガード**（PreToolUse フック `guard-edits`）: テストを skip / only にする編集、テストケースや expect を減らす編集（Edit・MultiEdit・Write のどれでも）、`.env` と状態ファイルの編集、並列ワーカーによる共有ファイルの編集を止める。
- **コマンドガード**（PreToolUse フック `guard-bash`）: 権限ルールのパターンでは区別できないものを止める。承認とサイクル上限の追加、状態ファイルの書き換え、`pnpm install <名前>`（依存の追加になる）、作業を失う git 操作（`git checkout -- .`・`git restore`・`git clean -f`・`git stash drop`・`git branch -D`・`git worktree remove --force`）、強制 push と main への push、ワーカーからの依存の変更・push・PR 操作。
- **独立評価**: ノードの完了は、実装者とは別の verifier エージェントが自分でテストを実行して判定する。仕様との整合と品質（Critical / Important / Minor）も見て、重大な指摘があれば差し戻す。ミッションの最後には全体の最終レビューも行う。
- **暴走防止**: サイクル上限（maxCycles。開始時に記録し、増やせるのは人だけ）、ノード内の往復上限（maxRounds）、試行上限（maxAttempts）、2回続けて進捗がなければ自動停止。
- **共有ファイルの保護**: package.json・CI などはノードに持たせず、計画の承認時にメインセッションが変更する（`pnpm devkit check` とフックの両方で守る。一覧は `pnpm -s devkit shared`）。
- **本番には触れない**: デプロイ・main への push は人間が行う。

## 管理者の方へ（社内展開の準備）

1. **テンプレートリポジトリにする**: zip を展開して `git init && git add -A && git commit -m "devkit template"` し、社内の GitHub Organization に push する。Settings で「Template repository」を有効にする。
2. **dynamic workflows を使えるようにする**: dynamic workflows は有料プランで使える。Pro プランでは利用者が `/config` で有効にする。組織の管理設定で `disableWorkflows` を有効にしていると使えない（その場合も devkit-outer-loop スキルはサブエージェントでの実行に切り替えて動くが、ワークフローとしての並列実行と進捗表示はなくなる）。
3. **フックを許可する**: 管理設定で `disableAllHooks` や `allowManagedHooksOnly` を有効にしていると、Stop フック（outer loop の自走）と `/goal` が動かない。編集ガードとコマンドガードも動かないので、安全の仕組みは権限ルールと devkit のコマンド自身の確認（端末からの承認など）だけになる。devkit を使うリポジトリではプロジェクトのフックを許可する。許可できない場合は `/loop 10m` で outer loop を回す運用になる。
4. **auto モード**: 自走中に確認で止まらないよう、利用者は auto モードで使う（v2.1.283 以降は対話セッションの既定）。プロジェクトの `.claude/settings.json` では auto を既定にできないため、利用者の `~/.claude/settings.json` か起動時の `--permission-mode auto` で指定する。
5. **使用量**: 並列数にほぼ比例して増える。最初は `maxParallel` 2〜3 で運用し、`/workflows` で各エージェントの消費を見てから調整する。
6. **標準の更新**: スキル・エージェント・ワークフローを全リポジトリに配りたくなったら、`.claude/` 部分を社内プラグインにまとめると、テンプレートから作った既存リポジトリにも更新を届けられる。

## 雛形アプリのコマンド

| コマンド                               | 内容                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm db:setup` | 開発用 PostgreSQL（Docker Compose）の起動とマイグレーションの適用 |
| `pnpm dev` | 開発サーバー（先に `pnpm db:setup`） |
| `pnpm verify` | lint + 型チェック + テスト（DB はメモリ上の PGlite） |
| `pnpm verify:full` | verify + ビルド + E2E（初回は `pnpm exec playwright install chromium`。社内ネットワークでダウンロードできなければ `E2E_CHANNEL=chrome` でインストール済みの Chrome を使う）。E2E のサーバーは worktree ごとに別のポート（`E2E_PORT` で指定も可）で起動し、テストは1つずつ順に実行する |
| `pnpm db:generate` / `pnpm db:migrate` | マイグレーションの生成 / 適用                                                       |
