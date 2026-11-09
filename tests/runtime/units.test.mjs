// 部品ごとの確かめ（プロセスの時間切れ・安全な読み取り・承認・環境の問題の判定・コンテナの引数・テストの弱体化）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyEnvError } from "../../plugins/devkit/runtime/scripts/devkit/lib/agents.mjs";
import { containerRunArgs, ISOLATION_DEFAULTS, runProcess, safeRead } from "../../plugins/devkit/runtime/scripts/devkit/lib/isolation.mjs";
import { configProblems, isApproved, loadConfig, pendingRoles, proposalRoles, reopenLater } from "../../plugins/devkit/runtime/scripts/devkit/lib/model.mjs";
import { parseRunLimits } from "../../plugins/devkit/runtime/scripts/devkit/lib/runner.mjs";
import { readReports } from "../../plugins/devkit/runtime/scripts/devkit/lib/verify.mjs";
import { weakeningOf } from "../../plugins/devkit/runtime/scripts/devkit/shared.mjs";

test("マイルストーンの承認は、検証したコミットに紐づいたものだけを数える（sha のない承認は数えない）", () => {
  const c = { approvals: { M1: { technical: { by: "x" }, business: { sha: "abc", by: "y" } } } };
  assert.equal(isApproved(c, "M1", ["technical"], { sha: "abc" }), false);
  assert.equal(isApproved(c, "M1", ["business"], { sha: "abc" }), true);
  assert.equal(isApproved(c, "M1", ["business"], { sha: "def" }), false);
  assert.deepEqual(pendingRoles(c, "M1", ["business", "technical"], { sha: "abc" }), ["technical"]);
  // 着手前の承認（sha なし）は役割だけを見る
  assert.equal(isApproved({ approvals: { "N1:before": { business: { by: "y" } } } }, "N1:before", ["business"]), true);
});

test("時間切れでは、SIGTERM を無視する子と、出力を握った孫がいても戻る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-proc-"));
  const script = join(dir, "stubborn.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: true });
setInterval(() => {}, 1000);`,
  );
  const t0 = Date.now();
  const r = await runProcess(process.execPath, [script], { cwd: dir, env: process.env, timeoutMs: 1000 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  assert.ok(took < 15_000, `戻るまで ${took}ms`);
});

test("取り出したフォルダの結果は、リンクやフォルダの外を指すものを読まない", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "devkit-secret-"));
  writeFileSync(join(outside, "id_rsa"), "-----BEGIN KEY-----");
  mkdirSync(join(dir, "test-reports"), { recursive: true });
  symlinkSync(join(outside, "id_rsa"), join(dir, "test-reports", "vitest.json"));
  assert.equal(safeRead(dir, "test-reports/vitest.json"), null);
  const d2 = mkdtempSync(join(tmpdir(), "devkit-safe2-"));
  symlinkSync(outside, join(d2, "test-reports"));
  writeFileSync(join(outside, "e2e.json"), "{}");
  assert.equal(safeRead(d2, "test-reports/e2e.json"), null);
  writeFileSync(join(dir, "ok.json"), "{}");
  assert.equal(safeRead(dir, "ok.json").toString(), "{}");
});

test("コンテナの中のパス（/work/...）で書かれた結果を、取り出したフォルダからの相対パスで読む", () => {
  const dir = mkdtempSync(join(tmpdir(), "devkit-rep-"));
  mkdirSync(join(dir, "test-reports"), { recursive: true });
  writeFileSync(join(dir, "test-reports", "vitest.json"), JSON.stringify({ testResults: [{ name: "/work/tests/a.test.ts", assertionResults: [{ fullName: "AC-1: a", status: "passed" }] }] }));
  writeFileSync(join(dir, "test-reports", "e2e.json"), JSON.stringify({ config: { rootDir: "/work/e2e" }, suites: [{ title: "x.spec.ts", file: "x.spec.ts", specs: [{ title: "AC-2: b", ok: true, tests: [{ status: "expected" }] }] }] }));
  const r = readReports(dir, { inner: "/work" });
  assert.deepEqual([...r.files.unit], ["tests/a.test.ts"]);
  assert.deepEqual([...r.files.e2e], ["e2e/x.spec.ts"]);
  assert.equal(r.tests.filter((t) => t.passed).length, 2);
});

test("環境の問題は claude 自身の出力だけで判定する", () => {
  const ok = { is_error: false, num_turns: 5, result: "quota と rate limit reached を表示する機能を作った" };
  assert.equal(classifyEnvError({ result: ok, stderr: "", timedOut: false }), null);
  assert.equal(classifyEnvError({ result: ok, stderr: "warning: rate limit reached, retrying", timedOut: false }), null);
  assert.ok(classifyEnvError({ result: { is_error: true, num_turns: 3, result: "Credit balance is too low" }, stderr: "", timedOut: false }));
  assert.ok(classifyEnvError({ result: null, stderr: "Not logged in", timedOut: false }));
  assert.ok(classifyEnvError({ result: { is_error: true, num_turns: 0 }, stderr: "", timedOut: false }));
  assert.equal(classifyEnvError({ result: { is_error: true, num_turns: 8, subtype: "error_max_turns" }, stderr: "", timedOut: false }), null);
  assert.equal(classifyEnvError({ result: null, stderr: "", timedOut: true }), null);
});

test("停止条件の値の確かめ", () => {
  assert.deepEqual(parseRunLimits({ until: "07:00" }).until, { h: 7, m: 0, text: "07:00" });
  assert.equal(parseRunLimits({ maxHours: "1.5" }).maxHours, 1.5);
  for (const bad of [{ until: "7時" }, { until: "25:00" }, { until: "07-00" }, { maxHours: "abc" }, { maxHours: "0" }, { maxCostUsd: "-1" }, { maxCostUsd: true }]) {
    assert.throws(() => parseRunLimits(bad), /指定/, JSON.stringify(bad));
  }
});

test("コンテナの引数: 検証の段階はネットワークなし・プロキシも渡さない、インストールの段階だけキャッシュに書ける", () => {
  const iso = { ...ISOLATION_DEFAULTS, engine: "docker" };
  const info = { ok: true, podman: false, rootless: false };
  process.env.HTTPS_PROXY ??= "http://127.0.0.1:1";
  const base = { iso, info, name: "n", project: "p", image: "img", dir: "/w", cache: "/c", command: "pnpm verify" };
  const v = containerRunArgs({ ...base, phase: "verify" }).args;
  const i = containerRunArgs({ ...base, phase: "install" }).args;
  assert.equal(v[v.indexOf("--network") + 1], "none");
  assert.ok(v.includes("/c/tools:/cache/tools:ro"));
  assert.ok(!v.includes("/c:/cache"));
  assert.ok(!v.some((a) => /^HTTPS?_PROXY=/i.test(a)));
  assert.ok(v.includes("--read-only") && v.includes("ALL") && v.includes("no-new-privileges"));
  assert.equal(i[i.indexOf("--network") + 1], "bridge");
  assert.ok(i.includes("/c:/cache"));
  assert.ok(i.some((a) => /^HTTPS_PROXY=/.test(a)));
  const podman = containerRunArgs({ ...base, phase: "verify", info: { ok: true, podman: true } }).args;
  assert.ok(podman.includes("--userns=keep-id"));
});

test("設定の確かめ: 検証の段階の隔離を広げる引数は受け付けない", () => {
  const ctx = { config: "/nonexistent/config.json" };
  const cfg = loadConfig(ctx);
  assert.deepEqual(configProblems(cfg), []);
  cfg.isolation.verifyArgs = ["--network", "host"];
  assert.ok(configProblems(cfg).some((p) => /広げる/.test(p)));
  cfg.isolation.verifyArgs = ["-v", "/:/host"];
  assert.ok(configProblems(cfg).length);
  assert.ok(configProblems({ ...loadConfig(ctx), permissionMode: "bypassPermissions" }).length);
  assert.ok(configProblems({ ...loadConfig(ctx), aiSandbox: "maybe" }).length);
});

test("テストの弱体化の判定（別名・角括弧・関数の別名・減少）", () => {
  const before = 'it("AC-1", () => { expect(1).toBe(1); expect(2).toBe(2) })\n';
  assert.ok(weakeningOf(before, before.replace("it(", "it.skip(")).length);
  assert.ok(weakeningOf(before, before.replace("it(", 'it["only"](')).length);
  assert.ok(weakeningOf(before, `const t = it;\n${before.replace("it(", "t(")}`).length);
  assert.ok(weakeningOf(before, before.replace("expect(2).toBe(2)", "")).length);
  assert.ok(weakeningOf(before, before.replace("it(", "test.fails(")).length);
  assert.ok(weakeningOf(before, `// @ts-nocheck\n${before}`).length);
  assert.deepEqual(weakeningOf(before, `${before}it("AC-2", () => { expect(3).toBe(3) })\n`), []);
});

test("前のマイルストーンが開き直ったら、後ろの検証済み・承認済みはやり直し", () => {
  const g = { milestones: [{ id: "M1" }, { id: "M2" }, { id: "M3" }] };
  const s = { milestones: { M1: { status: "blocked" }, M2: { status: "done" }, M3: { status: "awaiting_approval" } } };
  const notes = reopenLater(g, s, "M1", "差し戻し");
  assert.equal(s.milestones.M2.status, "active");
  assert.equal(s.milestones.M3.status, "active");
  assert.equal(notes.length, 2);
});

test("再計画の案の承認者: マイルストーン・受入基準に及ぶなら業務担当者も", () => {
  assert.deepEqual(proposalRoles(["ノード N1 のテスト削除の許可を変える"]), ["technical"]);
  assert.deepEqual(proposalRoles(["ノード N2 のマイルストーンを変える"]), ["business", "technical"]);
  assert.deepEqual(proposalRoles(["受入基準（AC・BR）の集合が変わる"]), ["business", "technical"]);
});
