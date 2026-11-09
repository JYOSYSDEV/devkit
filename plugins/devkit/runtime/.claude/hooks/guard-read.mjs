#!/usr/bin/env node
// PreToolUse(Read|Grep|Glob) フック: 秘密情報（.env と .env.*。.env.example を除く）を読まない。
// 権限ルールの deny（Read(./.env) など）は書き方が限られるので、Bash・Edit のガードと同じ判定でここでも止める。
import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const ti = input.tool_input ?? {};
const candidates = [ti.file_path, ti.path, ti.pattern, ti.glob].filter((x) => typeof x === "string" && x);

function isSecret(p) {
  const base = p.replaceAll("\\", "/").split("/").pop() ?? "";
  if (base === ".env.example") return false;
  if (/^\.env(\.|$)/.test(base)) return true;
  // glob で .env を含みうるもの（.env*、.e*、*.local など）
  if (/^\.e[*?]|^\.en[*?]|^\.env[*?]/.test(base)) return true;
  return false;
}

if (candidates.some(isSecret)) {
  process.stderr.write("[devkit guard] .env（秘密情報）は読まない。必要な設定は .env.example と src/lib/env.ts を見る。値は人に設定を依頼する。\n");
  process.exit(2);
}
process.exit(0);
