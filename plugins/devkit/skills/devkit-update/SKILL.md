---
name: devkit-update
description: 案件の devkit の実行部品と社内標準を、このプラグインの版に更新する。プラグインと案件の版が違うと案内されたとき、「devkit を最新にしたい」「標準の版を上げたい」と言われたときに使う（標準オーナーの判断で行う）。
disable-model-invocation: true
---

# devkit-update: 実行部品と社内標準を更新する

案件は作成時の版に固定されています。新しい版に上げるのは、標準オーナーの判断で行う作業です。

1. 版を比べる: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" version --dir . --json`。一致していれば「最新です」と伝えて終える。
2. ランナーが止まっていることを確かめる（`pnpm -s devkit status`）。
3. 変更点を示す: プラグインの `CHANGELOG.md` と、`runtime/docs/standard/CHANGELOG.md` のうち、案件の版より新しい節を要約する。
4. 試す: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" update --dir . --dry-run` で、入れ替わるファイル・案件で手を入れたため残るファイルを示す。新しい版の標準で出る違反は、更新の後の `pnpm standard:check` で分かる。
5. 利用者（標準オーナー）に確かめる: 「今すぐ上げる」「違反を直すマイルストーンを計画に足してから上げる」「今回は上げない」。
6. 上げる場合:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" update --dir .
   pnpm install --frozen-lockfile
   pnpm standard:check
   pnpm verify
   ```
   - 「残した（新しい版は .devkit-new）」と出たファイルは、案件で手を入れていたもの。差分を利用者と見て、統合したら `.devkit-new` を消す。
   - 進行中の計画（graph.json）の形式が変わる版なら、CHANGELOG の移行手順に従う。計画を書き換えたら、人がもう一度 `pnpm devkit approve plan` する。
   - `git add -A && git commit -m "devkit: <旧> → <新> に更新"`
7. 判断を記録する: 版の更新は、標準オーナーが端末で判断の記録（`docs/decisions.md`）に残す。Claude からは実行できないので、利用者にコマンドを伝える:
   ```bash
   pnpm devkit record --role 技術 --target "devkit・社内標準の更新" --decision "<旧> → <新>" --note "<理由>"
   ```
