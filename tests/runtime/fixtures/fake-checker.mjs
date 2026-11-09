#!/usr/bin/env node
// テスト用の標準チェッカー。--base があれば差分の追加行を見て、PERSONAL を含む行があれば SEC-08（技術）のフラグを出す。
// src に VIOLATION という文字列があれば違反にする。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--base");
const base = i >= 0 ? args[i + 1] : null;
const violations = [];
const flags = [];
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
for (const f of walk(join(process.cwd(), "src"))) if (readFileSync(f, "utf8").includes("VIOLATION")) violations.push({ rule: "SEC-05", file: f, message: "テスト用の違反" });
if (i >= 0) {
  if (!base) flags.push({ rule: "SEC-12", role: "technical", message: "差分を取れない", items: [] });
  else {
    try {
      const diff = execFileSync("git", ["diff", "--text", `${base}`, "--", "src"], { encoding: "utf8" });
      if (/^\+.*PERSONAL/m.test(diff)) flags.push({ rule: "SEC-08", role: "technical", message: "個人情報らしき項目", items: ["src"] });
    } catch {
      flags.push({ rule: "SEC-12", role: "technical", message: "差分を取れない", items: [] });
    }
  }
}
if (args.includes("--release") && existsSync("docs/runbook.md") && readFileSync("docs/runbook.md", "utf8").includes("（記入）")) violations.push({ rule: "OPS-05", file: "docs/runbook.md", message: "未記入" });
console.log(JSON.stringify({ version: "test", ok: violations.length === 0, violations, flags, warnings: [] }));
process.exit(violations.length ? 1 : 0);
