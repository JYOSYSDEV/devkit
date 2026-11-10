# 計画（マイルストーンと作業の依存グラフ）の作り方

`.devkit/graph.json`（version 2）に書きます。記入例は `docs/devkit/examples/expense-app/graph.json` です。書いたら `pnpm devkit check` をエラー0まで通します。

## 全体の形

```json
{
  "version": 2,
  "mission": "紙と Excel の経費精算を Web 化する",
  "spec": "docs/spec/expense-app.md",
  "branch": "devkit/expense-app",
  "verify": "pnpm verify",
  "verifyFull": "pnpm verify:full",
  "dependencies": { "prod": ["date-fns"], "dev": [] },
  "limits": { "maxParallel": 3, "maxRounds": 3, "maxAttempts": 3, "maxReplans": 3, "maxCycles": 12, "taskTimeoutMinutes": 60, "verifyTimeoutMinutes": 30, "lookahead": false },
  "milestones": [
    { "id": "M1", "title": "基盤", "approvers": ["business", "technical"], "foundation": true },
    { "id": "M2", "title": "申請・承認", "approvers": ["business"] },
    { "id": "M3", "title": "受入と本番準備", "approvers": ["business", "technical"], "release": true }
  ],
  "nodes": [ … ]
}
```

| 項目 | 意味 |
| --- | --- |
| `spec` | 仕様書。AC・BR の番号はここで定義する（`- **AC-1** …`） |
| `branch` | 統合ブランチ。作業のブランチはランナーが `<branch>--<ID>-a<試行>` で作る |
| `verify` | 作業ごとの検証コマンド（lint・型・標準チェック・単体テスト） |
| `verifyFull` | マイルストーンの全体検証と `verify: "full"` の作業（＋ビルド・E2E） |
| `dependencies` | 追加する依存パッケージ。許可リスト（`docs/standard/dependencies.json`）にあるものだけ。開始の前にメインセッションが `pnpm add` する |
| `limits.maxCycles` | 開始時に `.devkit/controls.json` に記録され、増やせるのは人の `pnpm devkit resume --add-cycles` だけ |
| `limits.lookahead` | true なら、マイルストーンの承認待ちの間も、次のマイルストーンの作業を先に進める（夜間に業務ゲートで止まらない。差し戻されると手戻りが増える） |

## マイルストーン

| 項目 | 意味 |
| --- | --- |
| `approvers` | 計画で決めておく承認者（`business` / `technical`）。変更内容から見つかったもの（外部接続・個人情報・権限表・安全の中心・データモデル）はランナーが足す。一度記録した承認者は外れない |
| `foundation` | 最初のマイルストーン。データモデルと共通の契約を確定する。承認者に technical を含める。このマイルストーンの後のデータモデルの変更は、技術ゲートになる |
| `release` | 最後のマイルストーン（必須）。全体検証に、リリース前検査（`pnpm standard:release`）と最終レビュー（AI）が加わる。承認者は business と technical の両方。技術の承認にはリリース前検査の合格が要る |

1マイルストーン = 業務担当者が1回で確認できる量（画面で触れる何かが増えている状態）。小さな業務ツールで 2〜4 個。

## 作業（ノード）

```json
{
  "id": "N2",
  "milestone": "M2",
  "title": "申請の作成・一覧（申請者）",
  "deps": ["N1"],
  "owns": ["src/server/expense.ts", "src/app/(app)/expenses/**", "tests/unit/expense.test.ts"],
  "spec": "docs/spec/expense-app.md#AC-1",
  "acceptance": ["AC-1", "AC-2", "BR-1"],
  "goal": "…（goal-rules.md のテンプレート）…"
}
```

| 項目 | 意味 |
| --- | --- |
| `deps` | 先に完了している必要がある作業（同じか前のマイルストーンのもの） |
| `owns` | 変更してよいパス（glob。`*`・`**`・`?`・`{a,b}`。`[id]`・`[...slug]` は Next.js の動的セグメントとして文字どおり）。ランナーの機械検証は、この外の変更を不合格にする |
| `acceptance` | この作業が満たす AC・BR。仕様書のすべての AC・BR が、ちょうど1つの作業に割り当たること（`check` が確かめる）。ランナーは、番号を名前に含み、実行されて合格したテストで照合する |
| `verify` | `standard`（既定。`verify` を実行）か `full`（`verifyFull` を実行し、E2E の AC もこの作業で照合する） |
| `before` | 着手の前に承認が要る役割（外部の資格情報・費用・人の判断が要る作業） |
| `allowTestRemoval` | 削除してよいテストファイル（基盤のマイルストーンで、雛形の見本を消すときだけ）。そのノードの `owns` にも入れる。実装担当は `git rm` でファイルごと削除する（ガードと機械検証は、この一覧にあるテストの削除だけを通す） |

graph.json に実行の状態（`status`・`attempts`）や承認（`approved`）は書きません（`check` がエラーにする）。状態は `.devkit/state.json`、承認は `.devkit/controls.json` に devkit が記録します。

## 標準の形

```
M1 基盤（foundation）     N1 スキーマ・役割と権限・利用者の契約・共通レイアウト・見本の削除
M2 機能                    N2 機能A ─┐ N3 機能B ─┤ N4 機能C ─┘   （並列）
M3 受入と本番準備（release） N5 外部連携（before: technical）  N6 結合・E2E（verify: full）・runbook の技術的な節
```

## 並列にしてよい条件（3つすべて）

1. **契約が先に決まっている**: スキーマ・型・関数の形が前の作業で確定している
2. **担当パスが重ならない**: `owns` が重なる作業は、ランナーが同時に実行しない
3. **依存をテストで切れる**: 他の作業の完成を待たずにテストが書ける

## 作業では変えられないもの

- 共有ファイル（一覧は `pnpm -s devkit shared`）: package.json・lock・設定ファイル・CI・`.claude/`・`.devkit/` など。依存パッケージは `dependencies` に書き、その他の共有ファイルの変更は、開始の前にメインセッションが行う
- 保護されたパス: 仕様書（`docs/spec/`）・社内標準（`docs/standard/`）・人の判断の記録・devkit 自身・テストの設定（vitest・playwright）・`.npmrc`・`.gitattributes`・`.gitignore`
- 作業の途中で必要になったら、実装担当は報告の `needs` か判断依頼（request）で返し、ランナーが再計画か人の判断に回す

## 基盤に置く契約

後続の作業が共通に使うもの（DB のテーブル、環境変数のスキーマ、ログイン中の利用者の型、権限表、共通レイアウト）は、すべて基盤のマイルストーンの作業の owns に入れて先に決めます。後の作業がそれらを変える必要が出るなら、分け方が誤っています。

- DB スキーマとマイグレーション（`src/db/**`・`drizzle/**`）、環境変数（`src/lib/env.ts`・`.env.example`）、権限表（`src/server/auth/permissions.ts`）
- ログイン中の利用者の型と取得関数の形（`getCurrentUser()`）。認証の接続は後の作業が同じ形のまま差し替える
- DB を読む画面は `src/app/(app)/` の下に置く（`force-dynamic`。`next build` のときに DB へ接続しない）
- データの更新は `defineAction`（権限・入力検証・監査を共通化）、画面と API の入口は `requirePermission` / `requireUser` / `allowAnonymous`（社内標準 02-design）

## 大きさの目安

- 1作業の AC・BR は 2〜5 個、変更ファイルは 15 個程度まで
- 全体で 4〜12 作業。これを超えるならミッションを分ける
- 並列数は 2〜3 から始める（使用量は並列数にほぼ比例する）
