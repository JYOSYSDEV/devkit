#!/usr/bin/env node
// プラグインの SessionStart フック。devkit が入っていないフォルダでだけ、使い方を Claude に伝える。
// 入っている案件では何も出さない（案件の .claude/settings.json のフックが状況を伝える）。
// プラグインと案件の実行部品の版が違うときは、更新を案内する。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.DEVKIT_ROLE || process.env.DEVKIT_RUNNER === "1") process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  if (existsSync(join(root, "scripts", "devkit", "devkit.mjs"))) {
    const r = spawnSync(process.execPath, [join(plugin, "scripts", "init.mjs"), "version", "--dir", root, "--json"], { encoding: "utf8", timeout: 5000 });
    const v = JSON.parse(r.stdout || "{}");
    if (v.project && !v.match)
      process.stdout.write(`[devkit] この案件の devkit は ${v.project}、プラグインは ${v.plugin} です。計画や実装を始める前に、利用者に /devkit:devkit-update で更新するか確かめてください（版が違うと、スキルの手順とランナーの動きが合いません）。\n`);
    process.exit(0);
  }
  const entries = readdirSync(root).filter((f) => ![".git", ".DS_Store", "Thumbs.db", "README.md", ".gitignore", "LICENSE", ".claude"].includes(f));
  const looksLikeProject = ["package.json", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "Cargo.toml", "composer.json"].some((f) => entries.includes(f));
  if (entries.length === 0) {
    process.stdout.write(
      "[devkit] このフォルダは空です。システム・アプリ・業務ツールの開発を頼まれたら、実装を始める前に devkit:devkit-kickoff スキルを使ってください（社内標準の雛形の作成、要件の聞き取り、仕様と計画、人の承認、ランナーでの自走）。\n",
    );
  } else if (looksLikeProject) {
    const pkg = entries.includes("package.json") ? readFileSync(join(root, "package.json"), "utf8") : "";
    process.stdout.write(
      `[devkit] このプロジェクトには devkit が入っていません。まとまった開発（複数の機能の追加など）を頼まれたら、devkit:devkit-kickoff スキルで既存プロジェクトへの導入を提案してください${pkg.includes('"next"') ? "" : "（社内標準と技術が違う場合は、標準オーナーと例外か移行かを決めます）"}。小さな修正はそのまま対応してかまいません。\n`,
    );
  }
} catch {
  // フックは邪魔をしない
}
