# デバッグの補助技法

## 根本原因の追跡

不具合は呼び出しの深いところで表に出ることが多い（誤ったディレクトリでの処理、誤った ID での更新）。表に出た場所で直したくなるが、それは症状の手当て。

1. **症状を観察する。** 例: `insert or update on table "approvals" violates foreign key constraint`
2. **直接の原因を探す。** その操作をしているコードはどこか。例: `transition()` が `expenseId` で `approvals` に insert している。
3. **誰がそれを呼んだかをたどる。** 例: `approveAction()` → `transition(db, form.get("id"))` → フォームの hidden 項目が一覧の行番号を送っている。
4. **さらに上へ。** その値はどこで作られたか。誤った値が最初に生まれた場所まで上る。
5. **発生源で直す。** そのうえで、下の「多層の検証」で同じ不具合が二度と通らないようにする。

たどれないときは、怪しい関数の入口に一時的なログ（受け取った引数と呼び出し元のスタック）を入れて1回動かす。調べ終わったらログは消す。

## 多層の検証

誤ったデータが原因の不具合を直したら、1か所の検証で満足しない。別の経路やリファクタリングで素通りされる。データが通る層ごとに確かめ、不具合を **構造的に起こりえない** ものにする。

| 層 | 目的 | このリポジトリでの例 |
| --- | --- | --- |
| 入口 | 明らかに誤った入力を API の境界で拒否する | Server Action とルートハンドラの Zod スキーマ |
| 業務ロジック | その操作として意味が通るかを確かめる | `src/server/` の関数で、状態遷移や権限を確かめる |
| 環境の保護 | 特定の状況での危険を防ぐ | 本番で `DATABASE_URL` が未設定なら起動しない（`src/lib/env.ts`） |
| DB | 最後の砦 | NOT NULL、CHECK 制約、外部キー、一意制約 |

## 条件を待つテスト

決め打ちの待ち時間（`setTimeout`、`page.waitForTimeout`）は、速いマシンでは通り、遅い CI や並列実行で落ちる。

- 待つべき **条件そのもの** を待つ。Playwright なら `await expect(locator).toBeVisible()` や `await page.waitForResponse(...)` のように自動で待つ API を使う。
- Vitest で非同期の結果を待つなら `await vi.waitFor(() => expect(...).toBe(...))`。
- タイミングそのもの（間引き、遅延実行）を確かめるテストでは、偽のタイマー（`vi.useFakeTimers()`）を使う。
- どうしても固定の待ち時間が要るなら、なぜ要るかをコメントに書く。

## テスト間の汚染の特定

単独では通るのに、全体で回すと落ちるテストは、別のテストが残した状態（共有の変数、DB、環境変数、偽のタイマー）に汚染されている。

1. 落ちるテストを単独で実行して通ることを確かめる: `pnpm exec vitest run <ファイル> -t "<テスト名>"`
2. テストファイルを半分ずつ組み合わせて実行し（二分探索）、一緒に回すと落ちる相手のファイルを絞り込む。
3. 相手のファイルが何を後片付けしていないかを探す（`afterEach` の不足、モジュールレベルの変数、`vi.useFakeTimers()` の戻し忘れ、`createTestDb()` を使わない共有 DB）。
4. 汚染する側を直す。落ちる側で「順番に依存しない」ように取り繕わない。

---

出典: obra/superpowers v7.0.2 の systematic-debugging（root-cause-tracing.md、defense-in-depth.md、condition-based-waiting.md、find-polluter.sh）を devkit 向けに翻案（MIT License, Copyright (c) 2025 Jesse Vincent）。詳細は `THIRD_PARTY_NOTICES.md`。
