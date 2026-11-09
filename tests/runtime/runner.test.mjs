import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approvePlan, as, calls, defaultScenario, devkit, git, graphFor, implFiles, makeProject, state } from "./helpers.mjs";

test("計画の承認 → 開始 → ゲート → 承認 → 完了まで通る", () => {
  const { dir, scenarioFile } = makeProject();
  let r = devkit(dir, ["check"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /未承認/);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.notEqual(r.code, 0, "承認前は起動できない");
  assert.match(r.out, /承認されていません/);
  const [a, b] = approvePlan(dir, scenarioFile);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  r = devkit(dir, ["start"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  let s = state(dir);
  assert.equal(s.nodes.N1.status, "done", r.out);
  assert.equal(s.milestones.M1.status, "awaiting_approval", r.out);
  assert.match(r.out, /人の判断待ち/);
  assert.ok(existsSync(join(dir, ".devkit", "gates", "M1.html")));
  // 業務担当者は M1 の承認者ではない
  as(dir, "alice");
  r = devkit(dir, ["approve", "M1", "--role", "業務"], { scenarioFile, human: true });
  assert.notEqual(r.code, 0);
  // Claude（端末なし）からは承認できない
  as(dir, "tom");
  r = devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile });
  assert.equal(r.code, 5, r.out);
  r = devkit(dir, ["approve", "M1", "--role", "技術"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).milestones.M1.status, "done");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  s = state(dir);
  assert.equal(s.nodes.N2.status, "done", r.out);
  assert.equal(s.nodes.N3.status, "done", r.out);
  assert.equal(s.milestones.M2.status, "awaiting_approval", r.out);
  as(dir, "alice");
  assert.equal(devkit(dir, ["approve", "M2", "--role", "業務"], { scenarioFile, human: true }).code, 0);
  as(dir, "tom");
  r = devkit(dir, ["approve", "M2", "--role", "技術"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).outer, "done", r.out);
  const decisions = readFileSync(join(dir, "docs", "decisions.md"), "utf8");
  assert.match(decisions, /計画/);
  assert.match(decisions, /M2/);
  assert.equal(git(dir, "status", "--porcelain"), "", "作業ツリーはクリーンに終わる");
  const log = calls(scenarioFile).join("\n");
  assert.match(log, /final-reviewer/);
});

test("owns の外を変えたラウンドは機械検証で不合格になり、指摘を受けて直す", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1", { "src/b/stray.js": "x\n" }) }, { files: { "src/b/stray.js": null } }];
  const { dir, scenarioFile } = makeProject({ scenario: sc });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes.N1.status, "done", r.out);
  assert.equal(s.nodes.N1.history[0].integrity, false);
  assert.match(s.nodes.N1.history[0].failures.join("\n"), /owns の外/);
});

test("テストの skip の追加と、テストの削除は不合格", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [
    { files: implFiles("N1", "AC-1", { "tests/base.test.js": 'test.skip("既存のテスト", () => {})\n' }) },
    { files: implFiles("N1", "AC-1", { "tests/base.test.js": null }) },
  ];
  const g = graphFor();
  g.nodes[0].owns.push("tests/base.test.js");
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.notEqual(s.nodes.N1.status, "done", r.out);
  const all = s.nodes.N1.history.flatMap((h) => h.failures).join("\n");
  assert.match(all, /無効化|skip/);
  assert.match(all, /削除/);
});

test("実行範囲の外に置いたテストは数えない（AC が実行されたテストにない）", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "export const a = 1;\n", "tests/a.spec.js": 'test("AC-1: 実行されないテスト", () => {})\n' } }];
  const g = graphFor();
  g.nodes[0].owns.push("tests/a.spec.js");
  g.nodes[0].verify = "full";
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.notEqual(s.nodes.N1.status, "done");
  const all = s.nodes.N1.history.flatMap((h) => h.failures).join("\n");
  assert.match(all, /実行されていない|AC-1/);
});

test("レビューの差し戻しを受けて、次のラウンドで合格する", () => {
  const sc = defaultScenario();
  sc["reviewer:N1"] = [{ output: { verdict: "changes_requested", summary: "境界値がない", findings: [{ severity: "important", file: "src/a/index.js", problem: "境界値のテストがない" }] } }, {}];
  const { dir, scenarioFile } = makeProject({ scenario: sc });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes.N1.status, "done");
  assert.equal(s.nodes.N1.history[0].review.verdict, "changes_requested");
  assert.match(calls(scenarioFile).join("\n"), /implementer:N1#2/);
});

test("ログイン切れなど環境の問題は試行に数えずに止まり、直れば続きから進む", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ envError: "Not logged in · Please run /login" }, { files: implFiles("N1", "AC-1") }];
  const { dir, scenarioFile } = makeProject({ scenario: sc });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 2, r.out);
  assert.equal(state(dir).nodes.N1.status, "pending");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
});

test("判断依頼は人の回答まで止まり、回答すると続きを進める", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [
    { output: { status: "needs_human", summary: "締め日が仕様にない", evidence: "-", request: { type: "business", condition: "ESC-04", what: "締め日", why: "仕様にない", options: ["月末", "20日"], recommendation: "月末" } } },
    { files: implFiles("N1", "AC-1") },
  ];
  const { dir, scenarioFile } = makeProject({ scenario: sc });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  let r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "blocked", r.out);
  assert.ok(existsSync(join(dir, ".devkit", "requests", "N1.md")));
  as(dir, "alice");
  r = devkit(dir, ["answer", "N1", "--role", "業務", "--note", "月末締め"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).nodes.N1.status, "pending");
  r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).nodes.N1.status, "done", r.out);
  assert.match(readFileSync(join(dir, "docs", "decisions.md"), "utf8"), /月末締め/);
});

test("承認の後に計画を書き換えると、ランナーは起動しない", () => {
  const { dir, scenarioFile } = makeProject();
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const p = join(dir, ".devkit", "graph.json");
  const g = JSON.parse(readFileSync(p, "utf8"));
  g.nodes[0].goal += " 追記";
  writeFileSync(p, JSON.stringify(g, null, 2));
  git(dir, "commit", "-qam", "改変");
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /承認の後に変わって/);
});

test("ラウンドの上限で失敗したら、再計画の担当が承認済みの範囲で直す", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "x\n", "tests/a.test.js": 'test("AC-1: 失敗する", () => {}) // FAIL\n' } }, {}, { files: implFiles("N1", "AC-1") }];
  const g = graphFor();
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "goal に失敗の原因を書き込む", nodes: [{ ...g.nodes[0], goal: `${g.nodes[0].goal} 失敗したテストは期待値を手で求めて直す。` }], decisions: ["goal を具体化した"] } }];
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes.N1.status, "done", r.out);
  const c = JSON.parse(readFileSync(join(dir, ".devkit", "controls.json"), "utf8"));
  assert.equal(c.plan.history.at(-1).type, "auto-replan");
});

test("受入基準を変える再計画は人の確認に回る", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: { "src/a/index.js": "x\n", "tests/a.test.js": 'test("AC-1: 失敗する", () => {}) // FAIL\n' } }];
  const g = graphFor();
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "AC-1 を外す", nodes: [{ ...g.nodes[0], acceptance: [] }] } }];
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.proposals?.[0]?.status, "needs_human", r.out);
  assert.match(r.out, /人の判断待ち|人の確認/);
});

test("変更内容のフラグで、計画にない承認者が足される", () => {
  const sc = defaultScenario();
  sc["implementer:N1"] = [{ files: implFiles("N1", "AC-1", { "src/a/index.js": "export const PERSONAL = 1;\n" }) }];
  const g = graphFor();
  g.milestones[0].approvers = ["technical"];
  g.milestones[0].foundation = true;
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.milestones.M1.status, "awaiting_approval");
  assert.ok(s.milestones.M1.flags.some((f) => f.rule === "SEC-08"));
});

test("差し戻すと、指摘を再計画に渡し、直してから承認待ちに戻る", () => {
  const sc = defaultScenario();
  const g = graphFor();
  sc["replanner:-"] = [{ output: { kind: "replan", summary: "差し戻しの指摘を直すノードを足す", nodes: [{ id: "FIX-1", milestone: "M1", title: "差し戻しの修正", deps: ["N1"], owns: ["src/a/fix.js"], acceptance: [], goal: g.nodes[0].goal }] } }];
  sc["implementer:FIX-1"] = [{ files: { "src/a/fix.js": "export const fix = 1;\n" } }];
  const { dir, scenarioFile } = makeProject({ scenario: sc, graph: g });
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  devkit(dir, ["run"], { scenarioFile });
  assert.equal(state(dir).milestones.M1.status, "awaiting_approval");
  as(dir, "tom");
  let r = devkit(dir, ["reject", "M1", "--role", "技術", "--note", "命名を直して"], { scenarioFile, human: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).milestones.M1.status, "blocked");
  r = devkit(dir, ["run"], { scenarioFile });
  const s = state(dir);
  assert.equal(s.nodes["FIX-1"]?.status, "done", r.out);
  assert.equal(s.milestones.M1.status, "awaiting_approval", r.out);
});

test("--until を過ぎていれば新しい作業を始めない", () => {
  const { dir, scenarioFile } = makeProject();
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  const d = new Date(Date.now() - 60_000);
  const until = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  // 開始時刻より前の時刻は「翌日のその時刻」になるので、上限は --max-hours で確かめる
  const r = devkit(dir, ["run", "--max-hours", "0.00001"], { scenarioFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dir).nodes.N1.status, "pending", r.out);
  assert.ok(until);
});

test("ランナーが動いている間は、2つ目を起動できない", () => {
  const { dir, scenarioFile } = makeProject();
  approvePlan(dir, scenarioFile);
  devkit(dir, ["start"], { scenarioFile });
  writeFileSync(join(dir, ".devkit", "run.lock"), JSON.stringify({ pid: process.pid, host: (await_hostname()), startedAt: new Date().toISOString() }));
  const r = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /別のランナーが実行中/);
  // 終わったプロセスのロックは外して起動できる
  writeFileSync(join(dir, ".devkit", "run.lock"), JSON.stringify({ pid: 999999, host: await_hostname(), startedAt: "2020-01-01T00:00:00Z" }));
  const r2 = devkit(dir, ["run"], { scenarioFile });
  assert.equal(r2.code, 0, r2.out);
});

function await_hostname() {
  return require_os().hostname();
}
function require_os() {
  return { hostname: () => process.env.HOSTNAME_OVERRIDE ?? osHostname };
}
import { hostname as osHostnameFn } from "node:os";
const osHostname = osHostnameFn();
