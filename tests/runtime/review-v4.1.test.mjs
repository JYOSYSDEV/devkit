// v4.1 のレビューで見つかった穴の回帰テスト
//   1. 役割の違う人が判断できる（判断依頼への回答・マイルストーンの差し戻し・再計画の案の却下）
//   2. git の書き込みのオプション・コマンドを実行させる書き方・設定の注入で、ガードをすり抜ける
//   3. 実装担当の Edit・Write が、作業ディレクトリ（サンドボックス）の外に書ける
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyHumanDecisions, decide, normalizeGraph, syncState } from "../../plugins/devkit/runtime/scripts/devkit/lib/model.mjs";
import { approvePlan, as, defaultScenario, devkit, graphFor, implFiles, makeProject, RUNTIME, state } from "./helpers.mjs";

const controls = (dir) => JSON.parse(readFileSync(join(dir, ".devkit", "controls.json"), "utf8"));

function started(opts = {}) {
  const p = makeProject(opts);
  approvePlan(p.dir, p.scenarioFile);
  const r = devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  assert.equal(r.code, 0, r.out);
  return p;
}

// ---------- 1. 役割の一致 ----------

const ESC02 = { type: "technical", condition: "ESC-02", what: "外部の API に接続してよいか", why: "仕様にない接続先", options: ["許可", "不許可"], recommendation: "不許可" };

test("技術の判断依頼（ESC-02）に業務担当者は回答できない。標準オーナーが、依頼の ID を付けて回答すると再開する", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ output: { status: "needs_human", summary: "外部接続", evidence: "-", request: ESC02 } }, { files: implFiles("N1", "AC-1") }];
  const { dir, scenarioFile } = started({ scenario: sc });
  devkit(dir, ["run"], { scenarioFile });
  let s = state(dir);
  assert.equal(s.nodes.N1.status, "blocked");
  assert.equal(s.nodes.N1.request.id, "N1-1", "依頼に ID が付く");
  const reqFile = readFileSync(join(dir, ".devkit", "requests", "N1.md"), "utf8");
  assert.match(reqFile, /判断依頼: N1-1/);
  assert.match(reqFile, /--role 技術 --request N1-1/);

  // 業務担当者の回答は、警告ではなく断る（状態にも controls にも残さない）
  as(dir, "alice");
  let r = devkit(dir, ["answer", "N1", "--role", "業務", "--note", "接続してよい"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /標準オーナーが回答します/);
  assert.equal(state(dir).nodes.N1.status, "blocked");
  assert.equal(controls(dir).answers.N1, undefined);
  assert.doesNotMatch(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /接続してよい/);

  // 別の依頼の ID を付けた回答も断る
  as(dir, "tom");
  r = devkit(dir, ["answer", "N1", "--role", "技術", "--request", "N1-0", "--note", "不許可"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /回答待ちの判断依頼は N1-1/);

  // 標準オーナーが、依頼の ID を付けて回答する
  r = devkit(dir, ["answer", "N1", "--role", "技術", "--request", "N1-1", "--note", "不許可。モックで実装する"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  s = state(dir);
  assert.equal(s.nodes.N1.status, "pending");
  assert.match(s.nodes.N1.note, /N1-1/);
  const a = controls(dir).answers.N1[0];
  assert.equal(a.request, "N1-1");
  assert.equal(a.role, "technical");
  assert.match(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /N1 の判断依頼 N1-1（ESC-02）/);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("差し戻しは、マイルストーンの承認者の役割だけができる（標準オーナーだけが承認者の M1 を業務担当者は差し戻せない）", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
  as(dir, "alice");
  const r = devkit(dir, ["reject", "M1", "--role", "業務", "--note", "だめ"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /M1 の承認者は標準オーナー/);
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
  assert.equal(controls(dir).rejections.M1, undefined);
});

test("再計画の案の却下は、案の確認者の役割だけができる", () => {
  const sc = defaultScenario();
  const g = graphFor();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "x\n", "tests/a.test.js": 'test("AC-1: 失敗する", () => {}) // FAIL\n' } }];
  // テストの削除の許可を変える案（標準オーナーだけが確認する）
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "既存テストの削除を許す", nodes: [{ ...g.nodes[0], allowTestRemoval: ["tests/base.test.js"] }] } }];
  const { dir, scenarioFile } = started({ scenario: sc, graph: g });
  devkit(dir, ["run"], { scenarioFile });
  const p = state(dir).proposals?.[0];
  assert.equal(p?.status, "needs_human");
  assert.deepEqual(p.roles, ["technical"]);
  as(dir, "alice");
  let r = devkit(dir, ["proposal", "reject", p.id, "--role", "業務", "--note", "却下"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /確認するのは標準オーナー/);
  assert.equal(controls(dir).proposals?.[p.id], undefined);
  r = devkit(dir, ["proposal", "accept", p.id, "--role", "業務"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  as(dir, "tom");
  r = devkit(dir, ["proposal", "reject", p.id, "--role", "技術", "--note", "テストは消さない"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).proposals[0].status, "rejected");
  assert.equal(controls(dir).proposals[p.id].role, "technical");
});

// 状態への反映（ランナーが毎手の最初に行う）でも、役割と依頼の ID を確かめる。controls.json に直接書かれた決定を想定する
function fixture() {
  const g = normalizeGraph(graphFor());
  const s = syncState(g, { outer: "running", nodes: {}, milestones: {} });
  const c = { version: 2, plan: { approvedHash: null, approvals: {}, history: [] }, gates: {}, approvals: {}, answers: {}, rejections: {}, proposals: {}, pause: null };
  return { g, s, c };
}
const REQ_AT = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-02T00:00:00.000Z";

test("反映: 判断依頼の回答は、今の依頼の ID に、依頼の種別の役割が、依頼の後に答えたものだけを反映する", () => {
  const cases = [
    [{ request: "N1-1", role: "business", at: LATER }, /標準オーナーが回答するもの/],
    [{ request: "N1-0", role: "technical", at: LATER }, /別の判断依頼/],
    [{ role: "technical", at: LATER }, /別の判断依頼（指定なし）/],
    [{ request: "N1-1", role: "technical", at: "2026-10-31T00:00:00.000Z" }, /依頼 N1-1 が出る前/],
  ];
  for (const [a, why] of cases) {
    const { g, s, c } = fixture();
    Object.assign(s.nodes.N1, { status: "blocked", request: { ...ESC02, id: "N1-1", at: REQ_AT } });
    c.answers.N1 = [{ ...a, note: "x", applied: false }];
    const notes = applyHumanDecisions(g, s, c);
    assert.equal(s.nodes.N1.status, "blocked", JSON.stringify(a));
    assert.match(c.answers.N1[0].ignored, why);
    assert.ok(notes.some((n) => /回答を反映しない/.test(n)));
  }
  const { g, s, c } = fixture();
  Object.assign(s.nodes.N1, { status: "blocked", request: { ...ESC02, id: "N1-1", at: REQ_AT } });
  assert.deepEqual(decide(g, s, c).waiting.answers, [{ node: "N1", role: "technical", request: "N1-1" }]);
  c.answers.N1 = [{ request: "N1-1", role: "technical", at: LATER, note: "不許可", applied: false }];
  applyHumanDecisions(g, s, c);
  assert.equal(s.nodes.N1.status, "pending");
  assert.equal(s.nodes.N1.request, null);
});

test("反映: 差し戻しは、承認者の役割のものだけを反映する", () => {
  const { g, s, c } = fixture();
  Object.assign(s.milestones.M1, { status: "awaiting_approval", head: "abc", required: ["technical"] });
  c.rejections.M1 = { role: "business", note: "だめ", sha: "abc", applied: false };
  applyHumanDecisions(g, s, c);
  assert.equal(s.milestones.M1.status, "awaiting_approval");
  assert.match(c.rejections.M1.ignored, /承認者/);
  c.rejections.M1 = { role: "technical", note: "命名を直す", sha: "abc", applied: false };
  applyHumanDecisions(g, s, c);
  assert.equal(s.milestones.M1.status, "blocked");
  // 別の版への差し戻しは反映しない
  const f = fixture();
  Object.assign(f.s.milestones.M1, { status: "awaiting_approval", head: "def", required: ["technical"] });
  f.c.rejections.M1 = { role: "technical", note: "x", sha: "abc", applied: false };
  applyHumanDecisions(f.g, f.s, f.c);
  assert.equal(f.s.milestones.M1.status, "awaiting_approval");
});

test("反映: 再計画の案は、却下なら確認者の役割、承認なら確認者の全員がそろったものだけを反映する", () => {
  let { g, s, c } = fixture();
  s.proposals = [{ id: "p1", milestone: "M1", items: [], roles: ["technical"], status: "needs_human", reasons: [] }];
  c.proposals.p1 = { status: "rejected", role: "business", note: "x" };
  applyHumanDecisions(g, s, c);
  assert.equal(s.proposals[0].status, "needs_human");
  assert.equal(c.proposals.p1.status, "pending", "人の確認待ちに戻す");
  assert.equal(decide(g, s, c).waiting.proposals.length, 1);
  c.proposals.p1 = { status: "rejected", role: "technical", note: "x" };
  applyHumanDecisions(g, s, c);
  assert.equal(s.proposals[0].status, "rejected");

  ({ g, s, c } = fixture());
  s.proposals = [{ id: "p2", milestone: "M1", items: [], roles: ["business", "technical"], status: "needs_human", reasons: [] }];
  c.proposals.p2 = { status: "accepted", needed: ["technical"], accepts: { technical: { hash: "h" } } };
  applyHumanDecisions(g, s, c);
  assert.equal(s.proposals[0].status, "needs_human", "ランナーが求めた業務担当者の承認がない");
  assert.equal(c.proposals.p2.status, "pending");
});

// ---------- 2. git の書き込み・コマンドの実行・設定の注入（guard-bash） ----------

const HOOKS = join(RUNTIME, ".claude", "hooks");
const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-guard41-")));
spawnSync("git", ["init", "-q"], { cwd: root });
mkdirSync(join(root, ".devkit"), { recursive: true });
mkdirSync(join(root, "src"), { recursive: true });
symlinkSync(".devkit", join(root, "dl"));

function hook(name, input, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_")));
  const r = spawnSync(process.execPath, [join(HOOKS, name)], { input: JSON.stringify({ cwd: root, ...input }), encoding: "utf8", env: { ...clean, ...env } });
  return { code: r.status, err: r.stderr };
}
const bash = (command, env) => hook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command } }, env);
const IMPL = { DEVKIT_ROLE: "implementer", DEVKIT_WORKDIR: root };

const REPORTED = [
  // 出力先の指定
  "git log --output=.devkit/controls.json -1",
  "git diff --output=docs/decisions.md",
  "git show --output=.devkit/state.json HEAD",
  "git rev-list --output=.devkit/state.json HEAD",
  "git rev-list --all --output .devkit/state.json",
  "git format-patch -o .devkit HEAD~1",
  "git format-patch -ko .devkit/evidence HEAD~1",
  "git format-patch --output-directory=.devkit/evidence HEAD~1",
  "git archive -o .devkit/controls.json HEAD",
  "git archive --output=docs/exceptions.json HEAD",
  "git bundle create .devkit/controls.json HEAD",
  // 置き場所の指定
  "git clone . .devkit/x",
  "git -C .devkit log --output=controls.json",
  "git worktree add .devkit/x",
  "git worktree move ../a .devkit/a",
  "git init .devkit/x",
  "git checkout-index -a -f --prefix=.devkit/x/",
  "git merge-file .devkit/controls.json a b",
  "git --work-tree=.devkit checkout HEAD -- .",
  'git -C "$X" log --output=y',
  // git が任意のコマンドを実行する書き方
  "git rebase --exec 'pnpm devkit approve plan --role 技術' HEAD~1",
  "git rebase -x 'echo hi > .devkit/state.json' HEAD~1",
  "git rebase -ix true HEAD~1",
  "git bisect run sh -c 'pnpm devkit approve plan'",
  "git submodule foreach 'pnpm devkit approve M1'",
  "git submodule --quiet foreach 'pnpm devkit approve M1'",
  "git difftool -x 'pnpm devkit approve M1' HEAD",
  "git difftool --extcmd='pnpm devkit approve M1' HEAD",
  "git grep -O'pnpm devkit approve' x",
  "git fetch --upload-pack='x' origin",
  "git clone -u 'pnpm devkit approve' a b",
  "git clone --template=/tmp/t a b",
  "git filter-branch --tree-filter x HEAD",
  "git --exec-path=/tmp/x status",
  // 設定の書き方
  "git -ccore.hooksPath=/tmp/h commit -m x",
  "git -c core.hooksPath=/tmp/h commit -m x",
  "git -c Core.HooksPath=/tmp/h commit -m x",
  "git --config-env=core.hooksPath=X commit -m x",
  "git --config-env core.hooksPath=X commit -m x",
  "git -c alias.x='!pnpm devkit approve plan' x",
  "git -c include.path=/tmp/x status",
  "git -c core.fsmonitor='pnpm devkit approve' status",
  "git clone -c core.hooksPath=/x a b",
  "git config core.hooksPath /tmp/h",
  "git config --global include.path /tmp/x",
  "git config --file .devkit/controls.json color.ui x",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/h git commit -m x",
  "env GIT_CONFIG_GLOBAL=/tmp/c git commit -m x",
  "export GIT_CONFIG_COUNT=1",
  "GIT_DIR=/tmp/x git status",
  "sudo -u x env GIT_SSH_COMMAND=y git fetch",
  "HOME=/tmp/evil git commit -m x",
  "PAGER='sh -c x' git log",
  `GIT_TRACE=${root}/.devkit/controls.json git status`,
  // .git の中・リンクを通した書き込み
  "git log --format=x --output=.git/config -1",
  "echo '[core]' > .git/config",
  "echo x > dl/controls.json",
  "git log --output=dl/state.json -1",
  "ln -s .devkit d; echo x > d/controls.json",
  // 前置きのオプションの値をコマンドと取り違えない
  "sudo -u x pnpm devkit approve plan",
  // 語の中の引用符・$'…'・同じコマンドで代入した変数・コマンド置換で、書き込み先を隠さない
  'git log --output=".devkit/controls.json" -1',
  "git log --output=.dev''kit/controls.json -1",
  "git log --output=$'\\x2edevkit/controls.json' -1",
  'echo x > ".devkit/"controls.json',
  "echo x>.devkit/controls.json",
  "echo x >&.devkit/controls.json",
  "X=.devkit; git log --output=$X/controls.json -1",
  "export X=.devkit; echo x > $X/state.json",
  "git log --output=$(printf .devkit/controls.json) -1",
  "echo x > $(echo .devkit/controls.json)",
  "echo x > $UNKNOWN/controls.json",
  "git -c 'core.hooksPath'=/x status",
  'p"npm" devkit approve plan',
];

test("git の書き込みのオプション・コマンドの実行・設定の注入は、メインのセッションでも実装担当でも止める", () => {
  for (const c of REPORTED) {
    assert.equal(bash(c).code, 2, `メインのセッション: ${c}`);
    assert.equal(bash(c, IMPL).code, 2, `実装担当: ${c}`);
  }
});

test("普段の git の使い方は止めない", () => {
  for (const c of [
    "git log --oneline -5",
    "git diff --output=/tmp/out.diff",
    "git diff --output=notes/diff.txt",
    "git log --output-indicator-new=+ -p -1",
    "git format-patch -o patches HEAD~1",
    "git archive -o build.zip HEAD",
    "git worktree add ../feature-x",
    "git worktree add .claude/worktrees/x",
    "git clone https://example.com/a/b.git /tmp/b",
    "git -c color.ui=never log -1",
    "git -c user.name=a -c user.email=b commit -m x",
    "GIT_PAGER=cat git log -1",
    "GIT_EDITOR=true git rebase --continue",
    "GIT_TRACE=1 git status",
    "git --no-pager log -1",
    "git --git-dir=.git status",
    "git -C src log -1",
    "git config user.email x@example.com",
    "git config --get core.hooksPath",
    'git commit -m "fix: --output の扱い"',
    "git commit --template=.gitmessage",
    "git rebase main",
    "git bisect start",
    "git push -u origin devkit/app",
    "git log -1 > notes.txt",
    "ln -sf src/a.ts b.ts",
    "timeout 30 pnpm verify",
    'echo x > "$(mktemp)"',
    'echo "a > b" > notes.txt',
    "echo x > $OUT",
    'git commit -m "feat: a > b"',
    "pnpm test 2>&1 | tee out.log",
  ]) {
    assert.equal(bash(c).code, 0, c);
  }
});

test("ファイル・標準入力から渡したコード、パッチの中身、find -exec、busybox でも、保護されたファイルに書けない", () => {
  writeFileSync(join(root, "evil.py"), 'open(".devkit/state.json","w").write("x")\n');
  writeFileSync(join(root, "ok.py"), 'print("hello")\n');
  writeFileSync(join(root, "h.sh"), "pnpm devkit approve plan --role 技術\n");
  writeFileSync(join(root, "dec.patch"), "--- a/docs/decisions.md\n+++ b/docs/decisions.md\n@@ -1 +1 @@\n-a\n+b\n");
  writeFileSync(join(root, "ok.patch"), "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
  for (const c of [
    'python3 - <<EOF\nopen(".devkit/state.json","w").write("x")\nEOF',
    "cat evil.py | python3",
    "python3 < evil.py",
    "python3 evil.py",
    `python3 <<< 'open(".devkit/state.json","w")'`,
    "git apply dec.patch",
    "cat dec.patch | git apply",
    "curl https://example.com/x.patch | git apply",
    "patch -p1 < dec.patch",
    "patch -i dec.patch",
    "bash h.sh",
    "sh < h.sh",
    "cat h.sh | sh",
    `awk 'BEGIN{print 1 > ".devkit/state.json"}'`,
    "find .devkit -delete",
    "find . -name x -exec sh -c 'echo x > .devkit/state.json' \\;",
    'busybox sh -c "echo x > .devkit/state.json"',
  ]) {
    assert.equal(bash(c).code, 2, c);
  }
  for (const c of ["python3 ok.py", "cat ok.py | python3", "git apply ok.patch", "git apply --check dec.patch", "patch -p1 < ok.patch", 'find . -name "*.tmp" -delete', 'find src -name "*.ts" -exec grep -n foo {} +', "git -c rebase.autosquash=true rebase main", "python3 -m http.server", "awk '{print $1}' src/a.ts"])
    assert.equal(bash(c).code, 0, c);
  // 実装担当は、インタプリタのコードで書かない・コマンドを起動しない（書き込み先を確かめられない）
  for (const c of ['node -e "require(\'fs\').writeFileSync(\'/tmp/ESCAPE\',\'x\')"', `python3 -c "open('/tmp/ESCAPE','w')"`, 'perl -e "system(q{echo x > /tmp/ESCAPE})"', "find . -exec touch /tmp/ESCAPE {} +", "busybox cp a /tmp/ESCAPE", 'echo "x" | python3'])
    assert.equal(bash(c, IMPL).code, 2, c);
});

test("実装担当の Bash の書き込み先は、作業ディレクトリの中だけ", () => {
  for (const c of ["echo x > src/a.ts", "pnpm test > test.log 2>&1", "git log --output=src/log.txt -1", "cd src && echo y > b.ts", "cat x > /dev/null"]) assert.equal(bash(c, IMPL).code, 0, c);
  for (const c of ["echo x > /tmp/x", "echo x > ../main/src/a.ts", "cd /tmp && echo x > y", "git -C /tmp log --output=x", "echo x > $SOMEWHERE/a", `cp src/a.ts ${homedir()}/.bashrc`])
    assert.equal(bash(c, IMPL).code, 2, c);
});

// ---------- 3. 実装担当の Edit・Write（guard-edits）とランナーの設定 ----------

test("実装担当の Edit・Write は、作業ディレクトリの外・リンクの先・.git の中に書けない", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "devkit-work41-")));
  const main = join(base, "main");
  const work = join(base, "work", "impl-N1");
  mkdirSync(join(main, "src"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: main });
  mkdirSync(join(work, "src"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: work });
  writeFileSync(join(main, "src", "shared.ts"), "export {};\n");
  symlinkSync(join(main, "src"), join(work, "link"));
  symlinkSync("/nonexistent/x.ts", join(work, "src", "dangle.ts"));
  linkSync(join(main, "src", "shared.ts"), join(work, "src", "hard.ts"));
  const env = { DEVKIT_ROLE: "implementer", DEVKIT_WORKDIR: work };
  const write = (file_path) => hook("guard-edits.mjs", { cwd: work, tool_name: "Write", tool_input: { file_path, content: "export const x = 1;\n" } }, env);
  for (const f of [join(work, "src", "ok.ts"), "src/rel.ts"]) assert.equal(write(f).code, 0, f);
  for (const f of [
    join(main, "src", "pwn.ts"),
    join(main, ".git", "hooks", "pre-commit"),
    join(work, ".git", "hooks", "pre-commit"),
    join(work, ".git", "config"),
    join(homedir(), ".bashrc"),
    "~/.claude/settings.json",
    join(base, "work", "impl-N2", "src", "x.ts"),
    "../impl-N2/src/x.ts",
    join(work, "src", "..", "..", "impl-N2", "x.ts"),
    join(work, "link", "pwn.ts"),
    join(work, "src", "dangle.ts"),
    join(work, "src", "hard.ts"),
  ]) {
    assert.equal(write(f).code, 2, f);
  }
  // メインのセッションでも .git の中（設定・フック）は Edit・Write で変えない
  assert.equal(hook("guard-edits.mjs", { cwd: main, tool_name: "Write", tool_input: { file_path: join(main, ".git", "hooks", "pre-commit"), content: "#!/bin/sh\n" } }).code, 2);
});

test("ランナーは実装担当に作業ディレクトリ（DEVKIT_WORKDIR）を渡し、本体のリポジトリへの Edit を権限のルールでも断る", () => {
  const { dir, scenarioFile } = started();
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  const calls = readFileSync(`${scenarioFile}.args.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const impl = calls.filter((c) => c.key.startsWith("implementer"));
  assert.ok(impl.length);
  for (const c of impl) {
    assert.equal(c.workdir, c.cwd, "ガードが使う作業ディレクトリは、claude を起動した場所");
    assert.ok(!c.cwd.startsWith(`${dir}/`));
    const settings = JSON.parse(c.argv[c.argv.indexOf("--settings") + 1]);
    assert.ok(settings.permissions.deny.includes(`Edit(/${dir}/**)`), JSON.stringify(settings.permissions.deny));
    assert.ok(settings.permissions.deny.includes("Edit(~/.claude/**)"));
  }
  const reviewer = calls.find((c) => c.key.startsWith("reviewer"));
  const rs = JSON.parse(reviewer.argv[reviewer.argv.indexOf("--settings") + 1]);
  assert.ok(!rs.permissions.deny.some((d) => d.startsWith("Edit(/")), "読み取り専用の役割は、そもそも Edit を使えない");
});
