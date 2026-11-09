// 標準の文書と rules.json の食い違いがないこと
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { CHECK, STANDARD } from "./fixture.mjs";

const read = (f) => readFileSync(path.join(STANDARD, f), "utf8");
const RULES = JSON.parse(read("rules.json"));
const README = read("README.md");
const KINDS = ["auto", "lint", "runner", "flag", "review", "human"];

describe("rules.json", () => {
  test("すべてのルールに id・layer・title・check・summary があり、id は重複しない", () => {
    const ids = new Set();
    for (const r of RULES.rules) {
      for (const k of ["id", "layer", "title", "check", "summary"]) assert.ok(typeof r[k] === "string" && r[k].trim(), `${r.id}.${k}`);
      assert.ok(KINDS.includes(r.check), `${r.id} の check: ${r.check}`);
      assert.ok(RULES.layers[r.layer], `${r.id} の layer: ${r.layer}`);
      assert.ok(!ids.has(r.id), `重複: ${r.id}`);
      ids.add(r.id);
      if (r.check === "flag") assert.ok(["business", "technical"].includes(r.role), `${r.id} の role`);
      if (r.release) assert.equal(r.check, "auto", `${r.id}: release は自動検査だけ`);
    }
    for (const k of KINDS) assert.ok(RULES.kinds[k]?.label, `kinds.${k}`);
  });

  test("版は VERSION・rules.json・dependencies.json でそろっている", () => {
    const version = read("VERSION").trim();
    assert.equal(version, "2026.11.2");
    assert.equal(RULES.version, version);
    assert.equal(JSON.parse(read("dependencies.json")).version, version);
    assert.match(read("CHANGELOG.md"), new RegExp(`^## ${version.replace(/\./g, "\\.")}`, "m"));
    assert.ok(README.includes(`版: \`${version}\``));
  });

  test("A の 44 件と DATA・DEPS・ARCH-11 がそろっている", () => {
    const expected = [
      ...["01", "02", "03", "04"].map((n) => `TECH-${n}`),
      ...Array.from({ length: 11 }, (_, i) => `ARCH-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 5 }, (_, i) => `QA-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, i) => `SEC-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 7 }, (_, i) => `OPS-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 6 }, (_, i) => `ESC-${String(i + 1).padStart(2, "0")}`),
      "DATA",
      "DEPS",
    ].sort();
    assert.deepEqual(RULES.rules.map((r) => r.id).sort(), expected);
  });
});

describe("README", () => {
  test("確かめ方ごとの件数が rules.json と一致する", () => {
    const m =
      /ルール (\d+) 件の確かめ方の内訳: 自動検査 (\d+)（うちリリース前の検査 (\d+)）、lint (\d+)、ランナーの検証 (\d+)、変更検出→人間ゲート (\d+)、独立レビュー（AI） (\d+)、人間ゲート (\d+)。/.exec(
        README,
      );
    assert.ok(m, "README に件数の行がない");
    const count = (k) => RULES.rules.filter((r) => r.check === k).length;
    const [total, auto, release, lint, runner, flag, review, human] = m.slice(1).map(Number);
    assert.equal(total, RULES.rules.length);
    assert.equal(auto, count("auto"));
    assert.equal(release, RULES.rules.filter((r) => r.release).length);
    assert.equal(lint, count("lint"));
    assert.equal(runner, count("runner"));
    assert.equal(flag, count("flag"));
    assert.equal(review, count("review"));
    assert.equal(human, count("human"));
    assert.equal(auto + lint + runner + flag + review + human, total);
  });

  test("ルールの表は `--list --markdown` の出力と同じ", () => {
    const r = spawnSync(process.execPath, [CHECK, "--standard", STANDARD, "--list", "--markdown"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(README.includes(r.stdout.trim()), "README の表が rules.json と食い違っている。--list --markdown の出力で置き換える");
  });
});

describe("01〜05 の文書", () => {
  test("03 のセキュリティの表の「確かめ方」は rules.json の種別と同じ", () => {
    const label = (r) => `${RULES.kinds[r.check].label}${r.release ? "（リリース前）" : ""}`;
    const rows = [...read("03-quality-security.md").matchAll(/^\| (SEC-\d+) \|.*\| ([^|]+) \|$/gm)];
    assert.equal(rows.length, RULES.rules.filter((r) => r.id.startsWith("SEC-")).length);
    for (const [, id, kind] of rows) {
      const rule = RULES.rules.find((r) => r.id === id);
      assert.equal(kind.trim(), label(rule), id);
    }
  });

  test("すべてのルール ID が、その層の文書に出てくる", () => {
    const docs = {
      "1-technology": "01-technology.md",
      "2-design": "02-design.md",
      "3-quality-security": "03-quality-security.md",
      "4-operations": "04-operations.md",
      "5-exceptions": "05-exceptions.md",
    };
    for (const r of RULES.rules) {
      const text = read(docs[r.layer]);
      assert.ok(new RegExp(`\\b${r.id}\\b`).test(text), `${r.id} が ${docs[r.layer]} にない`);
    }
  });

  test("文書から張ったリンク先が存在する", () => {
    const files = new Set(readdirSync(STANDARD));
    for (const f of [...files].filter((x) => x.endsWith(".md"))) {
      for (const m of read(f).matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (/^https?:/.test(m[1])) continue;
        assert.ok(files.has(m[1]), `${f} のリンク先 ${m[1]} がない`);
      }
    }
  });
});
