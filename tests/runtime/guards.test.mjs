import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNTIME } from "./helpers.mjs";

const HOOKS = join(RUNTIME, ".claude", "hooks");
const root = mkdtempSync(join(tmpdir(), "devkit-guard-"));
spawnSync("git", ["init", "-q"], { cwd: root });
mkdirSync(join(root, "tests"), { recursive: true });
writeFileSync(join(root, "tests", "a.test.ts"), 'it("AC-1: a", () => { expect(1).toBe(1); expect(2).toBe(2) })\n');

function hook(name, input, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_")));
  const r = spawnSync(process.execPath, [join(HOOKS, name)], { input: JSON.stringify({ cwd: root, ...input }), encoding: "utf8", env: { ...clean, DEVKIT_TEST_CLOCK: "1", DEVKIT_TEST_BASH_MARKERS: `${root}-markers`, ...env } });
  return { code: r.status, err: r.stderr };
}
const bash = (command, env) => hook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command } }, env);
const edit = (file, content, env) => hook("guard-edits.mjs", { tool_name: "Write", tool_input: { file_path: join(root, file), content } }, env);

test("Claude からは人の判断のコマンドを実行できない", () => {
  for (const c of ["pnpm devkit approve M1 --role 技術", "pnpm -s devkit reject M1 --role 業務 --note x", "node scripts/devkit/devkit.mjs answer N1 --role 業務 --note x", "pnpm devkit proposal accept replan-M1-1 --role 技術", "pnpm devkit resume --add-cycles 5", "DEVKIT_HUMAN_TTYLESS=1 pnpm devkit approve M1"]) {
    assert.equal(bash(c).code, 2, c);
  }
});

test("すり抜けの書き方も止める", () => {
  for (const c of ["git -C . push origin main", "bash -c 'git push --force'", "cat .env", "cat ./.env.local", "cat .e*", "echo x > ./.devkit/state.json", "echo x | tee .devkit/controls.json", "git update-index --skip-worktree vitest.config.ts", "git -c core.hooksPath=/tmp/h commit -m x", "pnpm install left-pad"]) {
    assert.equal(bash(c).code, 2, c);
  }
});

test("普段のコマンドは通す", () => {
  for (const c of ["pnpm verify", "git diff HEAD~1", "git log --oneline -5", "pnpm exec vitest run tests/a.test.ts", "cat .env.example", "git add -A && git commit -m wip"]) {
    assert.equal(bash(c).code, 0, c);
  }
});

test("読み取り専用の役割（レビュー）は、読むだけのコマンドに限る", () => {
  const env = { DEVKIT_ROLE: "reviewer" };
  assert.equal(bash("git diff abc...def", env).code, 0);
  assert.equal(bash("git log --oneline", env).code, 0);
  assert.equal(bash("git diff --output=x.txt", env).code, 2);
  assert.equal(bash("pnpm verify", env).code, 2);
  assert.equal(bash("echo x > notes.md", env).code, 2);
  assert.equal(edit("src/x.ts", "x", env).code, 2);
});

test("実装担当はブランチ・履歴を変えず、保護されたパスとテストの設定を変えない", () => {
  const env = { DEVKIT_ROLE: "implementer" };
  assert.equal(bash("git switch main", env).code, 2);
  assert.equal(bash("git reset --soft HEAD~1", env).code, 2);
  assert.equal(bash("pnpm devkit run", env).code, 2);
  assert.equal(bash("sed -i 's/a/b/' tests/a.test.ts", env).code, 2);
  assert.equal(bash("cp x vitest.config.ts", env).code, 2);
  assert.equal(edit("docs/spec/app.md", "x", env).code, 2);
  assert.equal(edit(".npmrc", "script-shell=/bin/true", env).code, 2);
  assert.equal(edit("src/server/x.ts", "export const x = 1;\n", env).code, 0);
  assert.equal(bash("git add -A && git commit -m wip", env).code, 0);
});

test("テストを弱める編集は止める", () => {
  assert.equal(edit("tests/a.test.ts", 'it.skip("AC-1: a", () => { expect(1).toBe(1); expect(2).toBe(2) })\n').code, 2);
  assert.equal(edit("tests/a.test.ts", 'it("AC-1: a", () => { expect(1).toBe(1) })\n').code, 2);
  assert.equal(edit("tests/a.test.ts", 'it.fails("AC-1: a", () => { expect(1).toBe(1); expect(2).toBe(2) })\n').code, 2);
  assert.equal(edit("tests/a.test.ts", 'it("AC-1: a", () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3) })\n').code, 0);
  assert.equal(edit("src/a.ts", "// @ts-nocheck\nexport const a = 1;\n").code, 2);
});

test("状態ファイル・判断の記録・社内標準は誰も直接編集しない", () => {
  assert.equal(edit(".devkit/state.json", "{}").code, 2);
  assert.equal(edit(".devkit/controls.json", "{}").code, 2);
  assert.equal(edit("docs/decisions.md", "x").code, 2);
  assert.equal(edit("docs/standard/rules.json", "{}").code, 2);
  assert.equal(edit(".devkit/graph.json", "{}").code, 0, "計画はメインセッションが kickoff・再計画で書く（承認のハッシュで守る）");
});

// ---- v4.0 のレビューで見つかったすり抜け ----

const editPair = (file, oldS, newS, env) => hook("guard-edits.mjs", { tool_name: "Edit", tool_input: { file_path: join(root, file), old_string: oldS, new_string: newS } }, env);
const read = (input) => hook("guard-read.mjs", { tool_name: "Read", tool_input: input });

test("状態ファイルへの書き込みは、パスの書き方（./・//・cd・glob・絶対パス・変数・fd 番号）に関係なく止める", () => {
  for (const c of [
    "echo PWN > .devkit/./controls.json",
    "echo PWN > .devkit//controls.json",
    "cd .devkit && echo PWN > state.json",
    "echo {} > .devkit/c*.json",
    `echo x > ${root}/.devkit/controls.json`,
    "echo x >> $PWD/.devkit/controls.json",
    "echo x >| .devkit/state.json",
    "cp /tmp/x .devkit/./state.json",
    "echo X 1> docs/decisions.md",
    "echo X 2>&1 1> docs/decisions.md",
    "mv /tmp/x docs/./decisions.md",
    "dd if=/tmp/x of=.devkit/controls.json",
    "install -m 644 /tmp/x .devkit/config.json",
    "git checkout HEAD~1 -- .devkit/controls.json",
    'node -e "require(\'fs\').writeFileSync(\'.devkit/controls.json\', \'{}\')"',
  ]) {
    assert.equal(bash(c).code, 2, c);
  }
});

test("人のコマンドは、包んだ書き方・別の呼び方でも止める", () => {
  for (const c of [
    'script -qc "pnpm devkit approve plan --role 技術" /dev/null',
    "eval pnpm devkit approve plan --role 技術",
    "/usr/bin/env pnpm devkit approve plan",
    "/usr/local/bin/node scripts/devkit/devkit.mjs approve M1 --role 業務",
    "npm run devkit -- approve plan --role 業務",
    "pnpm run devkit approve plan",
    "$(echo pnpm) devkit approve plan",
    "echo approve | xargs pnpm devkit",
    'sh -euc "pnpm devkit approve plan"',
    "echo pnpm devkit approve plan | sh",
    "sh <<EOF\npnpm devkit approve plan\nEOF",
    'python3 -c "import os; os.system(\'pnpm devkit approve plan\')"',
    "setsid -f pnpm devkit approve plan",
    "pnpm devkit record --role 技術 --target x --decision y",
    "pnpm devkit exception add --rules TECH-01",
  ]) {
    assert.equal(bash(c).code, 2, c);
  }
});

test("Claude Code の中であることを隠す操作は止める", () => {
  for (const c of ["env -u CLAUDECODE pnpm devkit status", "unset CLAUDECODE; pnpm devkit status", "env -i PATH=/usr/bin node x.mjs", "CLAUDECODE= pnpm devkit status", "export DEVKIT_HUMAN_TEST=1"]) {
    assert.equal(bash(c).code, 2, c);
  }
});

test("人のコマンドの説明を検索・コミットするのは止めない", () => {
  for (const c of ['grep -rn "devkit approve" docs README.md', 'git commit -m "docs: pnpm devkit approve の説明"', "pnpm devkit pause 調査", "pnpm -s devkit status --json", "cat .devkit/controls.json", "echo hi > /tmp/x.txt"]) {
    assert.equal(bash(c).code, 0, c);
  }
});

test("読み取り専用の役割は、コマンド置換・プロセス置換・外部コマンドを呼ぶ指定を使えない", () => {
  const env = { DEVKIT_ROLE: "reviewer" };
  for (const c of ['git log $(node -e "require(\'fs\').writeFileSync(\'src/pwn.ts\',\'x\')")', "git diff `id`", "cat <(id)", "rg --pre ./x foo", "git grep -Ovim foo", "git -c core.pager=sh log", "node x.mjs"]) {
    assert.equal(bash(c, env).code, 2, c);
  }
  assert.equal(bash("git diff abc...def -- src/ | head -50", env).code, 0);
});

test("ランナーが起動した実装担当は patch・git apply を使わない", () => {
  const env = { DEVKIT_ROLE: "implementer" };
  for (const c of ["git apply x.patch", "patch -p1 < x.diff", "echo x > package.json", "pnpm devkit pause x"]) assert.equal(bash(c, env).code, 2, c);
});

test("テストの弱体化は、編集を当てはめた後の内容で判定する", () => {
  // 断片だけでは skip が増えないように見える置き換え
  assert.equal(editPair("tests/a.test.ts", 'it("AC-1', 'it.skip("AC-1').code, 2);
  assert.equal(editPair("tests/a.test.ts", '("AC-1', '.skip("AC-1').code, 2);
  assert.equal(editPair("tests/a.test.ts", 'it("AC-1', 'it["skip"]("AC-1').code, 2);
  assert.equal(editPair("tests/a.test.ts", 'it("AC-1', 'const t = it;\nt("AC-1').code, 2);
  assert.equal(editPair("tests/a.test.ts", "expect(2).toBe(2)", "").code, 2);
  assert.equal(editPair("tests/a.test.ts", "toBe(1)", "toBe(1 + 0)").code, 0);
});

test("テストの準備のファイル（setup・e2e の fixtures）は、実装担当は変えない", () => {
  const env = { DEVKIT_ROLE: "implementer" };
  for (const f of ["vitest.setup.ts", "tests/setup.ts", "e2e/fixtures.ts", "e2e/global-setup.ts"]) assert.equal(edit(f, "export {};\n", env).code, 2, f);
});

test(".env は Read・Grep・Glob でも読まない（.env.example は読める）", () => {
  for (const p of [".env", ".env.local", ".env.staging", ".env.test", ".env.local.bak", ".env*"]) {
    assert.equal(read({ file_path: join(root, p) }).code, 2, p);
  }
  assert.equal(hook("guard-read.mjs", { tool_name: "Glob", tool_input: { pattern: "**/.env*" } }).code, 2);
  assert.equal(read({ file_path: join(root, ".env.example") }).code, 0);
  assert.equal(read({ file_path: join(root, "src/env.ts") }).code, 0);
});
