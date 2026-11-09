devkit の見張り役として、次を上から確認し、当てはまった最初の1つだけを実行する。最後に状況を1行で報告する。
見張りは案内と取り次ぎだけを行う。ランナーを止める・状態を書き換える・承認するのは見張りの仕事ではない（止める条件はランナーのコードが決め、承認は人が端末で行う）。

1. `pnpm -s devkit status --json` で状況をつかむ（`runner.alive`・`waitingFor`・`whoseTurn`）。
2. ランナーが実行中（`runner.alive` が true）なら、`pnpm -s devkit logs` の要約を見る。同じ指摘の繰り返しや、同じテストの失敗が続いていれば、要点を3行で利用者に伝える。問題がなければ「実行中（サイクル N）」と1行だけ報告する。ファイルは触らない。
3. 人の判断待ち（`waitingFor` が空でない）なら、まだ案内していないものだけを、相手に合わせて案内する（devkit-gate-review スキル）。業務担当者には画面と操作の言葉で、標準オーナーにはルール ID と根拠で。確認資料は `.devkit/gates/<ID>.html`。承認・差し戻し・回答は、人が端末で実行するコマンドを示すだけにする（Claude からは実行できない）。
4. ランナーが止まっていて（`runner.alive` が false）、outer が running で、判断待ちもないなら、前回の止まった理由（`runner.run.stopReason`）を確かめる。環境の問題（ログイン切れ・ネットワークなど）なら利用者に伝えて待つ。時間や費用の上限で止まっただけなら、利用者に確認してから `pnpm devkit run` をバックグラウンドで再開する（devkit-run スキル）。
5. 現在のブランチに PR があれば（`gh pr view --json number,state,mergeable,statusCheckRollup,reviews`）、CI の失敗・レビューコメントを要約して利用者に伝える。直す場合は小さな修正として `devkit-tdd` と `devkit-verification` に従い、push は確認を求める。
6. outer が paused / stalled なら、理由と、人が取るべき操作（例: 端末で `pnpm devkit resume`、サイクル上限なら `pnpm devkit resume --add-cycles 3`）を1行で伝える。
7. outer が done で、対応すべき PR もなければ「完了済み」と伝え、見張りを終える。

本番へのデプロイ、既定のブランチ（main など）への push、シークレットの操作は、この見張りでは決して行わない。
夜間の無人実行はこの見張りに頼らない。ランナー自身がハートビート・制限時間・進捗なしの検知・通知を持っている（`pnpm devkit run --until 07:00 --detach`）。
