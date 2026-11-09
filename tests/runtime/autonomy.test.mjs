// 4.3.0: 自律運用の拡張（技術提案書の段階0〜2）の試験
//   段階0: 承認の保護と失効条件（コミット済みの改変・着手前の承認の失効・古い版の承認）
//   段階1: 定時ブリーフィング（B-01〜03）
//   段階2: Supervisor（A-01〜02・R-01・S-01）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyHumanDecisions, decide, nodeKey, normalizeGraph, syncState } from "../../plugins/devkit/runtime/scripts/devkit/lib/model.mjs";
import { approvePlan, as, defaultScenario, devkit, git, graphFor, makeProject, RUNTIME, state } from "./helpers.mjs";

const controlsPath = (dir) => join(dir, ".devkit", "controls.json");
const controls = (dir) => JSON.parse(readFileSync(controlsPath(dir), "utf8"));

export function started(opts = {}) {
  const p = makeProject(opts);
  approvePlan(p.dir, p.scenarioFile);
  const r = devkit(p.dir, ["start"], { scenarioFile: p.scenarioFile });
  assert.equal(r.code, 0, r.out);
  return p;
}

// ---------- 段階0 ----------

test("S-01: コミット済みの承認の偽装は、ランナーが起動前に止める。戻せば動き、受け入れは標準オーナーだけ", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.milestones.M1.status, "awaiting_approval");
  // ランナーと人のコマンド以外（メインのセッションのプログラムなど）が承認を書き、コミットまでしてしまう
  const c = controls(dir);
  c.approvals.M1 = { technical: { sha: s.milestones.M1.head, by: "Tom", email: "tom@example.com", at: new Date().toISOString() } };
  writeFileSync(controlsPath(dir), JSON.stringify(c, null, 2));
  git(dir, "commit", "-qam", "偽の承認");
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /controls\.json/);
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval", "偽の承認で完了にしない");
  r = devkit(dir, ["seal"], { scenarioFile });
  assert.match(r.out, /controls\.json/);
  // 受け入れは標準オーナーだけ（業務担当者は断る）
  as(dir, "alice");
  r = devkit(dir, ["seal", "accept", "--role", "業務", "--note", "見た"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0, r.out);
  // 戻せば動く
  git(dir, "revert", "--no-edit", "HEAD");
  as(dir, "tom");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
});

test("S-01: 人が内容を確かめた変更は、seal accept で受け入れ、判断の記録に残る", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["run"], { scenarioFile });
  const c = controls(dir);
  c.maxCycles = 25;
  writeFileSync(controlsPath(dir), JSON.stringify(c, null, 2));
  git(dir, "commit", "-qam", "上限を手で直した");
  assert.equal(devkit(dir, ["run"], { scenarioFile }).code, 5);
  const r = devkit(dir, ["seal", "accept", "--role", "技術", "--note", "上限の変更を確かめた"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /記録の受け入れ/);
  assert.equal(devkit(dir, ["run"], { scenarioFile }).code, 0);
});

test("ランナーが書いてコミットした状態は、別の起動でも説明できる（journal に残る）", () => {
  const { dir, scenarioFile } = started();
  assert.equal(devkit(dir, ["run"], { scenarioFile }).code, 0);
  // 前回のランナーの記録（run.json。手元にだけある）がなくても、journal で説明できる
  spawnSync("rm", ["-f", join(dir, ".devkit", "run.json")]);
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(dir, ".devkit", "journal.jsonl"), "utf8"), /"command":"runner"/);
});

function fixture(overrides = {}) {
  const g = normalizeGraph(graphFor(overrides));
  const s = syncState(g, { outer: "running", nodes: {}, milestones: {} });
  const c = { version: 2, plan: { approvedHash: null, approvals: {}, history: [] }, gates: {}, approvals: {}, answers: {}, rejections: {}, proposals: {}, pause: null };
  return { g, s, c };
}

test("着手前の承認は、ノードの定義に紐づく。再計画で定義が変われば取り直し。古い版の承認は数えない", () => {
  const base = graphFor();
  base.nodes[1].before = ["business"];
  let { g, s, c } = fixture({ nodes: base.nodes });
  s.nodes.N1.status = "done";
  s.milestones.M1.status = "done";
  const key = nodeKey(g.nodes[1]);
  c.approvals["N2:before"] = { business: { sha: key, by: "Alice" } };
  assert.ok(decide(g, s, c).ready.some((n) => n.id === "N2"), "定義が同じなら承認が効く");
  // 定義（goal）が変わったら、承認は効かない
  g.nodes[1].goal += " 追記";
  let d = decide(g, s, c);
  assert.ok(!d.ready.some((n) => n.id === "N2"));
  assert.ok(d.waiting.approvals.some((a) => a.target === "N2" && a.kind === "before"));
  // sha のない（4.2 までの）承認も数えない
  ({ g, s, c } = fixture({ nodes: base.nodes }));
  s.nodes.N1.status = "done";
  s.milestones.M1.status = "done";
  c.approvals["N2:before"] = { business: { by: "Alice" } };
  assert.ok(!decide(g, s, c).ready.some((n) => n.id === "N2"));
  // マイルストーンの承認は検証したコミットに紐づく（古い版の承認では完了にしない）
  ({ g, s, c } = fixture());
  Object.assign(s.milestones.M1, { status: "awaiting_approval", head: "new", required: ["technical"] });
  c.approvals.M1 = { technical: { sha: "old" } };
  applyHumanDecisions(g, s, c);
  assert.equal(s.milestones.M1.status, "awaiting_approval");
});

test("記録の受け入れと Supervisor の停止の解除は、Claude からは実行できない", () => {
  const HOOK = join(RUNTIME, ".claude", "hooks", "guard-bash.mjs");
  const run = (command) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: process.cwd(), tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_"))) }).status;
  for (const c of ["pnpm devkit seal accept --role 技術 --note x", "pnpm devkit supervisor clear --role 技術 --note x", "node scripts/devkit/devkit.mjs seal accept", 'node -e "require(\'child_process\').execSync(\'pnpm devkit supervisor clear\')"'])
    assert.equal(run(c), 2, c);
  for (const c of ["pnpm devkit seal", "pnpm devkit supervisor status", "pnpm devkit briefing --print"]) assert.equal(run(c), 0, c);
});

// ---------- 段階1: 定時ブリーフィング ----------

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanEnv, implFiles } from "./helpers.mjs";

const tomorrow = () => new Date(Date.now() + 24 * 3600_000).toISOString();
const briefingJson = (dir, scenarioFile, at = tomorrow(), extra = []) => {
  const r = devkit(dir, ["briefing", "--json", "--at", at, ...extra], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.out);
};
const events = (dir) => {
  const p = join(dir, ".devkit", "events.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const svState = (dir) => JSON.parse(readFileSync(join(dir, ".devkit", "cache", "supervisor", "state.json"), "utf8"));
const outbox = (dir) => {
  const d = join(dir, ".devkit", "cache", "supervisor", "outbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8"))) : [];
};

test("B-01: 一晩に複数回の実行があっても、対象期間の新しい成果だけを重複なく集め、コミットと証跡を追える", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["run"], { scenarioFile });
  as(dir, "tom");
  assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0);
  devkit(dir, ["run"], { scenarioFile });
  // 前の期間に完了したもの（N1）は、今回の成果に数えない（完了の累積値を夜間の成果にしない）
  const sp = join(dir, ".devkit", "state.json");
  const st = JSON.parse(readFileSync(sp, "utf8"));
  st.nodes.N1.mergedAt = "2026-01-01T00:00:00.000Z";
  writeFileSync(sp, JSON.stringify(st, null, 2));
  const b = briefingJson(dir, scenarioFile);
  const ids = b.achievements.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "同じ成果を2回数えない");
  const nodes = b.achievements.filter((a) => a.kind === "node").map((a) => a.target);
  assert.deepEqual(nodes.sort(), ["N2", "N3"]);
  for (const a of b.achievements.filter((x) => x.kind === "node")) {
    assert.match(a.commit, /^[0-9a-f]{10}$/);
    assert.ok(existsSync(join(dir, a.evidence)), a.evidence);
    assert.match(a.verification, /すべて合格/);
  }
  assert.equal(b.operations.runs.length, 2, "2回の実行を、それぞれ1回として数える");
  assert.ok(b.decisions.some((d) => d.id.startsWith("M2@") && d.role === "business"));
  assert.match(b.subject, /^［devkit／test］夜間成果\d+件・判断\d+件・判断後に\d+作業$/);
});

test("B-02: 締切の時点で実行中・落ちた実行・成果なし・AI に届かない、のどれでも作れて、その事実を書く", () => {
  // 成果なし ＋ AI に届かない（ブリーフィングは AI を使わない）
  let p = started({ config: { claudeBin: "/nonexistent/claude" } });
  let b = briefingJson(p.dir, p.scenarioFile);
  assert.equal(b.achievements.length, 0);
  assert.match(b.text, /新しく完了したものはありません/);
  // 実行中
  p = started();
  const { dir } = p;
  writeFileSync(join(dir, ".devkit", "run.lock"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  writeFileSync(join(dir, ".devkit", "run.json"), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString(), phase: "作業中", current: { N1: { step: "実装" } } }));
  b = briefingJson(dir, p.scenarioFile);
  assert.equal(b.operations.runner.alive, true);
  assert.match(b.text, /ランナー: 実行中（作業中: N1）/);
  // 落ちた実行（開始の記録だけがある）
  spawnSync("rm", ["-f", join(dir, ".devkit", "run.lock"), join(dir, ".devkit", "run.json")]);
  writeFileSync(join(dir, ".devkit", "events.jsonl"), `${JSON.stringify({ id: "run:x:999999:start", at: new Date().toISOString(), type: "run_started", run: "x", pid: 999999 })}\nこわれた行\n`);
  b = briefingJson(dir, p.scenarioFile);
  assert.ok(b.missing.some((m) => /途中で終わった実行/.test(m)), JSON.stringify(b.missing));
  assert.ok(b.missing.some((m) => /読めない行が 1 行/.test(m)));
  // 締切に遅れて作ったときは、対象期間を動かさずに遅れを書く
  const late = briefingJson(dir, p.scenarioFile, new Date(Date.now() + 25 * 3600_000).toISOString());
  assert.ok(late.delayMinutes >= 0);
  assert.equal(Date.parse(late.window.until) - Date.parse(late.window.since), 24 * 3600_000);
});

test("B-03: 配信に失敗しても、Supervisor を起動し直すと送信待ちから送り直す。配信キーで2回送らない", () => {
  const { dir, scenarioFile } = started();
  const sink = `${dir}-sink.txt`;
  // 自動の起動は止めておく（ブリーフィングは続ける）
  assert.equal(devkit(dir, ["supervisor", "stop", "試験"], { scenarioFile }).code, 0);
  let r = devkit(dir, ["briefing", "--send"], { scenarioFile, env: { DEVKIT_NOTIFY_CMD: "exit 1" } });
  assert.equal(r.code, 0, r.out);
  let [e] = outbox(dir);
  assert.equal(e.status, "pending");
  assert.equal(e.attempts, 1);
  assert.match(e.lastError, /exit 1/);
  assert.ok(existsSync(join(dir, e.file)), "送れなくても、保存したブリーフィングは見られる");
  const cmd = `node -e "require('fs').appendFileSync(process.argv[1], process.env.DEVKIT_MESSAGE_FILE + '\\n')" ${sink}`;
  const later = new Date(Date.parse(e.nextAt) + 1000).toISOString();
  r = devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOTIFY_CMD: cmd, DEVKIT_NOW: later } });
  assert.equal(r.code, 0, r.out);
  e = outbox(dir).find((x) => x.key === e.key);
  assert.equal(e.status, "sent", JSON.stringify(e));
  r = devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOTIFY_CMD: cmd, DEVKIT_NOW: later } });
  r = devkit(dir, ["briefing", "--send"], { scenarioFile, env: { DEVKIT_NOTIFY_CMD: cmd, DEVKIT_NOW: later } });
  const lines = readFileSync(sink, "utf8").trim().split("\n").filter((l) => l.endsWith(e.file.split("/").pop()));
  assert.equal(lines.length, 1, "同じ締切・送り先には1回だけ送る");
  assert.equal(svState(dir).status, "manual_stop");
  assert.equal(events(dir).filter((x) => x.type === "supervisor_launch").length, 0, "手動停止の間は、ランナーを起動しない");
});

// ---------- 段階2: Supervisor ----------

test("A-01: 有効な判断を検知して再開する（ファイルの変更の通知で、照合の間隔を待たずに）。ロックで二重に起動しない", async () => {
  const { dir, scenarioFile } = started({ config: { supervisor: { intervalSeconds: 60 } } });
  assert.equal(devkit(dir, ["supervisor", "run", "--once"], { scenarioFile }).code, 0);
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
  // Supervisor を常駐させる（照合の間隔は上限の 60 秒。15 秒以内に動けば、変更の通知で動いている）
  const child = spawnSync.constructor; // 型だけ（下で spawn を使う）
  const { spawn } = await import("node:child_process");
  const proc = spawn(process.execPath, [join(dir, "scripts", "devkit", "devkit.mjs"), "supervisor", "run"], { cwd: dir, env: { ...cleanEnv(), DEVKIT_FAKE_SCENARIO: scenarioFile, FAKE_DOCKER_LOG: `${scenarioFile}.docker.log` }, stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !existsSync(join(dir, ".devkit", "cache", "supervisor", "lock")); i++) await sleep(100);
    await sleep(500);
    // 2つ目の Supervisor は起動しない
    const second = devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
    assert.notEqual(second.code, 0);
    assert.match(second.out, /別の Supervisor/);
    const count = (type) => events(dir).filter((e) => e.type === type).length;
    const launches0 = count("supervisor_launch");
    const exits0 = count("supervisor_runner_exit");
    const t0 = Date.now();
    as(dir, "tom");
    assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0);
    while (count("supervisor_launch") === launches0 && Date.now() - t0 < 60_000) await sleep(100);
    assert.equal(count("supervisor_launch"), launches0 + 1, "判断から60秒以内に再開の判定をする");
    assert.ok(Date.now() - t0 < 15_000, "照合の間隔を待たずに、変更の通知で動く");
    while (count("supervisor_runner_exit") === exits0 && Date.now() - t0 < 120_000) await sleep(100);
    await sleep(1500);
    assert.equal(count("supervisor_launch"), launches0 + 1, "ランナーは1つだけ起動する");
    assert.ok(child);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("exit", r));
  }
  assert.equal(state(dir).milestones.M2.status, "awaiting_approval", JSON.stringify(events(dir).filter((e) => e.type.startsWith("supervisor_") || e.type.startsWith("run_")).map((e) => [e.type, e.kind, e.code, e.reason, e.status])));
});

test("A-01: ほかのランナーが動いているときは、起動しない", () => {
  const { dir, scenarioFile } = started();
  writeFileSync(join(dir, ".devkit", "run.lock"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  writeFileSync(join(dir, ".devkit", "run.json"), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
  assert.equal(devkit(dir, ["supervisor", "run", "--once"], { scenarioFile }).code, 0);
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 0);
  assert.equal(svState(dir).status, "running");
});

async function journalWriteIn(dir, rel, obj, command) {
  const { journalWrite } = await import(join(dir, "scripts", "devkit", "lib", "seal.mjs"));
  journalWrite({ root: dir }, rel, `${JSON.stringify(obj, null, 2)}\n`, command);
}

test("A-02: 誤った役割の判断・古い版への承認・手動停止では、自動で再開しない。解除は人が端末で", async () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  const head = state(dir).milestones.M1.head;
  const launches = () => events(dir).filter((e) => e.type === "supervisor_launch").length;
  assert.equal(launches(), 1);
  // 誤った役割（業務担当者による M1 の承認。M1 の承認者は標準オーナー）と、古い版への承認
  const c = controls(dir);
  c.approvals.M1 = { business: { sha: head, by: "Alice" }, technical: { sha: "0000000000old", by: "Tom" } };
  await journalWriteIn(dir, ".devkit/controls.json", c, "approve");
  assert.equal(devkit(dir, ["supervisor", "run", "--once"], { scenarioFile }).code, 0);
  assert.equal(launches(), 1, "反映されない判断では起動しない");
  assert.equal(svState(dir).status, "waiting_human");
  // 手動停止の間は、有効な承認があっても起動しない
  devkit(dir, ["supervisor", "stop", "保守"], { scenarioFile });
  as(dir, "tom");
  assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0);
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(launches(), 1);
  assert.equal(svState(dir).status, "manual_stop");
  // 解除は標準オーナーが端末で（Claude からはガードが止める）。解除すると次の照合で起動する
  as(dir, "alice");
  assert.notEqual(devkit(dir, ["supervisor", "clear", "--role", "業務", "--note", "x"], { scenarioFile, human: true }).code, 0);
  as(dir, "tom");
  const r = devkit(dir, ["supervisor", "clear", "--role", "技術", "--note", "保守が終わった"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(launches(), 2);
  assert.match(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /Supervisor の停止の解除/);
});

test("R-01: 一時的な障害は待って再試行し、上限で止まる。試行の回数は Supervisor を起動し直しても数え直さない", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ envError: "Error: socket hang up ECONNRESET" }];
  const { dir, scenarioFile } = started({ scenario: sc, config: { supervisor: { retry: { maxAttempts: 2, baseSeconds: 60 } } } });
  let at = Date.now();
  for (let i = 1; i <= 2; i++) {
    devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: new Date(at).toISOString() } });
    const st = svState(dir);
    assert.equal(st.status, "retry_wait", JSON.stringify(st));
    assert.equal(st.current.attempt, i);
    assert.equal(st.current.kind, "transient");
    // 待っている間は起動しない
    devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: new Date(at + 1000).toISOString() } });
    assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, i);
    at = Date.parse(st.current.nextAt) + 1000;
  }
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: new Date(at).toISOString() } });
  assert.equal(svState(dir).status, "limit_stop", "上限を超えたら止まり、自動では解除しない");
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: new Date(at + 3600_000).toISOString() } });
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 3);
  assert.equal(state(dir).nodes.N1.attempts, 1, "環境の問題で3回起動しても、作業の試行は1回のまま（中断の続きから）");
  assert.equal(state(dir).nodes.N1.status, "pending");
});

test("R-01: 認証切れは報告して止まり、再試行しない。利用上限は復帰の時刻まで待つ。API の課金には切り替えない", () => {
  let sc = defaultScenario();
  sc["implementer:N1"] = [{ envError: "Not logged in · Please run /login" }];
  let p = started({ scenario: sc });
  devkit(p.dir, ["supervisor", "run", "--once"], { scenarioFile: p.scenarioFile });
  assert.equal(svState(p.dir).status, "env_stop");
  assert.match(svState(p.dir).reason, /login/);
  devkit(p.dir, ["supervisor", "run", "--once"], { scenarioFile: p.scenarioFile });
  assert.equal(events(p.dir).filter((e) => e.type === "supervisor_launch").length, 1);

  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  sc = defaultScenario();
  sc["implementer:N1"] = [{ envError: `Claude AI usage limit reached|${reset}` }, { files: implFiles("N1", "AC-1") }];
  p = started({ scenario: sc });
  const env = { ANTHROPIC_API_KEY: "sk-ant-dummy-not-used" };
  devkit(p.dir, ["supervisor", "run", "--once"], { scenarioFile: p.scenarioFile, env });
  let st = svState(p.dir);
  assert.equal(st.status, "retry_wait");
  assert.equal(st.current.kind, "rate_limit");
  assert.ok(Date.parse(st.current.nextAt) >= reset * 1000, "復帰の時刻より前には再開しない");
  devkit(p.dir, ["supervisor", "run", "--once"], { scenarioFile: p.scenarioFile, env: { ...env, DEVKIT_NOW: new Date(reset * 1000 - 60_000).toISOString() } });
  assert.equal(events(p.dir).filter((e) => e.type === "supervisor_launch").length, 1);
  devkit(p.dir, ["supervisor", "run", "--once"], { scenarioFile: p.scenarioFile, env: { ...env, DEVKIT_NOW: new Date(Date.parse(st.current.nextAt) + 1000).toISOString() } });
  st = svState(p.dir);
  assert.equal(events(p.dir).filter((e) => e.type === "supervisor_launch").length, 2);
  assert.equal(state(p.dir).nodes.N1.status, "done");
  const calls = readFileSync(`${p.scenarioFile}.args.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => c.apiKey === false), "API キーをランナーに渡さない");
});

test("S-01: 記録の不整合を見つけたら、Supervisor はすぐ止まり、すぐ知らせ、証拠を残す。自動では再試行しない", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  const c = controls(dir);
  c.approvals.M1 = { technical: { sha: state(dir).milestones.M1.head } };
  writeFileSync(controlsPath(dir), JSON.stringify(c, null, 2));
  git(dir, "commit", "-qam", "偽の承認");
  const sink = `${dir}-urgent.txt`;
  const cmd = `node -e "require('fs').appendFileSync(process.argv[1], process.env.DEVKIT_MESSAGE + '\\n')" ${sink}`;
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOTIFY_TECH_CMD: cmd } });
  assert.equal(svState(dir).status, "policy_stop");
  assert.match(readFileSync(sink, "utf8"), /Supervisor が止まりました（policy_stop）/);
  assert.ok(readdirSync(join(dir, ".devkit", "reports")).some((f) => f.startsWith("supervisor-integrity-")));
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 1, "偽の承認で再開しない");
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
  assert.ok(mkdirSync);
});

test("A-02: ランナーの実行中に手動で止めたら、ランナーが終わっても止まったまま", () => {
  const sc = defaultScenario();
  // 実装の途中で、人（または Claude）が supervisor stop を実行する
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1"), spawnCwd: null }];
  const { dir, scenarioFile } = started({ scenario: sc });
  sc["implementer:N1"][0].spawn = [process.execPath, join(dir, "scripts", "devkit", "devkit.mjs"), "supervisor", "stop", "実行中に止める"];
  sc["implementer:N1"][0].spawnCwd = dir;
  writeFileSync(scenarioFile, JSON.stringify(sc));
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(svState(dir).status, "manual_stop", JSON.stringify(svState(dir)));
  as(dir, "tom");
  devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true });
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 1);
});

// ---------- 独立レビューで見つかった穴（4.3.0 の開発中） ----------

import { parseRunLimits } from "../../plugins/devkit/runtime/scripts/devkit/lib/runner.mjs";
import { configProblems, loadConfig } from "../../plugins/devkit/runtime/scripts/devkit/lib/model.mjs";
import { endOfHours } from "../../plugins/devkit/runtime/scripts/devkit/lib/supervisor.mjs";

test("照合の途中で手動停止したら、その照合でもランナーを起動しない", async () => {
  const { dir, scenarioFile } = started();
  const { spawn } = await import("node:child_process");
  // ブリーフィングの配信で照合が数秒止まる間に、supervisor stop を実行する
  const proc = spawn(process.execPath, [join(dir, "scripts", "devkit", "devkit.mjs"), "supervisor", "run", "--once"], {
    cwd: dir,
    env: { ...cleanEnv(), DEVKIT_FAKE_SCENARIO: scenarioFile, DEVKIT_TEST_CLOCK: "1", DEVKIT_NOTIFY_CMD: "sleep 3" },
    stdio: "ignore",
  });
  await sleep(1200);
  assert.equal(devkit(dir, ["supervisor", "stop", "照合の途中で"], { scenarioFile }).code, 0);
  await new Promise((r) => proc.on("exit", r));
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 0);
  assert.equal(svState(dir).status, "manual_stop");
});

test("git revert で人の判断（一時停止）を巻き戻すと、ランナーも Supervisor も起動しない", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["run"], { scenarioFile });
  as(dir, "tom");
  assert.equal(devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true }).code, 0);
  assert.equal(devkit(dir, ["pause", "朝まで止める"], { scenarioFile }).code, 0);
  assert.equal(state(dir).outer, "paused");
  git(dir, "revert", "--no-edit", "HEAD");
  assert.equal(state(dir).outer, "running", "巻き戻すと一時停止が消える");
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /journal/);
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(svState(dir).status, "policy_stop");
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 0);
  // 意図した巻き戻しなら、標準オーナーが受け入れる
  r = devkit(dir, ["seal", "accept", "--role", "技術", "--note", "一時停止の取り消しは意図したもの"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(devkit(dir, ["run"], { scenarioFile }).code, 0);
});

test("時間帯の終わりは、機械のタイムゾーンに関係なく、設定のタイムゾーンで渡す", () => {
  const at = new Date("2026-11-09T13:30:00Z"); // 22:30 JST
  assert.equal(endOfHours(at, "22:00-07:00", "Asia/Tokyo").toISOString(), "2026-11-09T22:00:00.000Z");
  assert.equal(parseRunLimits({ until: "2026-11-09T22:00:00.000Z" }).until.at, Date.parse("2026-11-09T22:00:00.000Z"));
  assert.equal(parseRunLimits({ until: "07:00" }).until.h, 7);
  const cfg = loadConfig({ config: "/nonexistent" });
  cfg.supervisor.intervalSeconds = 300;
  assert.ok(configProblems(cfg).some((p) => /intervalSeconds/.test(p)), "照合の間隔は 60 秒まで（判断から1分以内に再開を判定する）");
});

test("前の Supervisor が見届けられなかったランナーの終わり方（利用上限など）も、同じに扱う", () => {
  const { dir, scenarioFile } = started();
  const d = join(dir, ".devkit", "cache", "supervisor");
  mkdirSync(d, { recursive: true });
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(d, "state.json"), JSON.stringify({ status: "running", child: { pid: 999999, startedAt, before: "x" }, failures: {}, day: {} }));
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  writeFileSync(join(dir, ".devkit", "events.jsonl"), `${JSON.stringify({ id: "run:z:999999:end", at: new Date().toISOString(), type: "run_ended", run: "z", pid: 999999, code: 2, reason: `環境の問題で止まりました: usage limit reached|${reset}` })}\n`);
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  const st = svState(dir);
  assert.equal(st.status, "retry_wait", JSON.stringify(st));
  assert.equal(st.current.kind, "rate_limit");
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 0);
});

test("一時的な障害は、文言が毎回違っても種類ごとに数え、上限で止まる", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ envError: "Error: socket hang up" }, { envError: "connect ETIMEDOUT 10.0.0.1:443" }, { envError: "API Error: 503 Service Unavailable" }, { envError: "fetch failed ECONNRESET" }];
  const { dir, scenarioFile } = started({ scenario: sc, config: { supervisor: { retry: { maxAttempts: 2 } } } });
  let at = Date.now();
  for (let i = 0; i < 3; i++) {
    devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: new Date(at).toISOString() } });
    const st = svState(dir);
    if (st.current?.nextAt) at = Date.parse(st.current.nextAt) + 1000;
  }
  assert.equal(svState(dir).status, "limit_stop", JSON.stringify(svState(dir)));
  assert.equal(events(dir).filter((e) => e.type === "supervisor_launch").length, 3);
});

test("試験用の時計（DEVKIT_NOW）は、試験の印がなければ効かない。Claude のコマンドでは使えない", () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["supervisor", "stop", "試験"], { scenarioFile });
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile, env: { DEVKIT_NOW: "2027-06-01T00:00:00Z", DEVKIT_TEST_CLOCK: "" } });
  assert.ok(Date.parse(svState(dir).briefing.lastDeadline) < Date.now(), "未来の締切を記録しない");
  const HOOK = join(RUNTIME, ".claude", "hooks", "guard-bash.mjs");
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command: "DEVKIT_NOW=2027-06-01T00:00:00Z pnpm devkit supervisor run --once" } }), encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 2);
});

test("送信待ち: 送り先があとで設定されれば送る。壊れたファイルがあっても止まらない。同時に送っても1回", async () => {
  const { dir, scenarioFile } = started();
  devkit(dir, ["supervisor", "stop", "試験"], { scenarioFile });
  let r = devkit(dir, ["briefing", "--send"], { scenarioFile });
  let [e] = outbox(dir);
  assert.equal(e.status, "no_target");
  writeFileSync(join(dir, ".devkit", "cache", "supervisor", "outbox", "broken.json"), "{こわれた");
  const sink = `${dir}-sink2.txt`;
  const cmd = `sleep 1; node -e "require('fs').appendFileSync(process.argv[1], 'x\\n')" ${sink}`;
  const later = new Date(Date.parse(e.nextAt) + 1000).toISOString();
  const { spawn } = await import("node:child_process");
  const one = () =>
    new Promise((res) => {
      const p = spawn(process.execPath, [join(dir, "scripts", "devkit", "devkit.mjs"), "briefing", "--send"], { cwd: dir, env: { ...cleanEnv(), DEVKIT_TEST_CLOCK: "1", DEVKIT_NOW: later, DEVKIT_NOTIFY_CMD: cmd }, stdio: "ignore" });
      p.on("exit", res);
    });
  await Promise.all([one(), one()]);
  e = outbox(dir).find((x) => x.key === e.key);
  assert.equal(e.status, "sent", JSON.stringify(e));
  assert.equal(readFileSync(sink, "utf8").trim().split("\n").length, 1, "同じ配信キーは、同時に送っても1回");
  assert.ok(existsSync(join(dir, ".devkit", "cache", "supervisor", "outbox", "broken.json.broken")), "壊れたファイルは脇へよける");
  r = devkit(dir, ["supervisor", "status"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
});

test("遅れて作ったブリーフィングでも、締切の時点で実行中だったものを落ちたとは書かない。止まっていた間の締切の分も作る", () => {
  const { dir, scenarioFile } = started();
  const dl = Date.parse(briefingJson(dir, scenarioFile, new Date().toISOString()).window.until);
  const ev = (id, at, type, extra = {}) => JSON.stringify({ id, at: new Date(at).toISOString(), type, run: "r", pid: 4242, ...extra });
  writeFileSync(join(dir, ".devkit", "events.jsonl"), `${[ev("a", dl - 3600_000, "run_started"), ev("b", dl + 600_000, "run_ended", { code: 0, reason: "人の判断待ち" })].join("\n")}\n`);
  const b = briefingJson(dir, scenarioFile, new Date(dl + 1800_000).toISOString());
  assert.ok(!b.missing.some((m) => /途中で終わった/.test(m)), JSON.stringify(b.missing));
  assert.match(b.text, /締切の時点で実行中/);
  // 3日前の締切まで作ってあり、その後 Supervisor が止まっていた
  const d = join(dir, ".devkit", "cache", "supervisor");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "state.json"), JSON.stringify({ status: "watching", briefing: { lastDeadline: new Date(dl - 3 * 24 * 3600_000).toISOString() }, failures: {}, day: {} }));
  devkit(dir, ["supervisor", "stop", "試験"], { scenarioFile });
  devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  const files = readdirSync(join(dir, ".devkit", "briefings")).filter((f) => f.endsWith(".md") && !f.includes("partial"));
  assert.equal(files.length, 3, files.join(","));
});

test("Supervisor のロック: 書きかけ・使い回された pid の古いロックでは止まらない", () => {
  const { dir, scenarioFile } = started();
  const d = join(dir, ".devkit", "cache", "supervisor");
  mkdirSync(d, { recursive: true });
  devkit(dir, ["supervisor", "stop", "試験"], { scenarioFile });
  writeFileSync(join(d, "lock"), "");
  spawnSync("touch", ["-d", "1 minute ago", join(d, "lock")]);
  let r = devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  // 再起動の後に、別のプロセスが同じ pid を使っている（pid 1）。最後の応答はずっと前
  writeFileSync(join(d, "lock"), JSON.stringify({ pid: 1, host: hostname(), startedAt: "2026-01-01T00:00:00Z" }));
  const st = svState(dir);
  st.heartbeatAt = "2026-01-01T00:00:00Z";
  writeFileSync(join(d, "state.json"), JSON.stringify(st));
  r = devkit(dir, ["supervisor", "run", "--once"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
});
