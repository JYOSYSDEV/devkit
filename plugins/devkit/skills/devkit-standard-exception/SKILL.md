---
name: devkit-standard-exception
description: 社内標準の例外を承認・登録する（標準オーナーが使う）。ADR を書き、標準オーナーが端末で例外を登録する手順を案内する。「この依存を例外で許可したい」「この接続先を認める」「標準の例外を登録したい」と言われたときに使う。
disable-model-invocation: true
argument-hint: "[例外にしたい内容]"
---

# 社内標準の例外を登録する

対象: $ARGUMENTS

例外は「この案件に限り、このルールのこの対象を違反として扱わない」という標準オーナーの判断です。AI が自分の判断で登録することはできません（`docs/exceptions.json` は Claude からは編集できず、登録のコマンドは人が端末で実行する）。

## 手順

1. 何の例外かを決める。判断依頼（`.devkit/requests/<ID>.md`）から来た場合はそれを読む。

   | 例外の種類 | rules | subject |
   | --- | --- | --- |
   | 許可リストにない依存 | TECH-01 | `dependency:<パッケージ名>` |
   | 新しい外部接続先 | ESC-02 | `host:<ホスト名>`（通常は docs/profile.json の externalHosts への登録で足りる） |
   | リリース後の破壊的マイグレーション | OPS-04 | `migration:<ファイル名>` |
   | 特定ファイルでの禁止 API | SEC-03 / SEC-04 / SEC-05 | `file:<パス>` |
   | 認証なしで公開する | SEC-09 | `auth:none`（docs/profile.json の auth も none にする） |
   | ルール全体をこの案件で外す（既存システムへの導入時など） | 対象のルール | `*`（乱用しない。移行の計画と見直し期限を ADR に書く。ESC-06 は外せない） |

2. 標準オーナー本人に、理由・代わりにとる対策・見直し期限（日付）を確かめる。
3. ADR を書く: `docs/adr/<次の番号>-<短い英語名>.md`（`docs/adr/_template.md` の形式。背景・選択肢と比較・決定・影響と対策・見直す時期）。
4. 標準オーナーに、端末で次を実行してもらう（ADR のコミットも一緒に行われる）:

   ```bash
   pnpm devkit exception add --rules TECH-01 --subject dependency:papaparse \
     --reason "<一行の理由>" --adr docs/adr/0004-papaparse.md --review-by 2027-05-31 --role 技術
   ```

   必須項目がそろわない例外は適用されず、`pnpm standard:check` が ESC-06 の違反として表示する。見直し期限を過ぎると、普段は注意、リリース前検査では違反になる。

5. `pnpm standard:check` で、その違反が消えたことを確かめる。
6. 判断依頼（種別が技術のもの）で止まっていた作業があれば、標準オーナーが端末で `pnpm devkit answer <ノード> --role 技術 --request <依頼の ID> --note "EXC-xxx で承認済み。<補足>"` を実行する（依頼の ID は `.devkit/requests/<ノード>.md` の先頭）。

## 注意

- 同じ種類の例外が3案件以上で出たら、標準そのものの改訂の候補として `devkit-standard-feedback` で提案する。
- 例外は案件の中でだけ有効。ほかの案件には引き継がれない。
