// 4.3.1: 初回の起動から最初の作業が終わるまでに、人の手続きで何度も止まる問題の回帰テスト
// （実装担当の削除・コンテナのエンジンの自動選択・AI の担当の場所・起動前の検査）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { approvePlan, as, calls, cleanEnv, defaultScenario, devkit, git, graphFor, implFiles, makeProject, RUNTIME, state } from "./helpers.mjs";

const HOOKS = join(RUNTIME, ".claude", "hooks");
const LIB = join(RUNTIME, "scripts", "devkit", "lib");
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "devkit");
const tmp = (name) => mkdtempSync(join(tmpdir(), `devkit-${name}-`));

function started(opts = {}) {
  const p = makeProject(opts);
  approvePlan(p.dir, p.scenarioFile);
  const r = devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  assert.equal(r.code, 0, r.out);
  return p;
}

// ---------- 実装担当の削除（git rm） ----------

function workdir() {
  const root = tmp("rm");
  git(root, "init", "-q");
  const files = {
    "tests/unit/todos.test.ts": 'it("a", () => { expect(1).toBe(1) })\n',
    "tests/unit/keep.test.ts": 'it("b", () => { expect(1).toBe(1) })\n',
    "e2e/todos.spec.ts": 'test("c", () => { expect(1).toBe(1) })\n',
    "src/app/(app)/todos/page.tsx": "export default function Page() { return null }\n",
    "src/server/todos.ts": "export const x = 1;\n",
    "src/server/other.ts": "export const y = 1;\n",
    "CLAUDE.md": "# x\n",
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return root;
}

function guard(name, root, tool_input, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_")));
  const r = spawnSync(process.execPath, [join(HOOKS, name)], { input: JSON.stringify({ cwd: root, tool_input }), encoding: "utf8", env: { ...clean, DEVKIT_TEST_CLOCK: "1", DEVKIT_TEST_BASH_MARKERS: `${root}-markers`, ...env } });
  return { code: r.status, err: r.stderr };
}

test("実装担当は git rm で、owns の中のファイルと、allowTestRemoval にあるテストだけを削除できる", async () => {
  const root = workdir();
  const env = {
    DEVKIT_ROLE: "implementer",
    DEVKIT_WORKDIR: root,
    DEVKIT_OWNS: JSON.stringify(["src/app/(app)/todos/**", "src/server/todos.ts", "tests/unit/todos.test.ts", "tests/unit/keep.test.ts", "e2e/todos.spec.ts"]),
    DEVKIT_ALLOW_TEST_REMOVAL: JSON.stringify(["tests/unit/todos.test.ts", "e2e/todos.spec.ts"]),
  };
  const bash = (command, e = env) => guard("guard-bash.mjs", root, { command }, e);
  // 雛形の見本（画面・処理・テスト）をまとめて消す
  assert.equal(bash('git rm -r "src/app/(app)/todos" src/server/todos.ts tests/unit/todos.test.ts e2e/todos.spec.ts').code, 0);
  assert.equal(bash("git rm -q -- tests/unit/todos.test.ts").code, 0);
  // 許可のないテスト・owns の外・保護されたファイル・作業ディレクトリの外は消せない（フォルダごと・glob でも）
  for (const c of ["git rm tests/unit/keep.test.ts", "git rm -r tests", "git rm 'tests/unit/*.test.ts'", "git rm src/server/other.ts", "git rm CLAUDE.md", "git rm -r .", "git rm ':(glob)**'", "git rm --pathspec-from-file=list.txt", "git rm -- ../outside.ts", "git rm $F"]) {
    const r = bash(c);
    assert.equal(r.code, 2, `${c}: ${r.err}`);
  }
  assert.match(bash("git rm tests/unit/keep.test.ts").err, /allowTestRemoval/);
  // 許可を渡されていなければ、テストは消せない（owns を渡されていなければ、owns では絞らない）
  const bare = { DEVKIT_ROLE: "implementer", DEVKIT_WORKDIR: root };
  assert.equal(bash("git rm tests/unit/todos.test.ts", bare).code, 2);
  assert.equal(bash("git rm src/server/other.ts", bare).code, 0);
  // 削除が許されているテストを空にする編集は止め、git rm を案内する
  const edit = guard("guard-edits.mjs", root, { file_path: join(root, "tests/unit/todos.test.ts"), content: "" }, env);
  assert.equal(edit.code, 2);
  assert.match(edit.err, /git rm/);
  // 許可コマンドに git rm があり、rm はない
  const { TOOLS, implementerPrompt } = await import(join(LIB, "agents.mjs"));
  assert.ok(TOOLS.implementer.includes("Bash(git rm *)"));
  assert.ok(!TOOLS.implementer.some((t) => /^Bash\(rm /.test(t)));
  assert.ok(!TOOLS.reviewer.some((t) => /git rm/.test(t)));
  const prompt = implementerPrompt({ g: { limits: { maxRounds: 3 }, spec: "docs/spec/app.md" }, node: { id: "N1", title: "t", acceptance: [], owns: ["src/**"], allowTestRemoval: ["tests/unit/todos.test.ts"], goal: "g" }, round: { attempt: 1, round: 1 }, base: "abcdef123456", branch: "b" });
  assert.match(prompt, /git rm/);
  assert.match(prompt, /tests\/unit\/todos\.test\.ts/);
});

test("ランナーは、ノードの owns と allowTestRemoval を実装担当のガードに渡す", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1", { "tests/base.test.js": null }) }];
  const g = graphFor();
  g.nodes[0].owns.push("tests/base.test.js");
  g.nodes[0].allowTestRemoval = ["tests/base.test.js"];
  const { dir, scenarioFile } = started({ graph: g, scenario: sc });
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
  const impl = readFileSync(`${scenarioFile}.args.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((a) => a.key === "implementer:N1");
  assert.deepEqual(JSON.parse(impl.allowRemoval), ["tests/base.test.js"]);
  assert.deepEqual(JSON.parse(impl.owns), g.nodes[0].owns);
  assert.ok(impl.argv.includes("Bash(git rm *)"));
});

// ---------- コンテナのエンジン ----------

function fakeBins(spec) {
  const bin = tmp("bin");
  for (const [name, ok] of Object.entries(spec)) {
    const p = join(bin, name);
    writeFileSync(p, ok ? '#!/bin/sh\nif [ "$1" = version ]; then echo 9.9.9; exit 0; fi\nif [ "$1" = info ]; then echo true; exit 0; fi\nexit 0\n' : "#!/bin/sh\necho 'Cannot connect to the daemon' >&2\nexit 1\n");
    chmodSync(p, 0o755);
  }
  return bin;
}

function inNode(script, { path }) {
  const node = dirname(process.execPath);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...cleanEnv(), PATH: [path, node].join(delimiter) } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("エンジンの指定がなければ、Docker が使えれば Docker、だめなら Podman を使う", { skip: process.platform === "win32" }, () => {
  const script = `
    import { engineProblem, isolationConfig } from ${JSON.stringify(join(LIB, "isolation.mjs"))};
    const auto = isolationConfig({});
    const fixed = isolationConfig({ isolation: { engine: "docker" } });
    const none = isolationConfig({ isolation: { mode: "none" } });
    console.log(JSON.stringify({ auto: auto.engine, isAuto: Boolean(auto.engineAuto), fixed: fixed.engine, none: none.engine, problem: engineProblem({}), fixedProblem: engineProblem({ isolation: { engine: "docker" } }), noneProblem: engineProblem({ isolation: { mode: "none" } }) }));
  `;
  // Docker なし・Podman あり（報告の環境）
  let r = inNode(script, { path: fakeBins({ podman: true }) });
  assert.equal(r.auto, "podman");
  assert.equal(r.isAuto, true);
  assert.equal(r.problem, null);
  assert.equal(r.fixed, "docker", "人が決めたエンジンは変えない");
  assert.match(r.fixedProblem, /docker/);
  assert.equal(r.noneProblem, null);
  // Docker のデーモンが動いていない・Podman あり
  assert.equal(inNode(script, { path: fakeBins({ docker: false, podman: true }) }).auto, "podman");
  // 両方あれば Docker
  assert.equal(inNode(script, { path: fakeBins({ docker: true, podman: true }) }).auto, "docker");
  // どちらもない: 理由と、エンジンの指定のしかた・コミットが要ることを示す
  r = inNode(script, { path: fakeBins({}) });
  assert.match(r.problem, /docker・podman/);
  assert.match(r.problem, /"engine":"podman"/);
  assert.match(r.problem, /コミット/);
});

// ---------- AI の担当（エージェント）の場所 ----------

function claudeHome({ userEnabled = false, installed = null } = {}) {
  const home = tmp("claude-home");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: userEnabled ? { "devkit@devkit-marketplace": true } : {} }));
  if (installed) {
    mkdirSync(join(home, "plugins"), { recursive: true });
    writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "devkit@devkit-marketplace": [{ scope: "project", installPath: installed, version: "4.3.1" }], "other@x": [{ installPath: "/nonexistent" }] } }));
  }
  return home;
}

test("devkit プラグインがプロジェクトの設定でだけ有効でも、インストール済みの場所を見つけて渡す", async () => {
  const { resolveAgents, resetAgentsCache, classifyEnvError } = await import(join(LIB, "agents.mjs"));
  const ctx = { root: tmp("proj") };
  const withHome = (home, config) => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    resetAgentsCache();
    try {
      return resolveAgents(ctx, config);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  };
  // 利用者の設定で有効: 何も渡さない
  assert.deepEqual(withHome(claudeHome({ userEnabled: true, installed: PLUGIN }), {}), { ok: true, pluginDir: null, how: "settings" });
  // プロジェクトの設定でだけ有効（利用者の設定は空）: インストール済みの場所を渡す
  assert.deepEqual(withHome(claudeHome({ installed: PLUGIN }), {}), { ok: true, pluginDir: PLUGIN, how: "installed" });
  // どこにもない: 直し方を添えた問題
  const none = withHome(claudeHome(), {});
  assert.equal(none.ok, false);
  assert.match(none.problem, /devkit:implementer/);
  assert.match(none.problem, /pluginDir/);
  // 壊れたインストールの記録（担当の定義がない場所）は使わない
  assert.equal(withHome(claudeHome({ installed: tmp("empty") }), {}).ok, false);
  // 人が決めた pluginDir を先に使う（相対パスは案件のルートから）。定義がない場所なら問題
  assert.equal(withHome(claudeHome(), { pluginDir: PLUGIN }).pluginDir, PLUGIN);
  assert.equal(withHome(claudeHome(), { pluginDir: "vendor/devkit" }).ok, false);
  assert.match(withHome(claudeHome(), { pluginDir: "vendor/devkit" }).problem, new RegExp(join(ctx.root, "vendor", "devkit").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // 担当の名前を変えた案件・extraArgs で渡している案件は、そのまま
  assert.equal(withHome(claudeHome(), { agentPrefix: "" }).ok, true);
  assert.equal(withHome(claudeHome(), { extraArgs: ["--plugin-dir", "/x"] }).ok, true);
  // 実行中に見つからなかったときも、直し方を添える
  const reason = classifyEnvError({ result: null, stderr: "Error: --agent 'devkit:implementer' not found", timedOut: false });
  assert.match(reason, /not found/);
  assert.match(reason, /pluginDir/);
  assert.doesNotMatch(classifyEnvError({ result: null, stderr: "Not logged in", timedOut: false }), /pluginDir/);
});

test("AI の担当が見つからなければ、AI を呼ぶ前に止まる。見つかれば --plugin-dir で渡す", () => {
  const { dir, scenarioFile } = started({ config: { agentPrefix: "devkit:" } });
  let r = devkit(dir, ["run"], { scenarioFile, env: { CLAUDE_CONFIG_DIR: claudeHome() } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /担当/);
  assert.match(r.out, /pluginDir/);
  assert.equal(calls(scenarioFile).length, 0, "AI を呼ばない");
  r = devkit(dir, ["run"], { scenarioFile, env: { CLAUDE_CONFIG_DIR: claudeHome({ installed: PLUGIN }) } });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
  const impl = readFileSync(`${scenarioFile}.args.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((a) => a.key === "implementer:N1");
  assert.equal(impl.argv[impl.argv.indexOf("--plugin-dir") + 1], PLUGIN);
  assert.equal(impl.argv[impl.argv.indexOf("--agent") + 1], "devkit:implementer");
});

// ---------- 起動前の検査（doctor） ----------

const doctor = (dir, scenarioFile, env = {}) => {
  const r = devkit(dir, ["doctor", "--json"], { scenarioFile, env });
  return { code: r.code, ...JSON.parse(r.out.slice(r.out.indexOf("{"))) };
};
const levelOf = (d, id) => d.items.find((x) => x.id === id)?.level;

test("doctor は、起動時に止まりうることを止めずにまとめて示し、何も書き換えない", () => {
  const { dir, scenarioFile } = started();
  const head = git(dir, "rev-parse", "HEAD");
  let d = doctor(dir, scenarioFile);
  assert.equal(d.ok, true, JSON.stringify(d.items));
  assert.equal(d.code, 0);
  for (const id of ["config", "engine", "agents", "plan", "worktree", "seal", "files"]) assert.equal(levelOf(d, id), "ok", id);
  assert.equal(levelOf(d, "sandbox"), "warn", "aiSandbox: off は注意");
  // 報告にあった止まり方を同時に起こす: エンジンが動いていない・人が作った設定が未コミット・手で書いた例外（末尾の改行なし）
  writeFileSync(join(dir, "biome.json"), "{}\n");
  git(dir, "add", "biome.json");
  git(dir, "commit", "-qm", "biome");
  writeFileSync(join(dir, "docs", "exceptions.json"), '{"exceptions":[{"id":"EXC-001"}]}');
  git(dir, "add", "docs/exceptions.json");
  git(dir, "commit", "-qm", "手で書いた例外");
  const cfg = JSON.parse(readFileSync(join(dir, ".devkit", "config.json"), "utf8"));
  writeFileSync(join(dir, ".devkit", "config.json"), JSON.stringify({ ...cfg, models: {} }, null, 2));
  const after = git(dir, "rev-parse", "HEAD");
  d = doctor(dir, scenarioFile, { FAKE_DOCKER_DOWN: "1" });
  assert.equal(d.ok, false);
  assert.equal(d.code, 1);
  for (const id of ["engine", "worktree", "seal", "files"]) assert.equal(levelOf(d, id), "problem", `${id}: ${JSON.stringify(d.items)}`);
  const item = (id) => d.items.find((x) => x.id === id);
  assert.match(item("worktree").detail, /\.devkit\/config\.json/);
  assert.match(item("seal").detail, /docs\/exceptions\.json/);
  assert.match(item("seal").fix, /seal accept/);
  assert.match(item("seal").fix, /exception add/);
  assert.match(item("files").detail, /末尾に改行/);
  assert.equal(git(dir, "rev-parse", "HEAD"), after, "コミットしない");
  assert.notEqual(head, after);
  // ランナーの起動時の検査も、最初の1つで止まるときに、ほかの直すことをまとめて示す
  const r = devkit(dir, ["run"], { scenarioFile, env: { FAKE_DOCKER_DOWN: "1" } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /pnpm devkit doctor/);
  for (const re of [/\.devkit\/config\.json/, /docs\/exceptions\.json/, /末尾に改行/, /コンテナ/]) assert.match(r.out, re);
  assert.equal(calls(scenarioFile).length, 0, "AI を呼ばない");
});

test("人が編集するファイルの整形の違いは、コンテナの検証の前（起動時）に止める", () => {
  const { dir, scenarioFile } = started();
  writeFileSync(join(dir, "biome.json"), "{}\n");
  const profile = readFileSync(join(dir, "docs", "profile.json"), "utf8").trimEnd();
  writeFileSync(join(dir, "docs", "profile.json"), profile);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "profile");
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/profile\.json: 末尾に改行/);
  assert.equal(calls(scenarioFile).length, 0);
  writeFileSync(join(dir, "docs", "profile.json"), `${profile}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fix");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("allowTestRemoval が owns の外にある計画は、doctor が知らせる", () => {
  const g = graphFor();
  g.nodes[0].allowTestRemoval = ["tests/base.test.js"];
  const { dir, scenarioFile } = started({ graph: g });
  const d = doctor(dir, scenarioFile);
  assert.equal(levelOf(d, "removal"), "problem", JSON.stringify(d.items));
});

test("devkit が書く docs/exceptions.json は、Biome の整形に合う形（値だけの配列は1行・末尾に改行）", async () => {
  const { biomeJson } = await import(join(LIB, "util.mjs"));
  const doc = { exceptions: [{ id: "EXC-001", rules: ["TECH-01", "TECH-02"], subject: "dependency:exceljs", empty: [], obj: {} }] };
  const text = biomeJson(doc);
  assert.equal(
    text,
    '{\n  "exceptions": [\n    {\n      "id": "EXC-001",\n      "rules": ["TECH-01", "TECH-02"],\n      "subject": "dependency:exceljs",\n      "empty": [],\n      "obj": {}\n    }\n  ]\n}\n',
  );
  assert.deepEqual(JSON.parse(text), doc);
  assert.equal(biomeJson({ exceptions: [] }), '{\n  "exceptions": []\n}\n');
  // 幅（120）に収まらない配列は、1つずつの行にする
  const long = Array.from({ length: 20 }, (_, i) => `TECH-${i}`);
  assert.match(biomeJson({ rules: long }), /"rules": \[\n    "TECH-0",\n/);
  assert.deepEqual(JSON.parse(biomeJson({ rules: long })).rules, long);
});

// ---------- 人のコマンド: 親のプロセスの誤検知と、Claude Code の入力欄の ! ----------

test("メモに Claude と書いただけでは、Claude Code の中からの実行とみなさない", async () => {
  const { isClaudeProcess } = await import(join(LIB, "human.mjs"));
  // 報告の例: pnpm が起動した sh の引数に、--note の文章（Claude の利用上限…）が入っている
  assert.equal(isClaudeProcess({ comm: "sh", argv: ["sh", "-c", "node scripts/devkit/devkit.mjs proposal reject replan-M2-1 --role technical --note '原因は Claude の利用上限（5-hour limit）。計画のまま やり直す'"] }), false);
  assert.equal(isClaudeProcess({ comm: "node", argv: ["node", "scripts/devkit/devkit.mjs", "answer", "N1", "--note", "claude に任せる"] }), false);
  assert.equal(isClaudeProcess({ comm: "bash", argv: ["-bash"] }), false);
  // Claude Code のプロセス
  assert.equal(isClaudeProcess({ comm: "claude", argv: ["claude"] }), true);
  assert.equal(isClaudeProcess({ comm: "2.1.322", argv: ["/home/u/.local/bin/claude", "--resume"] }), true);
  assert.equal(isClaudeProcess({ comm: "2.1.322", argv: ["/home/u/.local/share/claude/versions/2.1.322"] }), true);
  assert.equal(isClaudeProcess({ comm: "node", argv: ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"] }), true);
  assert.equal(isClaudeProcess({ comm: "node", argv: ["/usr/bin/node", "--max-old-space-size=4096", "/usr/local/bin/claude"] }), true);
  // 実際のプロセス: メモに Claude と書いた人のコマンドが、sh -c の下で動いても断られない
  const { dir, scenarioFile } = makeProject();
  git(dir, "config", "user.name", "alice");
  const cmd = `"${process.execPath}" "${join(dir, "scripts", "devkit", "devkit.mjs")}" approve plan --role 業務 --note '原因は Claude の利用上限'`;
  const r = spawnSync("sh", ["-c", `${cmd}; exit $?`], { cwd: dir, encoding: "utf8", env: { ...cleanEnv(), DEVKIT_FAKE_SCENARIO: scenarioFile, DEVKIT_HUMAN_TTYLESS: "1" } });
  // （このテスト自体を Claude Code の中で動かすと、本物の claude が親にいる。sh を Claude と取り違えないことを確かめる）
  assert.doesNotMatch(r.stdout + r.stderr, /親のプロセス sh/, r.stdout + r.stderr);
});

test("人のコマンドは Claude Code の入力欄の ! から実行できる。Claude の Bash の実行中は断る", () => {
  const { dir, scenarioFile } = makeProject();
  as(dir, "alice");
  const markers = `${dir}-markers`;
  const inClaude = { CLAUDECODE: "1", DEVKIT_TEST_BASH_MARKERS: markers };
  const approve = () => devkit(dir, ["approve", "plan", "--role", "業務"], { scenarioFile, env: inClaude });
  const hook = (name, input) => spawnSync(process.execPath, [join(dir, ".claude", "hooks", name)], { input: JSON.stringify({ cwd: dir, session_id: "s1", ...input }), encoding: "utf8", env: { ...cleanEnv(), DEVKIT_TEST_CLOCK: "1", DEVKIT_TEST_BASH_MARKERS: markers } });
  require_fs().cpSync(join(RUNTIME, ".claude"), join(dir, ".claude"), { recursive: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "claude の設定");
  const settings = join(dir, ".claude", "settings.json");
  const original = readFileSync(settings, "utf8");
  // ガードが登録されていない案件・フックを無効にした案件では、! を受け付けない（Claude の Bash と見分けられない）
  writeFileSync(settings, "{}\n");
  let r = approve();
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /Claude Code の中/);
  assert.match(r.out, /guard-bash/);
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(original), disableAllHooks: true }));
  assert.equal(approve().code, 5);
  writeFileSync(settings, original);
  // Claude が Bash のコマンドを実行中（ガードが目印を残す）: 断る
  assert.equal(hook("guard-bash.mjs", { tool_use_id: "t1", tool_input: { command: "pnpm verify" } }).status, 0);
  r = approve();
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /実行中/);
  // コマンドが終わった（bash-done が目印を消す）: ! からの実行として受け付ける。端末でなくてよく、番号の確認もない
  hook("bash-done.mjs", { tool_use_id: "t1", tool_input: { command: "pnpm verify" } });
  // バックグラウンドのコマンドは、終わりの通知では消さない
  hook("guard-bash.mjs", { tool_use_id: "t2", tool_input: { command: "pnpm dev", run_in_background: true } });
  hook("bash-done.mjs", { tool_use_id: "t2", tool_input: { command: "pnpm dev", run_in_background: true } });
  r = approve();
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /バックグラウンド/);
  // 期限の切れた目印は無効
  for (const f of require_fs().readdirSync(markers)) writeFileSync(join(markers, f), JSON.stringify({ until: Date.now() - 1, background: true }));
  r = approve();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /入力欄（!）からの実行として受け付けます/);
  // Claude の Bash からは、これまでどおりガードが実行の前に止める。目印の場所も書き換えさせない
  assert.equal(hook("guard-bash.mjs", { tool_use_id: "t3", tool_input: { command: "pnpm devkit approve plan --role 技術" } }).status, 2);
  for (const c of [`rm -rf ${markers}`, `rm ${markers}/s1.t1.json`, `rm -rf ${dirname(markers)}`, `echo x > ${markers}/a.json`, `find ${markers} -delete`, `node -e 'fs.rmSync("claude-bash")'`]) assert.equal(hook("guard-bash.mjs", { tool_use_id: "t4", tool_input: { command: c } }).status, 2, c);
  // ランナーが起動した AI は、どの場合も断る
  r = devkit(dir, ["approve", "plan", "--role", "技術"], { scenarioFile, env: { ...inClaude, DEVKIT_ROLE: "implementer" } });
  assert.notEqual(r.code, 0);
});

function require_fs() {
  return process.getBuiltinModule("node:fs");
}
