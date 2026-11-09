#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) フック: 編集されたファイルに Biome の整形と安全な修正（import の並べ替えなど）を当てる。
// `pnpm lint`（biome check）と同じ基準にそろえるため `biome check --write` を使う。失敗しても作業は止めない。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const file = input.tool_input?.file_path;
if (!file || !/\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(file)) process.exit(0);
if (/[\\/](\.devkit|\.claude[\\/]workflows|node_modules|drizzle)[\\/]/.test(file)) process.exit(0);

// 編集されたファイルから上にたどって biome.json と biome 本体を探す（worktree でも動くように）
let dir = dirname(file);
let root = null;
for (let i = 0; i < 20; i++) {
  if (existsSync(join(dir, "biome.json"))) {
    root = dir;
    break;
  }
  const up = dirname(dir);
  if (up === dir) break;
  dir = up;
}
if (!root) process.exit(0);

const candidates = [
  join(root, "node_modules", ".bin", "biome"),
  join(process.env.CLAUDE_PROJECT_DIR ?? root, "node_modules", ".bin", "biome"),
];
const bin = candidates.find((p) => existsSync(p) || existsSync(`${p}.cmd`));
if (!bin) process.exit(0);

spawnSync(bin, ["check", "--write", "--no-errors-on-unmatched", file], {
  cwd: root,
  stdio: "ignore",
  timeout: 20_000,
  shell: process.platform === "win32",
});
process.exit(0);
