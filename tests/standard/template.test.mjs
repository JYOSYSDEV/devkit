// 実際のアプリのテンプレート（plugins/devkit/templates/app）から作った案件で、自動検査がすべて通ること
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { CHECK, REPO, STANDARD, commitAll, gitInit, remove, run } from "./fixture.mjs";

const PLUGIN = path.join(REPO, "plugins", "devkit");
const TEMPLATE = path.join(PLUGIN, "templates", "app");
const INIT = path.join(PLUGIN, "scripts", "init.mjs");
const SKIP = new Set(["node_modules", ".next", ".next-e2e", "test-results", "playwright-report", ".git"]);

/**
 * 案件を作って git にする。init.mjs があれば利用者と同じ手順（init.mjs new）で作り、
 * なければテンプレートと標準（docs/standard・scripts/standard）を写す
 */
function createProject() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "devkit-template-"));
  const dir = path.join(parent, "app");
  if (existsSync(INIT)) {
    const r = spawnSync(process.execPath, [INIT, "new", "--dir", dir, "--title", "t", "--slug", "t"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    commitAll(dir, "init");
  } else {
    cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    cpSync(STANDARD, path.join(dir, "docs", "standard"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "standard"), { recursive: true });
    cpSync(CHECK, path.join(dir, "scripts", "standard", "check.mjs"));
    gitInit(dir);
  }
  return { dir, cleanup: () => remove(parent) };
}

describe("アプリのテンプレート", { skip: !existsSync(path.join(TEMPLATE, "package.json")) && "テンプレートがない" }, () => {
  test("自動検査がすべて通り、変更がなければフラグも出ない", () => {
    const { dir, cleanup } = createProject();
    try {
      const r = run(dir, ["--base", "HEAD"]);
      assert.equal(r.code, 0, JSON.stringify(r.result?.violations ?? r.stderr, null, 2));
      assert.equal(r.result.ok, true);
      assert.deepEqual(r.result.flags, []);
      assert.deepEqual(r.result.warnings, []);
    } finally {
      cleanup();
    }
  });

  test("リリース前の検査は、テンプレートのままでは通らない（認証・手順書・担当者だけ）", () => {
    const { dir, cleanup } = createProject();
    try {
      const r = run(dir, ["--release"]);
      assert.equal(r.code, 1);
      const ids = [...new Set(r.result.violations.map((v) => v.rule))].sort();
      assert.deepEqual(ids, ["OPS-01", "OPS-05", "SEC-09"]);
    } finally {
      cleanup();
    }
  });
});
