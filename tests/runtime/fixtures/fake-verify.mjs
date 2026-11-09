#!/usr/bin/env node
// テスト用の検証コマンド。tests/**/*.test.js を読み、test("名前") ごとに結果を決めて vitest 形式の JSON を書く。
// ファイルに「// FAIL」があれば失敗、test.skip などは skipped。--full なら e2e/*.spec.js を Playwright 形式で書く。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";

const root = process.cwd();
// コンテナの中で実行したとき（偽のエンジン）、結果のパスはコンテナから見たもの（/work/...）にする
const inner = process.env.FAKE_INNER_ROOT || root;
const shown = (p) => (inner === root ? p : posix.join(inner, relative(root, p).replaceAll("\\", "/")));
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
let failed = 0;
const testResults = [];
for (const f of walk(join(root, "tests")).filter((p) => p.endsWith(".test.js"))) {
  const text = readFileSync(f, "utf8");
  const assertionResults = [];
  for (const m of text.matchAll(/\btest(\.\w+)?\(\s*"([^"]+)"/g)) {
    const status = m[1] ? "skipped" : text.includes("// FAIL") ? "failed" : "passed";
    if (status === "failed") failed++;
    assertionResults.push({ fullName: m[2], title: m[2], status });
  }
  testResults.push({ name: shown(f), assertionResults });
}
mkdirSync(join(root, "test-reports"), { recursive: true });
writeFileSync(join(root, "test-reports", "vitest.json"), JSON.stringify({ testResults }));
if (process.argv.includes("--full")) {
  const suites = [];
  for (const f of walk(join(root, "e2e")).filter((p) => p.endsWith(".spec.js"))) {
    const text = readFileSync(f, "utf8");
    const rel = f.slice(join(root, "e2e").length + 1);
    const specs = [...text.matchAll(/\btest\(\s*"([^"]+)"/g)].map((m) => ({ title: m[1], ok: !text.includes("// FAIL"), tests: [{ status: text.includes("// FAIL") ? "unexpected" : "expected", annotations: [] }] }));
    if (text.includes("// FAIL")) failed++;
    suites.push({ title: rel, file: rel, specs, suites: [] });
  }
  writeFileSync(join(root, "test-reports", "e2e.json"), JSON.stringify({ config: { rootDir: shown(join(root, "e2e")) }, suites }));
  if (process.env.E2E_SCREENSHOT_DIR) {
    mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
    // 1x1 の PNG
    writeFileSync(join(process.env.E2E_SCREENSHOT_DIR, "smoke.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  }
}
console.log(`tests: ${testResults.reduce((n, r) => n + r.assertionResults.length, 0)} failed: ${failed}`);
process.exit(failed ? 1 : 0);
