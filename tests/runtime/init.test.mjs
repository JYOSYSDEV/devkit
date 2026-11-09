import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNTIME } from "./helpers.mjs";

const INIT = join(RUNTIME, "..", "scripts", "init.mjs");
const run = (...args) => spawnSync(process.execPath, [INIT, ...args], { encoding: "utf8" });

test("new: 雛形と実行部品を入れ、版を記録する", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-init-"));
  const r = run("new", "--title", '備品"貸出{', "--slug", "equipment", "--dir", dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ["package.json", "scripts/devkit/devkit.mjs", ".claude/settings.json", ".claude/hooks/guard-bash.mjs", "docs/profile.json", ".devkit/version.json", ".devkit/learnings.md"]) assert.ok(existsSync(join(dir, f)), f);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "equipment");
  const profile = JSON.parse(readFileSync(join(dir, "docs", "profile.json"), "utf8"));
  assert.ok(!profile.project.includes('"') && !profile.project.includes("{"), "引用符・波かっこは置き換える");
  const v = run("version", "--dir", dir, "--json");
  assert.equal(JSON.parse(v.stdout).match, true);
});

test("new: 空でないフォルダには作らない", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-init-"));
  writeFileSync(join(dir, "app.py"), "print(1)\n");
  assert.notEqual(run("new", "--title", "x", "--dir", dir).status, 0);
});

test("update: 手を入れていないファイルは入れ替え、手を入れたものは .devkit-new を置く", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-init-"));
  run("new", "--title", "x", "--slug", "x", "--dir", dir);
  const vf = join(dir, ".devkit", "version.json");
  const rec = JSON.parse(readFileSync(vf, "utf8"));
  // 古い版を装う: 実行部品の1つを「古い内容」にし、記録のハッシュも合わせる → 入れ替わるはず
  const loop = join(dir, ".claude", "loop.md");
  writeFileSync(loop, "古い内容\n");
  rec.files[".claude/loop.md"] = require_sha(loop);
  // 案件で手を入れたファイル（記録のハッシュと違う）→ 残すはず
  const guard = join(dir, ".claude", "hooks", "format-file.mjs");
  writeFileSync(guard, "// 案件で直した\n");
  rec.version = "3.9.0";
  writeFileSync(vf, JSON.stringify(rec));
  const r = run("update", "--dir", dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.notEqual(readFileSync(loop, "utf8"), "古い内容\n");
  assert.equal(readFileSync(guard, "utf8"), "// 案件で直した\n");
  assert.ok(existsSync(`${guard}.devkit-new`));
});

test("adopt: 既存のアプリのコードは変えない", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-init-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "legacy", scripts: { test: "jest" } }));
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  const r = run("adopt", "--title", "既存", "--dir", dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(dir, "index.js"), "utf8"), "module.exports = 1;\n");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "jest");
  assert.equal(pkg.scripts.devkit, "node scripts/devkit/devkit.mjs");
});

import { createHash } from "node:crypto";
function require_sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
