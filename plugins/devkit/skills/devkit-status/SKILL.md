---
name: devkit-status
description: devkit で開発中のプロジェクトの進捗・止まった理由・誰の判断待ちか・次にやることを、相手に合わせて分かりやすく説明する。「今どうなってる？」「進捗は？」「止まってる？」「なぜ失敗した？」「夜のあいだに何が進んだ？」と聞かれたときに使う。
---

# 進捗の説明

1. `pnpm -s devkit status --json` を実行する（ランナーの生死・作業とマイルストーンの状態・`waitingFor`・`whoseTurn`・費用）。
2. 夜間の実行のあとなら、定時ブリーフィング（`.devkit/briefings/` の最新の `.md`。なければ `pnpm -s devkit briefing --print`）と、`.devkit/reports/` の最新の実行のまとめも読む。「夜のあいだに何が進んだ？」には、ブリーフィングの「夜間の成果」「今朝判断してほしいこと」「判断後に進む作業」をもとに答える（完了の累計ではなく、その期間に新しく完了したもの）。Supervisor の状態は `pnpm -s devkit supervisor status`。
3. 次の形で **短く** 説明する。相手が業務担当者なら技術用語を使わない（「ノード」ではなく「作業」、「マージ」ではなく「組み込み」）。

```
いま: M2「貸出と返却」を進めています（作業 5 / 9 完了、ランナーは実行中・最終応答 1分前）
誰の番か: AI が作業中 ／ 業務担当者の確認待ち ／ 標準オーナーの判断待ち
次にやること: （1〜2行。人の操作が要るなら、端末で実行するコマンド）
```

## 状態別の説明

- **人の判断待ち**: `waitingFor` の項目ごとに、誰が何を判断するかと、端末で実行するコマンドを示す。確認資料は `.devkit/gates/<ID>.html`。`devkit-gate-review` で確認を手伝えると伝える。
- **ランナーが応答なし**（`ランナー: 停止（応答なし）`）: ランナーが落ちた可能性。`pnpm devkit run` で再開すると、中断した作業を照合してから続ける。
- **止まっている作業**（要再計画・停止）: 作業の `note` と、`.devkit/progress.md` の直近を読み、原因を3行以内で。ランナーは承認済みの範囲で自動で再計画する。人の確認が要る再計画の案は `.devkit/proposals/` にある。
- **停止（進捗なし・再計画の上限）**: `devkit-diagnose` で原因を調べることを提案する。
- **Supervisor が止まっている**（`limit_stop`・`env_stop`・`policy_stop`・`manual_stop`）: `pnpm -s devkit supervisor status` の理由を伝える。解除は、原因を直してから標準オーナーが端末で `pnpm devkit supervisor clear --role 技術 --note "…"`。
- **完了**: 本番リリースまでに人がやること（最終レビュー、デプロイ、本番 DB へのマイグレーション、リリース後に `docs/profile.json` の `released` を true にし `releasedMigration` に最後のマイグレーション名を書く）。

判断の経緯を聞かれたら `docs/decisions.md`（人の判断）と `.devkit/progress.md` の「判断:」（AI が自分で決めたこと）を読んで答える。計画・仕様・標準はこのスキルの中で変更しない。
