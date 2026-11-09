// 例外（docs/exceptions.json）の記録の検証（ESC-06）と、例外の当て方
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PACKAGE_JSON, makeProject, remove, run, templateFiles } from "./fixture.mjs";

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

const VALID = {
  id: "EXC-001",
  rules: ["TECH-01", "TECH-02"],
  subject: "dependency:exceljs",
  reason: "既存の Excel 台帳を取り込むため",
  adr: "docs/adr/0004-exceljs.md",
  approvedBy: "技術 花子",
  approvedAt: "2026-01-05",
  reviewBy: "2099-12-31",
};

/** exceljs を依存に加え、exceptions を登録した案件で検査する */
function withExceptions(exceptions, args = []) {
  const files = templateFiles();
  const pkg = JSON.parse(JSON.stringify(PACKAGE_JSON));
  pkg.dependencies.exceljs = "4.4.0";
  files["package.json"] = json(pkg);
  files["docs/adr/0004-exceljs.md"] = "# ADR-0004: exceljs を使う\n";
  files["docs/exceptions.json"] = json({ exceptions });
  const dir = makeProject(files);
  try {
    return run(dir, args);
  } finally {
    remove(dir);
  }
}

const esc06 = (r) => r.result.violations.filter((v) => v.rule === "ESC-06");

describe("ESC-06 例外の記録", () => {
  test("記録のそろった例外は、その対象の違反を消す", () => {
    const r = withExceptions([VALID]);
    assert.equal(r.code, 0, JSON.stringify(r.result.violations, null, 2));
    assert.deepEqual(r.result.warnings, []);
  });

  test("例外がなければ違反（TECH-01）", () => {
    const r = withExceptions([]);
    assert.ok(r.result.violations.some((v) => v.rule === "TECH-01" && /exceljs/.test(v.message)));
  });

  test("項目が欠けた例外は適用せず、ESC-06 の違反にする", () => {
    const { approvedBy, ...noApprover } = VALID;
    const r = withExceptions([noApprover]);
    assert.equal(r.code, 1);
    assert.match(esc06(r)[0].message, /approvedBy/);
    assert.ok(r.result.violations.some((v) => v.rule === "TECH-01"), "適用されていないこと");
  });

  test("実在しない日付・未来の承認日・期限が承認日より前・ADR がない・案件の外の ADR は認めない", () => {
    const cases = [
      [{ ...VALID, approvedAt: "2026-02-30" }, /approvedAt/],
      [{ ...VALID, reviewBy: "2027-13-01" }, /reviewBy/],
      [{ ...VALID, approvedAt: "2999-01-01", reviewBy: "2999-12-31" }, /未来/],
      [{ ...VALID, reviewBy: "2025-12-31" }, /approvedAt より前/],
      [{ ...VALID, adr: "docs/adr/9999-none.md" }, /adr/],
      [{ ...VALID, adr: "../outside.md" }, /adr/],
      [{ ...VALID, rules: ["TECH-99"] }, /rules/],
    ];
    for (const [e, pattern] of cases) {
      const r = withExceptions([e]);
      assert.equal(r.code, 1, JSON.stringify(e));
      assert.match(esc06(r)[0]?.message ?? "", pattern, JSON.stringify(e));
    }
  });

  test("id の重複は違反", () => {
    const r = withExceptions([VALID, { ...VALID, subject: "dependency:other" }]);
    assert.match(esc06(r)[0].message, /重複/);
  });

  test("ESC-06 自体は例外にできない（* でも）", () => {
    const r = withExceptions([VALID, { ...VALID, id: "EXC-002", rules: ["ESC-06"], subject: "*" }]);
    assert.match(esc06(r)[0].message, /ESC-06 は例外にできない/);
  });

  test("見直し期限を過ぎた例外は、普段は注意・--release では違反", () => {
    const expired = { ...VALID, approvedAt: "2020-01-01", reviewBy: "2020-06-30" };
    const normal = withExceptions([expired]);
    assert.equal(normal.code, 0, JSON.stringify(normal.result.violations));
    assert.ok(normal.result.warnings.some((w) => w.rule === "ESC-06" && /見直し期限 2020-06-30/.test(w.message)));
    const release = withExceptions([expired], ["--release"]);
    assert.ok(esc06(release).some((v) => /見直し期限 2020-06-30/.test(v.message)));
  });

  test('subject "*" はルール全体を外し、注意として毎回表示する', () => {
    const r = withExceptions([{ ...VALID, subject: "*" }]);
    assert.equal(r.code, 0);
    assert.ok(r.result.warnings.some((w) => w.rule === "ESC-06" && /TECH-01,TECH-02 を検査していません/.test(w.message)));
  });

  test("subject は完全一致（別の依存には効かない）", () => {
    const r = withExceptions([{ ...VALID, subject: "dependency:excel" }]);
    assert.ok(r.result.violations.some((v) => v.rule === "TECH-01"));
  });

  test("file: の subject はそのファイルの違反だけを消す", () => {
    const files = templateFiles();
    files["src/components/raw.tsx"] = 'export function Raw({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n';
    files["src/components/raw2.tsx"] = files["src/components/raw.tsx"];
    files["docs/adr/0005-raw.md"] = "# ADR-0005\n";
    files["docs/exceptions.json"] = json({
      exceptions: [{ ...VALID, rules: ["SEC-03"], subject: "file:src/components/raw.tsx", adr: "docs/adr/0005-raw.md" }],
    });
    const dir = makeProject(files);
    try {
      const r = run(dir);
      const v = r.result.violations.filter((x) => x.rule === "SEC-03");
      assert.deepEqual(
        v.map((x) => x.file),
        ["src/components/raw2.tsx"],
      );
    } finally {
      remove(dir);
    }
  });
});
