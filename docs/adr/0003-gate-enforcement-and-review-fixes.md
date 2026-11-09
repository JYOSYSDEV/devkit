# ADR-0003: 人間ゲートをコードで守り、レビューで見つかった運用上の穴をふさぐ

- 状態: 承認
- 日付: 2026-11-09

## 背景

devkit-template v2 のレビューで、次の問題が見つかった。

1. 人間ゲートを、説明のとおりにはコードで守れていなかった。`pnpm devkit set` は未承認の before ゲートのノードでも running / done にでき、許可リストに入っているので確認も出なかった。メインセッションは graph.json を直接編集して `"approved": true` を書けた。
2. maxCycles に達したあと `pnpm devkit resume` しても、すぐに一時停止に戻った。上限を増やす手段がなかった。
3. ノードブランチ名 `devkit/<ID>-c<サイクル>` がミッションをまたいでぶつかり、前のミッションの作業を「続き」と取り違えるおそれがあった。
4. DB を読む画面が `next build` でプリレンダリングされ、ビルドが失敗するか、ビルド時点のデータで固定される落とし穴が、雛形にも文書にもなかった。
5. Dockerfile に `.dockerignore` がなく、手元の node_modules（別の OS 用のバイナリ）がイメージの中のものを上書きしていた。`.env` と worktree もビルドコンテキストに入っていた。
6. 編集ガードは Write と MultiEdit のとき expect の減少を確かめていなかった。
7. 記入例の N5（SSO）は、必要なテーブルと環境変数が他のノードの担当で、構造的に完了できなかった。
8. `kickoff` と `outer-loop` が、ADR-0002 の「`devkit-` で始める」規則に反していた。
9. `Bash(pnpm install*)` の許可が `pnpm install <名前>`（依存の追加）にも当てはまっていた。`git checkout -- .` などの作業を失う操作が許可されていた。
10. owns の検証が Next.js の catch-all ルート（`[...slug]`）を拒否していた。
11. E2E が、同じポートで動いている別の worktree のサーバーを黙って使い回すことがあった。テストを並列に実行していたので、共有する DB でデータが混ざった。
12. ワーカーかどうかを `CLAUDE_PROJECT_DIR` とパスで判定していた。
13. 文書の食い違いがあった（質問の回数、Enterprise での dynamic workflows、最低バージョン、共有ファイルの一覧）。

## 決定

1. **人の決定を `.devkit/controls.json` に分ける。** 中身は、ゲートの記録（graph に現れたゲートを足すだけで、消さない）、人の承認（before / after ごと）、サイクル上限。devkit.mjs だけが書き換える。
   - 状態遷移は `set` で強制する。未承認の before ゲートは running にできない。done にできるのは running か review からだけ。
   - 承認のない done、ゲート付きノードの削除、graph.json の `approved` は、`check` と Stop フックがエラーにする。
   - `approve` と `resume --add-cycles` は端末（TTY）からだけ実行できる。
   - PreToolUse の Bash フック（`guard-bash.mjs`）が、Claude からの実行と、状態ファイルの書き換えを止める。Edit / Write での編集は、`guard-edits.mjs` と deny ルールが止める。
2. サイクル上限は `start` のときに記録する。増やせるのは人の `pnpm devkit resume --add-cycles <N>` だけ。graph.json の `limits.maxCycles` を書き換えても上限は変わらない。
3. ノードブランチは dispatch が `<統合ブランチ>--<ID>-c<サイクル>` の名前で決めて graph に記録する。ラウンド 1 で同じ名前のブランチが既にあれば、実装者は使わずに blocked で報告する。前のミッションは `pnpm devkit archive` で片付ける。
4. DB を読む画面の置き場所として `src/app/(app)/`（`force-dynamic`）を雛形に用意する。ビルド中に `getDb()` が呼ばれたら、原因の分かるエラーで止める。
5. `.dockerignore` を追加する。Dockerfile では `HOSTNAME=0.0.0.0` と `PORT` を指定する。
6. 編集ガードは、Write ならディスク上の元のファイル全体と比べ、MultiEdit なら edits 配列を見る。skip / only の追加、expect とテストケース（it / test）の減少を止める。
7. 記入例は、認証用テーブル・環境変数・`getCurrentUser()` の形を N1（基盤）に置き、N5 はその形のまま接続部分だけを持つ形にする。
8. `kickoff` を `devkit-kickoff` に、`outer-loop` を `devkit-outer-loop` に改名する。
9. 許可は `pnpm install --frozen-lockfile` に絞る。依存の更新系（`pnpm up` / `update` / `dlx` など）は確認付きにする。作業を失う git 操作、強制 push、main への push、ワーカーからの依存変更・push・PR 操作は `guard-bash.mjs` が止める。
10. owns の `..` はパスの区切りごとに判定する。`[...]` はフォルダ名として扱う。
11. E2E は worktree ごとに別のポートで起動し、既存のサーバーを使い回さない。テストは1つずつ順に実行する。
12. ワーカーの判定は「プロジェクトの中に置かれた git worktree（`.git` がファイル）」で行う。フックは入力の `cwd` を基準にする。プロジェクトの外に人が作った worktree はワーカー扱いしない。
13. 共有ファイルの一覧は `scripts/devkit/shared.mjs` の1か所で定義し、`pnpm -s devkit shared` で表示する。文書の食い違いは直す。
14. そのほかの細かな直し:
    - 整形フックを `biome check --write` にする（import の並べ替えも当てる）。
    - `drizzle.config.ts` で `.env` を読む。
    - Vitest で `.test.tsx` も実行する。
    - `state.json` と `controls.json` をコミットする。
    - goal の検査の誤判定を減らす。
    - 既定のブランチを `main` と決め打ちしない。

## 検討した選択肢

| 選択肢 | 良い点 | 悪い点 |
| --- | --- | --- |
| 権限ルール（ask / deny）だけで承認を守る | 変更が少ない | コマンドの書き方を変えると当てはまらない。graph.json の直接編集を止められない |
| graph.json の編集をフックで比べて、ゲートの解除を止める | ファイルが増えない | 複数回の編集や Bash での書き換えで比べる基準がずれる |
| **人の決定を別ファイルに分け、devkit.mjs が記録と強制を行う（採用）** | ゲートは足すだけで消えないので、graph.json をどう書き換えても効く。強制が1か所のコードにまとまる | ファイルが1つ増える。前のミッションの片付けに archive が要る |

承認を端末からだけにしたので、「Claude に『N4 を承認』と頼むと確認が出る」という v2 の運用はなくなる。利用者は端末で `pnpm devkit approve` を実行する。

## 影響

- 既存の v2 のリポジトリに入れるときは、`.claude/`・`scripts/devkit/`・`docs/devkit/` を差し替える。進行中のミッションがあれば、`pnpm devkit start` を一度実行して、ゲートとサイクル上限を `controls.json` に記録する。graph.json に `approved` が残っていると check がエラーになるので消し、承認済みのノードは人が `pnpm devkit approve` し直す。
- 元に戻す方法: このコミットを revert する。`controls.json` は v2 の devkit.mjs からは無視される。
