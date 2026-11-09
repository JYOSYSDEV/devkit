// テンプレートと同じ構成の案件で、すべての自動検査が通ること。引数と出力の約束
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  CHECK,
  STANDARD,
  commitAll,
  gitInit,
  makeProject,
  releaseReady,
  remove,
  run,
  runText,
  templateFiles,
  write,
} from "./fixture.mjs";

const RULES_JSON = JSON.parse(readFileSync(path.join(STANDARD, "rules.json"), "utf8"));
const AUTO = RULES_JSON.rules.filter((r) => r.check === "auto");
const VERSION = RULES_JSON.version;

describe("テンプレートの構成（基準）", () => {
  test("git の外でも、すべての自動検査が通る", () => {
    const dir = makeProject();
    try {
      const { code, result } = run(dir);
      assert.equal(code, 0, JSON.stringify(result?.violations, null, 2));
      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);
      assert.deepEqual(result.flags, []);
      assert.deepEqual(result.warnings, []);
      for (const r of AUTO.filter((r) => !r.release)) assert.ok(result.checked.includes(r.id), `${r.id} が検査されていない`);
      assert.equal(result.release, false);
    } finally {
      remove(dir);
    }
  });

  test("git の中で --base HEAD（変更なし）ならフラグもない", () => {
    const dir = makeProject();
    try {
      gitInit(dir);
      const { code, result } = run(dir, ["--base", "HEAD"]);
      assert.equal(code, 0, JSON.stringify(result?.violations, null, 2));
      assert.deepEqual(result.flags, []);
      for (const id of ["ESC-02", "ESC-03", "SEC-08", "SEC-12", "DATA"]) assert.ok(result.checked.includes(id), id);
    } finally {
      remove(dir);
    }
  });

  test("リリースの準備ができた案件は --release も通る（リリース前の検査を含む）", () => {
    const dir = makeProject(releaseReady(templateFiles()));
    try {
      gitInit(dir);
      const { code, result } = run(dir, ["--release"]);
      assert.equal(code, 0, JSON.stringify(result?.violations, null, 2));
      assert.equal(result.release, true);
      for (const r of AUTO) assert.ok(result.checked.includes(r.id), `${r.id} が検査されていない`);
    } finally {
      remove(dir);
    }
  });

  test("テンプレートのままでは --release が通らない（開発用の認証・未記入の手順書・担当者）", () => {
    const dir = makeProject();
    try {
      const { code, result } = run(dir, ["--release"]);
      assert.equal(code, 1);
      const ids = new Set(result.violations.map((v) => v.rule));
      for (const id of ["SEC-09", "OPS-05", "OPS-01"]) assert.ok(ids.has(id), id);
    } finally {
      remove(dir);
    }
  });

  test("案件のサブディレクトリから実行しても、ルートを見つける", () => {
    const dir = makeProject();
    try {
      const { code, result } = run(dir, [], { cwd: path.join(dir, "src", "server") });
      assert.equal(code, 0);
      assert.equal(result.ok, true);
    } finally {
      remove(dir);
    }
  });

  test("テキストの出力は合格を表示する", () => {
    const dir = makeProject();
    try {
      const { code, stdout } = runText(dir);
      assert.equal(code, 0);
      assert.match(stdout, new RegExp(`✓ 標準 ${VERSION.replace(/\./g, "\\.")}: 自動検査 ${AUTO.filter((r) => !r.release).length} 項目に合格`));
    } finally {
      remove(dir);
    }
  });
});

describe("引数と終了コード", () => {
  test("知らない引数は終了コード 2", () => {
    const dir = makeProject();
    try {
      const r = runText(dir, ["--bsae", "HEAD"]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /知らない引数/);
    } finally {
      remove(dir);
    }
  });

  test("標準が見つからなければ終了コード 2", () => {
    const dir = makeProject(templateFiles(), { withStandard: false });
    try {
      assert.equal(runText(dir).code, 2);
    } finally {
      remove(dir);
    }
  });

  test("--list はルール一覧を出し、検査しない", () => {
    const dir = makeProject();
    try {
      const r = runText(dir, ["--list"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^TECH-01 +\[自動検査\] /m);
      assert.match(r.stdout, /^SEC-09 +\[自動検査（リリース前）\] /m);
      const md = runText(dir, ["--list", "--markdown"]);
      assert.match(md.stdout, /^\| ID \| 層 \| ルール \| 確かめ方 \|$/m);
    } finally {
      remove(dir);
    }
  });

  test("--standard で別の版の標準を使う（案件の標準より優先）", () => {
    const dir = makeProject();
    try {
      // 案件の標準が古く、zod を許可していないとする
      const depsFile = path.join(dir, "docs", "standard", "dependencies.json");
      const deps = JSON.parse(readFileSync(depsFile, "utf8"));
      delete deps.core.zod;
      writeFileSync(depsFile, JSON.stringify(deps));
      const old = run(dir);
      assert.equal(old.code, 1);
      assert.ok(old.result.violations.some((v) => v.rule === "TECH-01" && v.message.includes("zod")));
      const fresh = run(dir, ["--standard", STANDARD]);
      assert.equal(fresh.code, 0, JSON.stringify(fresh.result?.violations));
    } finally {
      remove(dir);
    }
  });
});

describe("壊れにくさ", () => {
  test("CRLF と BOM のファイルでも同じ結果になる", () => {
    const files = templateFiles();
    const crlf = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `﻿${v.replace(/\n/g, "\r\n")}`]));
    // JSON も BOM 付き（JSON.parse は BOM を受け付けないので、チェッカーが除く）
    const dir = makeProject(crlf);
    try {
      const { code, result } = run(dir);
      assert.equal(code, 0, JSON.stringify(result?.violations, null, 2));
    } finally {
      remove(dir);
    }
  });

  test("CRLF のファイルでも違反の行番号が合う", () => {
    const files = templateFiles();
    files["src/server/todos.ts"] = `${files["src/server/todos.ts"]}\nexport const port = process.env.PORT;\n`.replace(/\n/g, "\r\n");
    const dir = makeProject(files);
    try {
      const { result } = run(dir);
      const v = result.violations.find((x) => x.rule === "ARCH-05");
      assert.ok(v);
      const lines = files["src/server/todos.ts"].split("\r\n");
      assert.equal(lines[v.line - 1], "export const port = process.env.PORT;");
    } finally {
      remove(dir);
    }
  });

  test("空白を含むパスの案件とファイルでも検査できる", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "devkit standard "));
    const dir = makeProject();
    const spaced = path.join(base, "my project");
    try {
      renameSync(dir, spaced);
      write(spaced, "src/app/(app)/my page/page.tsx", "export default function Page() {\n  return <p>a</p>;\n}\n");
      const { code, result } = run(spaced);
      assert.equal(code, 1);
      assert.ok(result.violations.some((v) => v.rule === "SEC-11" && v.file === "src/app/(app)/my page/page.tsx"));
    } finally {
      remove(base);
      remove(dir);
    }
  });

  test("壊れた JSON は違反になる（止まらない）", () => {
    const files = templateFiles();
    files["docs/profile.json"] = "{ broken";
    files["docs/exceptions.json"] = "[";
    const dir = makeProject(files);
    try {
      const { code, result } = run(dir);
      assert.equal(code, 1);
      const ids = new Set(result.violations.map((v) => v.rule));
      assert.ok(ids.has("OPS-01"));
      assert.ok(ids.has("ESC-06"));
    } finally {
      remove(dir);
    }
  });

  test("チェッカーと標準の文書そのものは秘密情報の検査に引っかからない", () => {
    const dir = makeProject();
    try {
      gitInit(dir);
      const { result } = run(dir);
      assert.deepEqual(result.violations.filter((v) => v.rule === "SEC-05"), []);
      // 標準のファイルがすべて案件にコピーされている
      for (const f of readdirSync(STANDARD)) assert.ok(statSync(path.join(dir, "docs", "standard", f)).isFile());
      assert.ok(statSync(path.join(dir, "scripts", "standard", "check.mjs")).isFile());
      assert.ok(CHECK.endsWith(path.join("scripts", "standard", "check.mjs")));
      commitAll(dir);
    } finally {
      remove(dir);
    }
  });
});
