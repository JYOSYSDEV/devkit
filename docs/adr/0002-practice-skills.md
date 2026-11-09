# ADR-0002: superpowers の作法を devkit のスキルとして取り込む

- 状態: 承認
- 日付: 2026-11-09

## 背景

devkit は全体の進め方（計画・並列実行・統合・outer loop）をコードとスキルで決めているが、1つの作業の中の作法（要件の聞き出し、テスト駆動、デバッグ、完了前の検証、コードレビュー）は CLAUDE.md の数行の規則に頼っていた。[obra/superpowers](https://github.com/obra/superpowers) はこの部分について、評価を重ねたスキルを MIT ライセンスで公開している。

配布するものは devkit だけにしたい（利用者に別のプラグインを入れさせない）。

## 決定

1. superpowers v7.0.2 のうち、devkit に足りない作法を、devkit の流れと標準スタックに合わせて日本語で翻案し、devkit のスキルとエージェントとして同梱する。superpowers のプラグインには依存しない。
   - スキル: `devkit-requirements`、`devkit-tdd`、`devkit-debugging`、`devkit-verification`、`devkit-diagnose`、`devkit-skill-authoring`
   - エージェント: `spec-reader`、`final-reviewer`。`implementer`・`verifier`・`integrator` と devkit-outer-loop の完了処理にも作法を組み込む
2. 計画づくりと実行の系統（writing-plans、subagent-driven-development、executing-plans、dispatching-parallel-agents、using-git-worktrees）は取り込まない。devkit の graph とワークフローが同じ役割を受け持つ。
3. 翻案したファイルには出典を書き、`THIRD_PARTY_NOTICES.md` に MIT ライセンスの全文と元ファイルとの対応を載せる。
4. devkit の標準スキルの名前は `devkit-` で始める（個人のスキルと名前がぶつかると個人のものが優先されるため）。当初の `kickoff` と `outer-loop` もこの規則に合わせて `devkit-kickoff`・`devkit-outer-loop` に改名した（ADR-0003）。

## 検討した選択肢

| 選択肢 | 良い点 | 悪い点 |
| --- | --- | --- |
| superpowers をプラグインとして版固定で入れる | 上流の改善を ref の変更だけで取り込める | 配布物が2つになる。初回に GitHub への接続が要る。devkit と重なるスキルの抑制を CLAUDE.md で続ける必要がある |
| superpowers の流れに全面的に乗る | 上流の流れそのまま | outer loop・graph・goal（並列実行、人間ゲート、上限と停滞検知）が失われる |
| 取り込まない | 変更が少ない | ノードの中の作法の品質が上がらない |
| **必要な部分を翻案して同梱する（採用）** | 配布物は devkit だけ。devkit の流れとスタックに合った具体的な指示にできる。オフラインでも動く | 上流の改善は手で取り込む |

## 影響

- implementer は `devkit-tdd` と `devkit-verification` を、integrator は `devkit-verification` と `devkit-debugging` を最初から読み込む。そのぶん1ノードあたりの使用量が少し増える。
- verifier が品質も判定し、完了処理に最終レビューが加わるので、差し戻しと修正のサイクルが増えることがある。
- 上流の改善を取り込む手順は `docs/devkit/practices.md` の「上流の更新を取り込むとき」に従う。
