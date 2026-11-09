# devkit プラグイン

社内標準に沿った開発キット。依頼から仕様と計画を作り、人の承認のあと、ランナーが作業ごとに AI を呼び出して実装・機械検証・独立レビュー・統合を進める。人は業務ゲートと技術ゲートで判断する。夜間の無人実行と状態の確認に対応。

| スキル | 使う人 | 用途 |
| --- | --- | --- |
| `devkit-kickoff` | 業務担当者（依頼を伝えるだけで使われる） | 雛形の用意・聞き取り・仕様・計画・承認の依頼 |
| `devkit-run` | 全員 | ランナーの起動（見守り・夜間）・停止 |
| `devkit-status` | 全員 | 進捗・止まった理由・誰の番か |
| `devkit-gate-review` | 全員 | 人間ゲート・判断依頼の確認の手伝い（承認は端末で） |
| `devkit-init` / `devkit-update` | 開発者・標準オーナー | 案件の用意・更新 |
| `devkit-requirements` / `devkit-tdd` / `devkit-debugging` / `devkit-verification` / `devkit-diagnose` / `devkit-skill-authoring` | — | 作業の作法 |
| `devkit-standard-exception` / `devkit-standard-feedback` | 標準オーナー | 標準の例外・改訂案 |

インストール（社内マーケットプレイスのリポジトリ名に置き換える）:

```
/plugin install devkit --marketplace <owner>/<repo>
```

構成と使い方は、リポジトリ直下の README.md と docs/ を参照。
