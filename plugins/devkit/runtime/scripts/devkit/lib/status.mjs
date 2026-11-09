// ランナーの生存確認（ロックとハートビート）・進捗ログ・状況の要約。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { ROLE_PERSON } from "../shared.mjs";
import { decide, loadControls, loadGraph, loadState, planApproved } from "./model.mjs";
import { readSupervisorState, SUPERVISOR_STOPS } from "./supstate.mjs";
import { localTime, nowIso, readJson, writeJson } from "./util.mjs";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 3 * 60_000;

// ---------- ロック ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function runnerAlive(ctx) {
  const lock = readJson(ctx.lock, null);
  const run = readJson(ctx.runFile, null);
  if (!lock) return { alive: false, run };
  const sameHost = lock.host === hostname();
  const beat = run?.pid === lock.pid ? Date.parse(run.heartbeatAt ?? 0) : 0;
  const fresh = Date.now() - beat < STALE_MS;
  const alive = sameHost ? pidAlive(lock.pid) && (fresh || Date.now() - Date.parse(lock.startedAt) < STALE_MS) : fresh;
  return { alive, lock, run, stale: !alive };
}

// 排他的に作る。古いロック（プロセスがない・ハートビートが途絶えた）は外して取り直す
export function acquireLock(ctx) {
  mkdirSync(ctx.dir, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: nowIso() });
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(ctx.lock, content, { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let lock = null;
      try {
        lock = JSON.parse(readFileSync(ctx.lock, "utf8"));
      } catch {
        // 書きかけのロック: 少し待って読み直す
      }
      const st = lock ? runnerAlive(ctx) : { alive: true };
      if (st.alive && lock) return { busy: lock };
      if (!lock && i === 0) continue;
      // 古いロックを名前を変えてから消す（同時に2つが外そうとしても、改名できるのは1つだけ）
      const aside = `${ctx.lock}.stale-${process.pid}`;
      try {
        renameSync(ctx.lock, aside);
        rmSync(aside, { force: true });
      } catch {}
    }
  }
  return { busy: readJson(ctx.lock, null) ?? { pid: "?" } };
}

export function releaseLock(ctx) {
  const lock = readJson(ctx.lock, null);
  if (lock?.pid === process.pid) rmSync(ctx.lock, { force: true });
}

// ---------- run.json（ハートビート） ----------

export class RunInfo {
  constructor(ctx, base) {
    this.ctx = ctx;
    this.data = { pid: process.pid, host: hostname(), startedAt: nowIso(), heartbeatAt: nowIso(), phase: "準備", cycle: 0, current: {}, lastEvent: "", usage: { costUsd: 0, turns: 0 }, stopReason: null, endedAt: null, ...base };
    this.timer = null;
  }
  start() {
    this.save();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.timer.unref();
  }
  beat() {
    this.data.heartbeatAt = nowIso();
    this.save();
  }
  set(patch) {
    Object.assign(this.data, patch);
    this.beat();
  }
  task(id, info) {
    if (info === null) delete this.data.current[id];
    else this.data.current[id] = { ...info, since: info.since ?? nowIso() };
    this.beat();
  }
  addUsage(costUsd = 0, turns = 0) {
    this.data.usage.costUsd = Math.round(((this.data.usage.costUsd ?? 0) + (costUsd ?? 0)) * 10000) / 10000;
    this.data.usage.turns = (this.data.usage.turns ?? 0) + (turns ?? 0);
  }
  stop(reason) {
    clearInterval(this.timer);
    this.data.stopReason = reason;
    this.data.endedAt = nowIso();
    this.data.phase = "終了";
    this.data.current = {};
    this.save();
  }
  save() {
    try {
      writeJson(this.ctx.runFile, this.data);
    } catch {}
  }
}

// ---------- 進捗ログ ----------

export function appendProgress(ctx, text) {
  mkdirSync(ctx.dir, { recursive: true });
  if (!existsSync(ctx.progress)) writeFileSync(ctx.progress, "# 進捗ログ\n\n");
  appendFileSync(ctx.progress, `- ${localTime(nowIso())} ${String(text).replace(/\r?\n/g, " ")}\n`);
}

// ---------- 状況の要約（status と状況ページ・朝のまとめが共用） ----------

export function computeStatus(ctx) {
  const g = loadGraph(ctx, { required: false });
  const runner = runnerAlive(ctx);
  if (!g) return { hasPlan: false, runner };
  const s = loadState(ctx, g);
  const c = loadControls(ctx);
  const d = decide(g, s, c);
  const plan = planApproved(ctx, c);
  const nodes = g.nodes.map((n) => ({ id: n.id, title: n.title, milestone: n.milestone, ...pick(s.nodes[n.id]) }));
  const milestones = g.milestones.map((m) => ({ id: m.id, title: m.title, release: m.release, ...s.milestones[m.id] }));
  const counts = Object.fromEntries(["pending", "running", "ready_to_merge", "done", "failed", "blocked"].map((k) => [k, nodes.filter((n) => n.status === k).length]));
  const waitingFor = [];
  for (const a of d.waiting.approvals) for (const r of a.roles) waitingFor.push({ role: r, what: a.kind === "before" ? `${a.target} の着手前の承認` : `${a.target} の承認`, command: `pnpm devkit approve ${a.target}${a.kind === "before" ? " --before" : ""} --role ${r}` });
  for (const a of d.waiting.answers)
    waitingFor.push({ role: a.role, what: `${a.node} の判断依頼 ${a.request} への回答（.devkit/requests/${a.node}.md）`, command: `pnpm devkit answer ${a.node} --role ${a.role} --request ${a.request} --note "<回答>"` });
  for (const p of d.waiting.proposals)
    for (const r of p.roles ?? ["technical"]) waitingFor.push({ role: r, what: `再計画の案 ${p.id} の確認（.devkit/proposals/${p.id}.json）`, command: `pnpm devkit proposal accept ${p.id} --role ${r}` });
  if (!plan.ok) for (const r of plan.pending) waitingFor.push({ role: r, what: "計画（仕様書・graph）の承認", command: `pnpm devkit approve plan --role ${r}` });
  let whoseTurn;
  if (runner.alive) whoseTurn = "AI";
  else if (s.outer === "done") whoseTurn = "人（最終レビュー・リリース判断）";
  else if (waitingFor.length) whoseTurn = [...new Set(waitingFor.map((w) => ROLE_PERSON[w.role]))].join("・");
  else if (s.outer === "stalled" || s.outer === "paused") whoseTurn = `${ROLE_PERSON.technical}（停止の理由を確かめて再開）`;
  else if (s.outer === "running") whoseTurn = "AI（ランナーの起動待ち: pnpm devkit run）";
  else whoseTurn = "AI（計画の作成中）";
  const sv = readSupervisorState(ctx);
  const supervisor = { alive: Boolean(sv.heartbeatAt) && Date.now() - Date.parse(sv.heartbeatAt) < 5 * 60_000, status: sv.status, reason: sv.reason, retry: sv.current, stopped: SUPERVISOR_STOPS.includes(sv.status), briefing: sv.briefing?.file ?? null };
  if (supervisor.stopped && !waitingFor.length) whoseTurn = `${ROLE_PERSON.technical}（Supervisor の停止の理由を確かめて pnpm devkit supervisor clear）`;
  return { hasPlan: true, mission: g.mission, outer: s.outer, reason: s.reason, cycle: s.cycle, plan, runner, supervisor, counts, nodes, milestones, current: d.current, ready: d.ready.map((n) => n.id), waitingFor, whoseTurn, usage: s.usage, updatedAt: s.updatedAt };
}

function pick(ns = {}) {
  const { status = "pending", attempts = 0, round = 0, note = "", request = null, branch = null } = ns;
  return { status, attempts, round, note, request: request ? { id: request.id ?? null, type: request.type, condition: request.condition, what: request.what } : null, branch };
}

const STATUS_JA = { pending: "未着手", running: "実行中", ready_to_merge: "統合待ち", done: "完了", failed: "要再計画", blocked: "停止" };
const MS_JA = { pending: "未着手", active: "進行中", verifying: "全体検証中", awaiting_approval: "承認待ち", done: "完了", blocked: "要再計画" };
const OUTER_JA = { idle: "計画中（未開始）", running: "進行中", paused: "一時停止", stalled: "停止（進捗なし）", done: "完了" };

export function statusText(st) {
  if (!st.hasPlan) return "計画はまだありません（devkit-kickoff スキルで作ります）。";
  const lines = [];
  const r = st.runner;
  if (r.alive) {
    const run = r.run ?? {};
    const ago = run.heartbeatAt ? Math.round((Date.now() - Date.parse(run.heartbeatAt)) / 60000) : "?";
    lines.push(`ランナー: 実行中（${run.phase ?? ""}、サイクル ${run.cycle ?? st.cycle}、最終応答 ${ago}分前、開始 ${localTime(run.startedAt)}、費用 $${(run.usage?.costUsd ?? 0).toFixed(2)}）`);
    const cur = Object.entries(run.current ?? {});
    if (cur.length) lines.push(`実行中: ${cur.map(([id, t]) => `${id}（${t.step ?? ""}${t.round ? ` ラウンド${t.round}` : ""}）`).join("、")}`);
  } else if (r.lock) {
    lines.push(`ランナー: 停止（応答なし。最終応答 ${localTime(r.run?.heartbeatAt)}）。pnpm devkit run で再開すると、中断した作業を照合してから続ける`);
  } else if (r.run?.endedAt) {
    lines.push(`ランナー: 停止中（前回 ${localTime(r.run.endedAt)} に終了: ${r.run.stopReason ?? ""}）`);
  } else lines.push("ランナー: 停止中");
  const sv = st.supervisor;
  if (sv && (sv.alive || sv.status !== "stopped"))
    lines.push(`Supervisor: ${sv.alive ? "動いている" : "動いていない"}（${sv.status}${sv.reason ? `: ${sv.reason}` : ""}）${sv.retry?.nextAt ? `／次の再試行 ${localTime(sv.retry.nextAt)}` : ""}${sv.briefing ? `／最後のブリーフィング ${sv.briefing}` : ""}`);
  lines.push(`ミッション: ${st.mission} ／ 状態: ${OUTER_JA[st.outer] ?? st.outer}${st.reason ? `（${st.reason}）` : ""}`);
  lines.push(`ノード: 完了 ${st.counts.done} / 全 ${st.nodes.length}${st.counts.failed + st.counts.blocked ? `、停止・要再計画 ${st.counts.failed + st.counts.blocked}` : ""}`);
  lines.push(`マイルストーン: ${st.milestones.map((m) => `${m.id}${m.release ? "（リリース）" : ""} ${MS_JA[m.status] ?? m.status}`).join(" → ")}`);
  if (st.waitingFor.length) {
    lines.push("人の判断待ち:");
    for (const w of st.waitingFor) lines.push(`  - ${ROLE_PERSON[w.role]}: ${w.what} → 端末で \`${w.command}\``);
  }
  lines.push(`誰の番か: ${st.whoseTurn}`);
  return lines.join("\n");
}

export { MS_JA, OUTER_JA, STATUS_JA };
