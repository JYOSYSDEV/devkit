// v4.0 のレビューで見つかった問題の回帰テスト（ランナーの流れ・隔離・改ざんの検出）
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approvePlan, as, calls, defaultScenario, devkit, dockerLog, git, graphFor, implFiles, makeProject, state } from "./helpers.mjs";

const controls = (dir) => JSON.parse(readFileSync(join(dir, ".devkit", "controls.json"), "utf8"));
const argsLog = (scenarioFile) =>
  readFileSync(`${scenarioFile}.args.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

function started(opts = {}) {
  const p = makeProject(opts);
  approvePlan(p.dir, p.scenarioFile);
  const r = devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  assert.equal(r.code, 0, r.out);
  return p;
}

test("検証はコンテナで: インストールはネットワークあり、検証は --network none・読み取り専用・権限なし。取り出しはリポジトリの外", () => {
  const { dir, scenarioFile } = started();
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  const runs = dockerLog(scenarioFile).filter((x) => x.sub === "run");
  assert.ok(runs.length >= 4, JSON.stringify(runs.length));
  for (const x of runs) {
    assert.ok(x.args.includes("--read-only"));
    assert.ok(x.args.includes("--cap-drop"));
    assert.ok(x.args.includes("no-new-privileges"));
    const work = x.mounts.find((m) => m.ctr === "/work");
    assert.ok(work && !work.host.startsWith(`${dir}/`), `取り出しがリポジトリの中にある: ${work?.host}`);
    assert.ok(!x.mounts.some((m) => m.host === dir || m.host.startsWith(`${dir}/`)), "本体のリポジトリはマウントしない");
  }
  const verify = runs.filter((x) => x.phase === "verify");
  const install = runs.filter((x) => x.phase === "install");
  assert.ok(verify.length && install.length);
  assert.ok(verify.every((x) => x.network === "none"));
  assert.ok(verify.every((x) => x.mounts.find((m) => m.ctr === "/cache/tools")?.ro === true && !x.mounts.some((m) => m.ctr === "/cache")));
  assert.ok(install.every((x) => x.network !== "none" && x.mounts.some((m) => m.ctr === "/cache" && !m.ro)));
  // 実装担当とレビュー担当の作業ディレクトリもリポジトリの外
  for (const c of argsLog(scenarioFile)) assert.ok(!c.cwd.startsWith(`${dir}/`) && c.cwd !== dir || c.key.startsWith("replanner"), `${c.key} の作業ディレクトリ: ${c.cwd}`);
  assert.equal(existsSync(join(dir, ".devkit", "worktrees")), false);
  assert.equal(git(dir, "worktree", "list").split("\n").length, 1, "後片付けで取り出しが残らない");
});

test("コンテナのエンジンが動いていなければ、作業を始めずに環境の問題として止まる", () => {
  const { dir, scenarioFile } = started();
  const r = devkit(dir, ["run"], { scenarioFile, env: { FAKE_DOCKER_DOWN: "1" } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /コンテナ/);
  assert.equal(calls(scenarioFile).length, 0, "AI を呼ばない");
});

test("AI のサンドボックス（aiSandbox: required）とガードは --settings で渡し、プロジェクトの設定の写しは読まない", () => {
  const { dir, scenarioFile } = started({ config: { aiSandbox: "required" } });
  if (process.platform === "linux") {
    // サンドボックスの部品がない機械では、起動の前に断る
    const empty = `${dir}-nobin`;
    require_fs().mkdirSync(empty, { recursive: true });
    for (const b of ["git", "node", "sh"]) require_fs().symlinkSync(require_child().execSync(`command -v ${b}`, { encoding: "utf8" }).trim(), join(empty, b));
    const r0 = devkit(dir, ["run"], { scenarioFile, env: { PATH: empty } });
    assert.equal(r0.code, 1, r0.out);
    assert.match(r0.out, /aiSandbox/);
  }
  // 部品がある（ことにした）機械では、渡す設定を確かめる
  const bin = `${dir}-fakebin`;
  require_fs().mkdirSync(bin, { recursive: true });
  for (const b of ["bwrap", "socat"]) writeFileSync(join(bin, b), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = devkit(dir, ["run"], { scenarioFile, env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.out);
  const impl = argsLog(scenarioFile).find((c) => c.key.startsWith("implementer"));
  const settings = JSON.parse(impl.argv[impl.argv.indexOf("--settings") + 1]);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, [dir], "本体のリポジトリには書かせない（一時ディレクトリの下にあっても）");
  assert.equal(settings.sandbox.network.strictAllowlist, true);
  assert.ok(settings.hooks.PreToolUse.some((h) => h.hooks[0].args[0] === join(dir, ".claude", "hooks", "guard-bash.mjs")));
  assert.equal(impl.argv[impl.argv.indexOf("--setting-sources") + 1], "user");
});

test("隔離がなかった場合の改ざん（AI が本体の controls.json を書き換える）を検出して止まり、コミットしない", () => {
  const sc = defaultScenario();
  const p = makeProject({ scenario: sc });
  approvePlan(p.dir, p.scenarioFile);
  devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  const forged = { ...controls(p.dir), approvals: { M1: { technical: { sha: "x", by: "AI" } } } };
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1"), writeAbs: { [join(p.dir, ".devkit", "controls.json")]: JSON.stringify(forged) } }];
  writeFileSync(p.scenarioFile, JSON.stringify(sc));
  const before = git(p.dir, "rev-parse", "HEAD");
  const r = devkit(p.dir, ["run"], { scenarioFile: p.scenarioFile });
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /保護されたファイル/);
  assert.match(git(p.dir, "status", "--porcelain"), /controls\.json/, "改ざんはコミットされずに残る");
  assert.ok(!git(p.dir, "log", "--format=%s", `${before}..HEAD`).includes("ランナー終了"), "終了の状態もコミットしない");
  // 次の起動も、記録と合わない変更があるので断る
  const r2 = devkit(p.dir, ["run"], { scenarioFile: p.scenarioFile });
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /記録と合わない/);
});

test("ランナーの実行中の人のコマンド（journal に残る）は改ざんと区別され、pause は今の作業の後で効く", () => {
  const sc = defaultScenario();
  const p = makeProject({ scenario: sc });
  approvePlan(p.dir, p.scenarioFile);
  devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  // N1 の実装中に、別の端末から pause と判断の記録をする
  sc["implementer:N1"] = [
    {
      files: implFiles("N1", "AC-1"),
      spawn: ["sh", "-c", `"${process.execPath}" scripts/devkit/devkit.mjs pause 朝まで止める && git config user.email tom@example.com && "${process.execPath}" scripts/devkit/devkit.mjs record --role 技術 --target 夜間の運用 --decision 止める`],
      spawnCwd: p.dir,
      spawnEnv: { DEVKIT_HUMAN_TTYLESS: "1", DEVKIT_HUMAN_TEST: "1" },
    },
  ];
  writeFileSync(p.scenarioFile, JSON.stringify(sc));
  const r = devkit(p.dir, ["run"], { scenarioFile: p.scenarioFile });
  const spawned = readFileSync(`${p.scenarioFile}.spawn.log`, "utf8");
  assert.match(spawned, /^0 /, spawned);
  assert.equal(r.code, 0, r.out);
  const s = state(p.dir);
  assert.equal(s.outer, "paused", r.out);
  assert.equal(s.nodes.N1.status, "done", "実行中の作業は終えてから止まる");
  assert.doesNotMatch(r.out, /保護されたファイル/);
  assert.match(readFileSync(join(p.dir, "docs", "decisions.md"), "utf8"), /夜間の運用/);
});

test("lookahead: 前のマイルストーンが差し戻されて直ったら、リリースは検証と承認からやり直す", () => {
  const g = graphFor({ limits: { ...graphFor().limits, lookahead: true } });
  const sc = defaultScenario();
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "差し戻しの修正", nodes: [{ id: "FIX-1", milestone: "M1", title: "差し戻しの修正", deps: ["N1"], owns: ["src/a/fix.js"], acceptance: [], goal: g.nodes[0].goal }] } }];
  sc["implementer:FIX-1"] = [{ files: { "src/a/fix.js": "export const fix = 1;\n" } }];
  const { dir, scenarioFile } = started({ graph: g, scenario: sc });
  let r = devkit(dir, ["run"], { scenarioFile });
  let s = state(dir);
  assert.equal(s.milestones.M1.status, "awaiting_approval", r.out);
  assert.equal(s.milestones.M2.status, "awaiting_approval", r.out);
  const m2head = s.milestones.M2.head;
  as(dir, "alice");
  assert.equal(devkit(dir, ["approve", "M2", "--role", "業務"], { scenarioFile, human: true }).code, 0);
  as(dir, "tom");
  assert.equal(devkit(dir, ["approve", "M2", "--role", "技術"], { scenarioFile, human: true }).code, 0);
  assert.equal(state(dir).milestones.M2.status, "done");
  r = devkit(dir, ["reject", "M1", "--role", "技術", "--note", "直して"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).milestones.M2.status, "active", "後ろのリリースは検証からやり直し");
  r = devkit(dir, ["run"], { scenarioFile });
  s = state(dir);
  assert.equal(s.nodes["FIX-1"].status, "done", r.out);
  assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0);
  r = devkit(dir, ["run"], { scenarioFile });
  s = state(dir);
  assert.notEqual(s.outer, "done", r.out);
  assert.equal(s.milestones.M2.status, "awaiting_approval", r.out);
  assert.notEqual(s.milestones.M2.head, m2head, "修正を含む版で検証し直している");
  assert.equal(git(dir, "merge-base", "--is-ancestor", s.nodes["FIX-1"].merge, s.milestones.M2.head) === "", true);
});

test("人の確認が要る再計画の案があると、再計画をやり直さずに人を待ち、依存しない作業は先に進める", () => {
  const sc = defaultScenario();
  const g = graphFor({ limits: { ...graphFor().limits, maxParallel: 1 } });
  sc["implementer:N2"] = [{ files: { "src/b/index.js": "x\n", "tests/b.test.js": 'test("AC-2: 失敗する", () => {}) // FAIL\n' } }];
  // N2 を M1 に移す案（マイルストーンが変わるので、業務担当者と標準オーナーの両方の確認が要る）
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "N2 を基盤に移す", nodes: [{ ...g.nodes[1], milestone: "M1" }] } }];
  const { dir, scenarioFile } = started({ graph: g, scenario: sc });
  let r = devkit(dir, ["run"], { scenarioFile });
  as(dir, "tom");
  assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0, r.out);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  const s = state(dir);
  assert.equal(s.proposals?.length, 1, r.out);
  assert.equal(s.proposals[0].status, "needs_human");
  assert.deepEqual(s.proposals[0].roles, ["business", "technical"], "マイルストーンに及ぶ案は業務担当者の承認も要る");
  assert.equal(calls(scenarioFile).filter((l) => l.startsWith("replanner")).length, 1, "再計画を繰り返さない");
  assert.equal(s.nodes.N3.status, "done", "依存しない作業は、再計画より先に進める");
  assert.match(r.out, /人の判断待ち/);
  assert.notEqual(s.outer, "stalled");
  // 案の承認は、必要な役割がそろってから計画に入る
  let a = devkit(dir, ["proposal", "accept", s.proposals[0].id, "--role", "技術"], { scenarioFile, human: true });
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /残り/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".devkit", "graph.json"), "utf8")).nodes[1].milestone, "M2");
  as(dir, "alice");
  a = devkit(dir, ["proposal", "accept", s.proposals[0].id, "--role", "業務"], { scenarioFile, human: true });
  assert.equal(a.code, 0, a.out);
  assert.equal(JSON.parse(readFileSync(join(dir, ".devkit", "graph.json"), "utf8")).nodes[1].milestone, "M1");
  assert.equal(state(dir).nodes.N2.status, "pending");
  assert.equal(state(dir).nodes.N2.attempts, 0);
});

test("再計画で前提のノードを足したとき、止まっていたノードも実行できる状態に戻る", () => {
  const sc = defaultScenario();
  const g = graphFor();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "x\n", "tests/a.test.js": 'test("AC-1: 失敗する", () => {}) // FAIL\n' } }, {}, { files: implFiles("N1", "AC-1") }];
  sc["implementer:PRE-1"] = [{ files: { "src/a/pre.js": "export const pre = 1;\n" } }];
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "前提を足す", nodes: [{ id: "PRE-1", milestone: "M1", title: "前提", deps: [], owns: ["src/a/pre.js"], acceptance: [], goal: g.nodes[0].goal }, { ...g.nodes[0], deps: ["PRE-1"] }] } }];
  const { dir, scenarioFile } = started({ graph: g, scenario: sc });
  const r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes["PRE-1"].status, "done", r.out);
  assert.equal(s.nodes.N1.status, "done", r.out);
  assert.equal(calls(scenarioFile).filter((l) => l.startsWith("replanner")).length, 1);
});

test("AI の最終の文章に quota や rate limit とあっても、環境の問題とはみなさない", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1"), text: "利用者ごとの quota と rate limit reached の表示を実装した", output: { status: "implemented", summary: "quota の上限表示（usage limit reached）", evidence: "ok" } }];
  const { dir, scenarioFile } = started({ scenario: sc });
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("claude 自身のエラー（is_error）で認証や上限の問題が出たら、環境の問題として止まる", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ isError: true, turns: 2, text: "Credit balance is too low" }, { files: implFiles("N1", "AC-1") }];
  const { dir, scenarioFile } = started({ scenario: sc });
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 2, r.out);
  assert.equal(state(dir).nodes.N1.attempts, 1);
});

test("ランナーの実行中の pause は、今の作業の後で止まり、上書きされない。resume で戻る", async () => {
  // 上の「journal」のテストで実行中の pause を確かめている。ここでは止まっているときの pause / resume
  const { dir, scenarioFile } = started();
  let r = devkit(dir, ["pause", "確認のため"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).outer, "paused");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 1, r.out);
  r = devkit(dir, ["resume"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(controls(dir).pause, null);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("停止条件の値がおかしければ、黙って上限なしにせずに断る", () => {
  const { dir, scenarioFile } = started();
  for (const args of [["--until", "7時"], ["--until", "07-00"], ["--max-hours", "abc"], ["--max-cost-usd", "-1"]]) {
    const r = devkit(dir, ["run", ...args], { scenarioFile });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
  }
  assert.equal(calls(scenarioFile).length, 0);
});

test("中断から再開しても、ラウンドは数え直さない", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "x\n", "tests/a.test.js": 'test("AC-1: 失敗する", () => {}) // FAIL\n' } }, { envError: "Not logged in · Please run /login" }, {}];
  sc["replanner:-"] = [{ output: { kind: "needs_human", summary: "案なし" } }];
  const { dir, scenarioFile } = started({ scenario: sc });
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 2, r.out);
  assert.equal(state(dir).nodes.N1.roundsDone, 1);
  r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes.N1.history.filter((h) => h.attempt === 1).length, 2, `maxRounds（2）で試行が終わる: ${r.out}`);
  assert.ok(calls(scenarioFile).filter((l) => l.startsWith("implementer:N1")).length <= 4, r.out);
});

test("基盤のノードの allowTestRemoval は、統合後の検証でも効く", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1", { "tests/base.test.js": null }) }];
  const g = graphFor();
  g.nodes[0].owns.push("tests/base.test.js");
  g.nodes[0].allowTestRemoval = ["tests/base.test.js"];
  const { dir, scenarioFile } = started({ graph: g, scenario: sc });
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("シンボリックリンクを足した作業は不合格で、検証コマンドも実行しない", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1") }];
  const { dir, scenarioFile } = started({ scenario: sc });
  // 偽の claude はリンクを作れないので、作業ディレクトリに先回りしてリンクを置く代わりに、ブランチに直接コミットする
  const s0 = state(dir);
  assert.ok(s0);
  const g = graphFor();
  const work = `${dir}-link`;
  git(dir, "worktree", "add", "-q", "-b", "linktest", work, "HEAD");
  symlinkSync("/etc/passwd", join(work, "src-a-link"));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "link");
  const tip = git(work, "rev-parse", "HEAD");
  const base = git(dir, "rev-parse", "HEAD");
  const out = runIntegrity(dir, g.nodes[0], base, tip);
  assert.equal(out.ok, false);
  assert.match(out.failures.join("\n"), /シンボリックリンク/);
  assert.equal(out.checks.verify, undefined, "検証コマンドは実行しない");
});

test("案件の人の承認: 担当者が空なら断る。sha のない承認は数えない", () => {
  const { dir, scenarioFile } = makeProject();
  const p = join(dir, "docs", "profile.json");
  const prof = JSON.parse(readFileSync(p, "utf8"));
  prof.owners.business = [];
  writeFileSync(p, JSON.stringify(prof));
  git(dir, "commit", "-qam", "担当者を空に");
  as(dir, "alice");
  const r = devkit(dir, ["approve", "plan", "--role", "業務"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /空/);
});

test("Claude Code の中（CLAUDECODE）や、親に claude がいるときは、人のコマンドを断る", () => {
  const { dir, scenarioFile } = makeProject();
  as(dir, "alice");
  let r = devkit(dir, ["approve", "plan", "--role", "業務"], { scenarioFile, env: { DEVKIT_HUMAN_TTYLESS: "1", CLAUDECODE: "1" } });
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /Claude Code の中/);
  // 親のプロセスの名前が claude
  const fake = join(dir, "..", `${dir.split("/").pop()}-claude`, "claude");
  require_fs().mkdirSync(join(fake, ".."), { recursive: true });
  writeFileSync(fake, `#!/bin/sh\n"${process.execPath}" "${join(dir, "scripts", "devkit", "devkit.mjs")}" approve plan --role 業務\nexit $?\n`, { mode: 0o755 });
  const out = require_child().spawnSync(fake, [], { cwd: dir, encoding: "utf8", env: { ...cleanEnv(), DEVKIT_HUMAN_TTYLESS: "1" } });
  assert.equal(out.status, 5, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /親のプロセス/);
});

test("判断の記録（record）は人が端末で残せる", () => {
  const { dir, scenarioFile } = makeProject();
  as(dir, "tom");
  let r = devkit(dir, ["record", "--role", "技術", "--target", "devkit の更新", "--decision", "4.0.0 → 4.1.0"], { scenarioFile });
  assert.equal(r.code, 5, r.out);
  r = devkit(dir, ["record", "--role", "技術", "--target", "devkit の更新", "--decision", "4.0.0 → 4.1.0", "--note", "検証の隔離"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /4\.0\.0 → 4\.1\.0/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("再計画を書いている途中で落ちても、次の起動で記録を完了する", () => {
  const { dir, scenarioFile } = started();
  const gp = join(dir, ".devkit", "graph.json");
  const g = JSON.parse(readFileSync(gp, "utf8"));
  g.nodes[0].goal += " 失敗したテストは期待値を手で求めて直す。";
  // 新しい案のハッシュを先に記録し（ランナーと同じ順）、graph.json を書いたところで落ちたことにする
  const { planHash } = require_model();
  const ctx = { root: dir, graph: gp, mission: join(dir, ".devkit", "mission.md") };
  const hash = planHash(ctx, g);
  const c = controls(dir);
  c.pendingReplan = { id: "replan-M1-1", hash, prevHash: c.plan.approvedHash, at: new Date().toISOString(), summary: "goal の具体化" };
  writeFileSync(join(dir, ".devkit", "controls.json"), JSON.stringify(c, null, 2));
  writeFileSync(gp, JSON.stringify(g, null, 2));
  git(dir, "commit", "-qam", "落ちる前の状態");
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  const after = controls(dir);
  assert.equal(after.pendingReplan, null);
  assert.equal(after.plan.approvedHash, hash);
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

// ---- 小さな補助 ----

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function require_child() {
  return require("node:child_process");
}
function require_fs() {
  return require("node:fs");
}
import * as model from "../../plugins/devkit/runtime/scripts/devkit/lib/model.mjs";

function require_model() {
  return model;
}
import { cleanEnv } from "./helpers.mjs";

function envFor(scenarioFile) {
  return { ...cleanEnv(), DEVKIT_FAKE_SCENARIO: scenarioFile, FAKE_DOCKER_LOG: `${scenarioFile}.docker.log`, DEVKIT_HUMAN_TEST: "1" };
}

function runIntegrity(dir, node, base, tip) {
  const script = `
    import { createContext, loadConfig, loadGraph } from ${JSON.stringify(join(dir, "scripts/devkit/lib/model.mjs"))};
    import { integrityNode } from ${JSON.stringify(join(dir, "scripts/devkit/lib/verify.mjs"))};
    const ctx = createContext(${JSON.stringify(dir)});
    const config = loadConfig(ctx);
    const g = loadGraph(ctx);
    const node = ${JSON.stringify({ ...node, owns: [...node.owns, "src-a-link"] })};
    const ev = await integrityNode(ctx, config, g, { ...node, allowTestRemoval: [], verify: "standard" }, { base: ${JSON.stringify(base)}, tip: ${JSON.stringify(tip)}, logDir: ${JSON.stringify(join(dir, ".devkit", "logs", "t"))}, label: "t" });
    console.log(JSON.stringify({ ok: ev.ok, failures: ev.failures, checks: ev.checks }));
  `;
  const r = require_child().spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8", env: cleanEnv() });
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
