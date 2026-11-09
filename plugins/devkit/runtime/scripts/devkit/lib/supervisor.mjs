// Supervisor: 既存のランナーの外側で、起動・待機・再試行と、定時ブリーフィングを管理する（単一ホスト・単一案件）。
//   - 実装の判断・検証・人の決定の反映はランナーのまま。Supervisor は「今ランナーを1つ起動してよいか」だけを決める
//   - 人の判断（既存の CLI。役割・対象・版はコマンドと状態への反映の両方で確かめ済み）を、ファイルの変更の通知と定期の照合で検知し、
//     判断を入れた状態で実行できる作業があるときだけ起動する（起動の直前にも確かめ直す）
//   - ランナーの終了の理由を分類する: 一時的な障害は待って再試行（回数・期限つき）、利用上限は復帰時刻まで待つ、
//     認証・環境の問題は報告して止まる、改ざん（保護された記録の不整合）はすぐ止めて知らせる
//   - 試行回数・日ごとの起動回数と使用量は手元の記録（.devkit/cache/supervisor/state.json）に残し、再起動で数え直さない
//   - 上限停止・環境の停止・方針違反・手動停止は、人が supervisor clear で解除するまで自動では解除しない
//   - API の課金に切り替わる設定（ANTHROPIC_API_KEY など）は、明示しない限りランナーに渡さない。利用上限では待つだけ
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_PERSON } from "../shared.mjs";
import { flushOutbox, hasWork, produceBriefing, simulate, workOf } from "./briefing.mjs";
import { dayKey, deadlineAtOrBefore, insideHours, nextDeadline, now, parseHHMM, validTimeZone, zonedParts, zonedToDate } from "./clock.mjs";
import { appendEvent, readEvents } from "./events.mjs";
import { configProblems, loadConfig, loadControls, loadGraph, loadState, planApproved } from "./model.mjs";
import { notify } from "./notify.mjs";
import { committedUnexplained, journalProblem, uncommittedUnexplained } from "./seal.mjs";
import { runnerAlive } from "./status.mjs";
import { readSupervisorState, SUPERVISOR_STOPS, supervisorPaths, writeSupervisorState } from "./supstate.mjs";
import { localStamp, readJson, sha256, writeText } from "./util.mjs";

const DEVKIT = fileURLToPath(new URL("../devkit.mjs", import.meta.url));
const RUNNER_EXIT = { ok: 0, preflight: 1, env: 2, stalled: 3, busy: 4, tamper: 5 };

// API の課金に切り替わる設定（Supervisor が起動するランナーには、allowApiKey でなければ渡さない）
const BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY"];

// ---------- 終了の理由の分類 ----------

const AUTH = /not logged in|please run \/login|\/login to|invalid api key|authentication[_ ]error|\b401\b|unauthorized|oauth token (has )?expired|has not been trusted/i;
const RATE = /usage limit|rate[ _-]?limit|limit reached|hit your limit|exceeded your (current )?quota|credit balance is too low|\b429\b/i;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|timed? ?out|overloaded|(?:API Error|status(?: code)?|HTTP)[:\s]*5\d\d\b|\b5\d\d (?:Internal|Bad Gateway|Service Unavailable|Gateway Timeout)|internal server error|bad gateway|service unavailable|connection (error|reset|closed|refused)|claude が結果を返さずに終了した|claude を起動できない/i;

// 利用上限の復帰時刻（分からなければ null）。例: "limit reached|1762700000"・"resets 3am (Asia/Tokyo)"・"retry after 120 seconds"
export function parseResetAt(text, at = now(), defaultTz = "Asia/Tokyo") {
  const t = String(text ?? "");
  let m = t.match(/\|(\d{10})(?:\D|$)/);
  if (m) return new Date(Number(m[1]) * 1000);
  m = t.match(/retry[- ]after[:\s]+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)?/i);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? "s")[0].toLowerCase();
    return new Date(at.getTime() + n * (unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000));
  }
  m = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (!m[3]) h = Number(m[1]) % 24;
    else if (m[3].toLowerCase() === "pm") h += 12;
    const mi = Number(m[2] ?? 0);
    const tz = m[4] && validTimeZone(m[4]) ? m[4] : defaultTz;
    const p = zonedParts(at, tz);
    for (let add = 0; add < 3; add++) {
      const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
      const cand = zonedToDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
      if (cand.getTime() > at.getTime()) return cand;
    }
  }
  return null;
}

// ランナーの終了コードと理由から、次にどうするかの分類
export function classifyExit(code, reason = "") {
  if (code === RUNNER_EXIT.ok) return { kind: "ok" };
  if (code === RUNNER_EXIT.busy) return { kind: "busy" };
  if (code === RUNNER_EXIT.stalled) return { kind: "stalled" };
  if (code === RUNNER_EXIT.tamper || /保護されたファイル|devkit のコマンドとランナーが書いたものではない/.test(reason)) return { kind: "tamper" };
  if (AUTH.test(reason)) return { kind: "auth" };
  if (RATE.test(reason) && !/overloaded/i.test(reason)) return { kind: "rate_limit" };
  if (code === RUNNER_EXIT.env && TRANSIENT.test(reason)) return { kind: "transient" };
  if (code === null || code === undefined || code > 5 || code < 0) return { kind: "transient" }; // 落ちた（シグナルなど）
  return { kind: "environment" };
}

const KIND_JA = { transient: "一時的な障害", rate_limit: "利用上限", auth: "認証", environment: "環境の問題", tamper: "保護された記録の不整合", stalled: "進捗なし" };

// ---------- 状態の要約（同じなら進捗なし） ----------

function progressKey(ctx) {
  try {
    const g = loadGraph(ctx, { required: false });
    if (!g) return "none";
    const s = loadState(ctx, g);
    // コミット（HEAD）は含めない（ランナーは何もしなくても、終わるときに記録をコミットするため）
    return sha256(
      JSON.stringify({
        n: g.nodes.map((n) => [n.id, s.nodes[n.id]?.status, s.nodes[n.id]?.attempts, s.nodes[n.id]?.roundsDone]),
        m: g.milestones.map((m) => [m.id, s.milestones[m.id]?.status, s.milestones[m.id]?.head]),
        p: (s.proposals ?? []).map((p) => [p.id, p.status]),
      }),
    ).slice(0, 16);
  } catch {
    return "unreadable";
  }
}

// ---------- ロック ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock(ctx) {
  try {
    return JSON.parse(readFileSync(supervisorPaths(ctx).lock, "utf8"));
  } catch {
    return null; // ない・書きかけ・壊れている
  }
}

// 生きているか: 同じ機械ならプロセスがあり、かつ最近の応答（heartbeat）があること（再起動の後の pid の使い回しで止まらない）
export function supervisorAlive(ctx) {
  const lock = readLock(ctx);
  if (!lock) return { alive: false };
  let st = null;
  try {
    st = readSupervisorState(ctx);
  } catch {}
  const beat = Math.max(Date.parse(st?.heartbeatAt ?? 0) || 0, Date.parse(lock.startedAt ?? 0) || 0);
  const fresh = Date.now() - beat < 10 * 60_000;
  if (lock.host !== hostname()) return { alive: fresh, lock };
  return { alive: pidAlive(lock.pid) && fresh, lock };
}

function acquire(ctx) {
  const { dir, lock } = supervisorPaths(ctx);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: now().toISOString() }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 書きかけのロック（別のプロセスが書いている途中か、作った直後に落ちた）: 1秒待っても読めなければ、古いものとして外す
      if (!readLock(ctx)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      const a = supervisorAlive(ctx);
      if (a.alive && a.lock?.pid !== process.pid) return { busy: a.lock };
      rmSync(lock, { force: true });
    }
  }
  return { busy: readLock(ctx) ?? { pid: "?" } };
}

function release(ctx) {
  const { lock } = supervisorPaths(ctx);
  if (readLock(ctx)?.pid === process.pid) rmSync(lock, { force: true });
}

// ---------- Supervisor ----------

export class Supervisor {
  constructor(ctx, { once = false, log = (t) => console.log(`[devkit supervisor] ${t}`) } = {}) {
    this.ctx = ctx;
    this.once = once;
    this.say = log;
    this.child = null;
    this.stopping = false;
    this.wake = null;
  }

  load() {
    this.config = loadConfig(this.ctx);
    this.st = readSupervisorState(this.ctx);
    // 日ごとの上限の数え直し（日が変わったら。読み直すたびに当てるので、数え直しが失われない）
    const dk = dayKey(now(), this.config.briefing.timeZone);
    if (this.st.day?.key !== dk) this.st.day = { key: dk, runs: 0, costStart: this.totalCost() };
  }

  save() {
    Object.assign(this.st, { pid: process.pid, host: hostname(), heartbeatAt: now().toISOString() });
    writeSupervisorState(this.ctx, this.st);
  }

  // 状態を変える（変わったときだけ記録・通知する）
  async set(status, reason, { notifyRole = null } = {}) {
    const changed = this.st.status !== status || this.st.reason !== reason;
    this.st.status = status;
    this.st.reason = reason;
    if (changed) {
      this.st.since = now().toISOString();
      this.say(`${status}: ${reason}`);
      appendEvent(this.ctx, "supervisor_state", { status, reason: String(reason).slice(0, 500) });
      if (notifyRole) await notify({ role: notifyRole, project: this.projectTitle(), message: `Supervisor が止まりました（${status}）: ${reason}。確かめて直したら、標準オーナーが端末で pnpm devkit supervisor clear --role 技術 --note "…"` });
    }
    this.save();
  }

  projectTitle() {
    try {
      return loadGraph(this.ctx, { required: false })?.mission ?? "";
    } catch {
      return "";
    }
  }

  // 1回の照合。起動したら、once のときは終わるまで待つ
  async tick() {
    this.load();
    const { ctx } = this;
    const at = now();
    // 人の操作（controls.json の supervisor）: 手動停止と、停止の解除
    const cs = loadControls(ctx).supervisor ?? {};
    if (cs.clear?.at && (!this.st.clearedAt || Date.parse(cs.clear.at) > Date.parse(this.st.clearedAt))) {
      this.st.clearedAt = cs.clear.at;
      if (SUPERVISOR_STOPS.includes(this.st.status)) {
        this.st.failures = {};
        this.st.current = null;
        this.st.noProgress = 0;
        if (this.st.day) this.st.day.runs = 0;
        await this.set("watching", `人が停止を解除した（${cs.clear.by ?? ""}）`);
      }
    }
    if (cs.stop && this.st.status !== "manual_stop") await this.set("manual_stop", manualReason(cs.stop));
    // 定時ブリーフィング（ランナーの生死とは関係なく作る）
    await this.briefingStep(at).catch((e) => this.say(`ブリーフィングを作れませんでした: ${e.message}`));
    if (this.child) return this.save();
    await this.reconcileLostChild();
    if (SUPERVISOR_STOPS.includes(this.st.status)) return this.save();
    const ev = this.evaluate(at);
    if (!ev.start) return this.apply(ev);
    // 起動の直前にもう一度確かめる（ブリーフィングの配信などで待った間の、人の停止・ほかのランナー・判断の取り消し）。
    // ここから起動（spawn）までは待ちを挟まない
    this.load();
    const again = this.evaluate(now());
    if (!again.start) return this.apply(again);
    await this.launch(again.reason);
  }

  apply(ev) {
    if (ev.stop) return this.set(ev.stop, ev.reason, { notifyRole: ev.stop === "manual_stop" ? null : "technical" });
    return this.set(ev.status, ev.reason);
  }

  totalCost() {
    try {
      const g = loadGraph(this.ctx, { required: false });
      return g ? (loadState(this.ctx, g).usage?.costUsd ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  // 前の Supervisor が起動したランナーが、終了の記録なしにいなくなっていたら、落ちたものとして扱う（再試行の対象）
  async reconcileLostChild() {
    const c = this.st.child;
    if (!c) return;
    if (pidAlive(c.pid) && runnerAlive(this.ctx).alive) return;
    const ended = readEvents(this.ctx, { since: Date.parse(c.startedAt) - 1000 }).events.find((e) => (e.type === "run_ended" || e.type === "run_refused") && e.pid === c.pid);
    this.st.child = null;
    if (!ended) {
      appendEvent(this.ctx, "supervisor_runner_lost", { pid: c.pid, startedAt: c.startedAt });
      await this.afterExit({ code: null, reason: "ランナーが終了の記録なしにいなくなった（落ちた可能性）", before: c.before });
    } else await this.afterExit({ code: ended.code, reason: ended.reason ?? "", before: c.before }); // 前の Supervisor が見届けられなかった終わり方も、同じに扱う
  }

  // 今ランナーを起動してよいか。{ start, status, reason } か { stop, reason }
  evaluate(at) {
    const { ctx, config } = this;
    const sv = config.supervisor;
    // 止まった状態と、人の手動停止（読み直した最新のもの）
    const fresh = readSupervisorState(ctx);
    if (SUPERVISOR_STOPS.includes(fresh.status)) return { start: false, status: fresh.status, reason: fresh.reason };
    const c = loadControls(ctx);
    if (c.supervisor?.stop) return { stop: "manual_stop", reason: manualReason(c.supervisor.stop) };
    const g = loadGraph(ctx, { required: false });
    if (!g) return { start: false, status: "idle", reason: "計画がまだない" };
    const s = loadState(ctx, g);
    if (runnerAlive(ctx).alive) return { start: false, status: "running", reason: "ランナーが実行中" };
    if (s.outer === "done") return { start: false, status: "done", reason: "ミッション完了" };
    if (s.outer === "idle") return { start: false, status: "idle", reason: "まだ開始していない（pnpm devkit start）" };
    if (s.outer === "paused") return { start: false, status: "waiting_human", reason: `一時停止中（${s.reason}）。再開は pnpm devkit resume` };
    if (s.outer === "stalled") return { start: false, status: "waiting_human", reason: `ランナーが止まった（${s.reason}）。標準オーナーが理由を確かめて pnpm devkit resume` };
    const plan = planApproved(ctx, c);
    if (!plan.ok) return { start: false, status: "waiting_human", reason: `計画の承認待ち（${plan.pending.map((r) => ROLE_PERSON[r]).join("・")}）` };
    const prev = readJson(ctx.runFile, null);
    const jp = journalProblem(ctx);
    const bad = [...new Set([...(jp ? [".devkit/journal.jsonl"] : []), ...committedUnexplained(ctx, prev), ...uncommittedUnexplained(ctx, prev)])];
    if (bad.length) {
      if (!this.dryRun) this.saveEvidence(bad);
      return { stop: "policy_stop", reason: `devkit のコマンドとランナーが書いたものと合わない記録がある: ${bad.join(", ")}${jp ? `（${jp}）` : ""}（自動では再試行しない）` };
    }
    if (this.st.current?.nextAt && Date.parse(this.st.current.nextAt) > at.getTime())
      return { start: false, status: "retry_wait", reason: `${KIND_JA[this.st.current.kind] ?? this.st.current.kind}のため ${this.st.current.nextAt} まで待つ（${this.st.current.attempt} 回目）` };
    if (!insideHours(at, sv.hours, config.briefing.timeZone)) return { start: false, status: "outside_hours", reason: `自動で起動する時間帯（${sv.hours}）の外` };
    if ((this.st.day?.runs ?? 0) >= sv.limits.maxRunsPerDay) return { stop: "limit_stop", reason: `今日の自動起動の上限（${sv.limits.maxRunsPerDay} 回）に達した` };
    if (sv.limits.maxCostUsdPerDay && this.totalCost() - (this.st.day?.costStart ?? 0) >= sv.limits.maxCostUsdPerDay)
      return { stop: "limit_stop", reason: `今日の使用量の上限（API 換算 $${sv.limits.maxCostUsdPerDay}）に達した` };
    if ((this.st.noProgress ?? 0) >= sv.limits.maxNoProgressRuns) return { stop: "limit_stop", reason: `${this.st.noProgress} 回続けて、起動しても状態が進まなかった` };
    // 人の決定を入れた状態で、ランナーが実行できる作業があるか（誤った役割・古い版の判断は反映されないので、作業は増えない）
    const d = simulate(g, s, c);
    const w = workOf(d);
    if (!hasWork(w)) {
      const who = [...new Set([...d.waiting.approvals.flatMap((a) => a.roles), ...d.waiting.answers.map((a) => a.role), ...d.waiting.proposals.flatMap((p) => p.roles ?? ["technical"])])];
      return { start: false, status: "waiting_human", reason: who.length ? `人の判断待ち（${who.map((r) => ROLE_PERSON[r]).join("・")}）` : "実行できる作業も判断待ちもない" };
    }
    const what = [w.ready.length ? `作業 ${w.ready.join("・")}` : "", w.merge.length ? `統合 ${w.merge.join("・")}` : "", w.verify ? `${w.verify} の全体検証` : "", w.replan.length ? "再計画" : "", w.allDone ? "完了の確認" : ""].filter(Boolean).join("・");
    return { start: true, status: "running", reason: what };
  }

  saveEvidence(files) {
    if (this.st.status === "policy_stop") return;
    const file = join(this.ctx.reports, `supervisor-integrity-${localStamp()}.md`);
    writeText(file, [`# 記録の不整合を見つけたので、Supervisor は自動の起動を止めました`, "", `- 時刻: ${now().toISOString()}`, `- 合わない記録: ${files.join(", ")}`, "", "`git log -p -- <ファイル>` で変更を確かめ、改ざんなら戻す。正しい内容なら、標準オーナーが `pnpm devkit seal accept --role 技術 --note \"…\"` を実行し、`pnpm devkit supervisor clear --role 技術 --note \"…\"` で解除する。", ""].join("\n"));
  }

  async launch(what) {
    const { ctx, config } = this;
    const sv = config.supervisor;
    const args = [DEVKIT, "run", "--max-parallel", String(sv.maxParallel)];
    // 時間帯の終わりは、ブリーフィングのタイムゾーンで求めた時刻（ISO）で渡す（機械のタイムゾーンに左右されない）
    if (sv.hours) args.push("--until", endOfHours(now(), sv.hours, config.briefing.timeZone).toISOString());
    // 今日の使用量の上限は、残りをこの実行の上限として渡す（実行の途中でも超えない）
    if (sv.limits.maxCostUsdPerDay) {
      const left = Math.max(0.01, Math.round((sv.limits.maxCostUsdPerDay - (this.totalCost() - (this.st.day?.costStart ?? 0))) * 100) / 100);
      args.push("--max-cost-usd", String(left));
    }
    const env = { ...process.env, DEVKIT_SUPERVISOR: "1" };
    for (const k of Object.keys(env)) if (k === "DEVKIT_ROLE" || k === "DEVKIT_RUNNER") delete env[k];
    const removed = [];
    if (!sv.allowApiKey)
      for (const k of BILLING_ENV)
        if (env[k]) {
          delete env[k];
          removed.push(k);
        }
    if (removed.length) this.say(`API の課金に切り替わる設定をランナーに渡しません: ${removed.join(", ")}（使うなら .devkit/config.json の supervisor.allowApiKey）`);
    mkdirSync(ctx.logs, { recursive: true });
    const logFile = join(ctx.logs, `supervisor-run-${localStamp()}.log`);
    const fd = openSync(logFile, "a");
    const before = progressKey(ctx);
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: ctx.root, env, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd); // 子のプロセスが自分の分を持つ。ここで閉じないと、常駐している間に増え続ける
    }
    this.child = child;
    this.st.child = { pid: child.pid, startedAt: now().toISOString(), before, log: logFile };
    this.st.day.runs = (this.st.day?.runs ?? 0) + 1;
    appendEvent(ctx, "supervisor_launch", { pid: child.pid, what, attempt: this.st.current?.attempt ?? 0 });
    await this.set("running", `ランナーを起動した（${what}）`);
    const done = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? null : 1), signal }));
      child.on("error", (e) => resolve({ code: null, signal: null, error: e.message }));
    });
    const finish = done.then(({ code }) => {
      this.child = null;
      const startedAt = this.st.child?.startedAt;
      const ended = readEvents(ctx, { since: Date.parse(startedAt ?? 0) - 1000 }).events.filter((e) => (e.type === "run_ended" || e.type === "run_refused") && e.pid === child.pid).at(-1);
      let reason = ended?.reason ?? "";
      if (!reason) {
        try {
          reason = readFileSync(logFile, "utf8").trim().split("\n").slice(-3).join(" ");
        } catch {}
      }
      this.load();
      this.st.child = null;
      return this.afterExit({ code, reason, before });
    });
    if (this.once) await finish;
    else finish.catch((e) => this.say(`ランナーの終了の処理で失敗: ${e.message}`)).finally(() => this.kick());
  }

  // ランナーの終了を受けて、次にどうするか
  async afterExit({ code, reason, before }) {
    const { ctx, config } = this;
    const r = config.supervisor.retry;
    const cls = classifyExit(code, reason);
    const at = now();
    appendEvent(ctx, "supervisor_runner_exit", { code, kind: cls.kind, reason: String(reason).slice(0, 500) });
    // 実行中に人が止めた（手動停止）など、止まった状態はランナーの終了で上書きしない（記録の不整合だけは、より重い停止として上書きする）
    const held = SUPERVISOR_STOPS.includes(this.st.status) ? this.st.status : (loadControls(ctx).supervisor?.stop ? "manual_stop" : null);
    if (held) {
      if (cls.kind === "tamper") return this.set("policy_stop", `保護された記録の不整合でランナーが止まった: ${reason}（自動では再試行しない）`, { notifyRole: "technical" });
      if (held === "manual_stop" && this.st.status !== "manual_stop") return this.set("manual_stop", "手動で停止（ランナーの実行中に止められた）。再開は端末で pnpm devkit supervisor clear");
      this.st.lastExit = { at: at.toISOString(), code, kind: cls.kind, reason: String(reason).slice(0, 300) };
      return this.save();
    }
    if (cls.kind === "ok" || cls.kind === "busy" || cls.kind === "stalled") {
      const after = progressKey(ctx);
      if (cls.kind === "ok" && after === before) this.st.noProgress = (this.st.noProgress ?? 0) + 1;
      else if (after !== before) {
        this.st.noProgress = 0;
        this.st.failures = {};
        this.st.current = null;
      }
      return this.set("watching", `ランナーが終了した（${reason || `exit ${code}`}）`);
    }
    if (cls.kind === "tamper") return this.set("policy_stop", `保護された記録の不整合でランナーが止まった: ${reason}（自動では再試行しない）`, { notifyRole: "technical" });
    if (cls.kind === "auth") return this.set("env_stop", `認証の問題（${reason}）。ランナーを回す利用者で claude を起動して /login する`, { notifyRole: "technical" });
    if (cls.kind === "environment") return this.set("env_stop", `環境の問題（${reason}）。直してから解除する`, { notifyRole: "technical" });
    // 一時的な障害・利用上限: 待って再試行（同じ失敗の試行回数は、再起動をまたいで数える）
    // 試行の回数は種類ごとに数える（文言が少しずつ違っても、同じ一時的な障害として上限を効かせる）。本当に進んだら数え直す
    const key = cls.kind;
    const f = this.st.failures[key] ?? { kind: cls.kind, attempts: 0, firstAt: at.toISOString() };
    f.attempts += 1;
    f.lastAt = at.toISOString();
    this.st.failures[key] = f;
    let nextAt;
    if (cls.kind === "rate_limit") {
      const reset = parseResetAt(reason, at, config.briefing.timeZone);
      if (!reset) return this.set("env_stop", `利用上限（${reason}）。復帰の時刻が分からないので待たずに止める（別の課金には切り替えない）`, { notifyRole: "technical" });
      if (reset.getTime() - at.getTime() > r.maxRateLimitWaitHours * 3600_000) return this.set("limit_stop", `利用上限の復帰（${reset.toISOString()}）が待てる時間（${r.maxRateLimitWaitHours} 時間）を超える`, { notifyRole: "technical" });
      if (f.attempts > r.maxAttempts + 1) return this.set("limit_stop", `利用上限で ${f.attempts} 回止まった`, { notifyRole: "technical" });
      nextAt = new Date(reset.getTime() + (60 + Math.floor(Math.random() * 120)) * 1000);
    } else {
      if (f.attempts > r.maxAttempts || at.getTime() - Date.parse(f.firstAt) > r.totalHours * 3600_000)
        return this.set("limit_stop", `${KIND_JA[cls.kind]}が続いた（${f.attempts} 回目、最初は ${f.firstAt}）: ${reason}`, { notifyRole: "technical" });
      const wait = Math.min(r.baseSeconds * 2 ** (f.attempts - 1), r.maxWaitMinutes * 60) * (0.8 + Math.random() * 0.4);
      nextAt = new Date(at.getTime() + wait * 1000);
    }
    this.st.current = { key, kind: cls.kind, attempt: f.attempts, nextAt: nextAt.toISOString(), reason: String(reason).slice(0, 300) };
    appendEvent(ctx, "supervisor_retry", { kind: cls.kind, attempt: f.attempts, nextAt: nextAt.toISOString(), reason: String(reason).slice(0, 300) });
    return this.set("retry_wait", `${KIND_JA[cls.kind]}（${reason}）。${nextAt.toISOString()} に再試行（${f.attempts} 回目）`);
  }

  async briefingStep(at) {
    const b = this.config.briefing;
    if (!b.enabled) return;
    const dl = deadlineAtOrBefore(at, b.time, b.timeZone);
    let last = this.st.briefing?.lastDeadline ? Date.parse(this.st.briefing.lastDeadline) : 0;
    if (last > at.getTime()) last = 0; // 未来の締切の記録（時計の誤りなど）は信用しない
    // Supervisor が止まっていて作れなかった締切の分も、遅れたことを書いて作る（最大7日分）
    const due = [];
    const oldest = deadlineAtOrBefore(new Date(dl.getTime() - 6 * 24 * 3600_000), b.time, b.timeZone);
    let d = last ? nextDeadline(new Date(last), b.time, b.timeZone) : dl;
    if (d.getTime() < oldest.getTime()) d = oldest;
    while (d.getTime() <= dl.getTime() && due.length < 7) {
      due.push(d);
      d = nextDeadline(d, b.time, b.timeZone);
    }
    for (const deadline of due) {
      const r = produceBriefing(this.ctx, { at, deadline });
      this.st.briefing = { lastDeadline: deadline.toISOString(), file: r.file };
      if (r.created) this.say(`ブリーフィングを作りました: ${r.file}`);
      this.save();
    }
    await flushOutbox(this.ctx);
  }

  // 照合を早める。照合の最中に来た通知も、次の待ちを飛ばして拾う
  kick() {
    this.kicked = true;
    if (this.wake) this.wake();
  }

  async loop() {
    const cp = configProblems(loadConfig(this.ctx));
    if (cp.length) throw new Error(`.devkit/config.json に問題があります:\n${cp.map((p) => `  - ${p}`).join("\n")}`);
    const lock = acquire(this.ctx);
    if (lock !== true) throw new Error(`別の Supervisor が動いています（pid ${lock.busy?.pid}、${lock.busy?.host ?? ""}）`);
    const stop = () => {
      this.stopping = true;
      this.kick();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    let watcher = null;
    try {
      this.load();
      this.say(`開始（pid ${process.pid}、照合の間隔 ${this.config.supervisor.intervalSeconds} 秒、ブリーフィング ${this.config.briefing.time} ${this.config.briefing.timeZone}）`);
      appendEvent(this.ctx, "supervisor_started", { pid: process.pid });
      try {
        // 人の判断（controls.json）の変更ですぐに照合する。取りこぼしても、定期の照合で拾う
        let timer = null;
        watcher = watch(this.ctx.dir, (_, name) => {
          if (!name || !/^(controls|state)\.json$/.test(String(name))) return;
          clearTimeout(timer);
          timer = setTimeout(() => this.kick(), 1000);
        });
      } catch {}
      for (;;) {
        try {
          await this.tick();
        } catch (e) {
          this.say(`照合で失敗しました: ${e.message}`);
        }
        if (this.once || this.stopping) break;
        if (this.kicked) {
          this.kicked = false;
          continue;
        }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, this.config.supervisor.intervalSeconds * 1000);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
        this.kicked = false;
        if (this.stopping) break;
      }
    } finally {
      watcher?.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (!this.child) {
        this.load();
        this.st.heartbeatAt = null;
        writeSupervisorState(this.ctx, this.st);
      }
      appendEvent(this.ctx, "supervisor_stopped", { pid: process.pid, runnerStillRunning: Boolean(this.child) });
      release(this.ctx);
    }
  }
}

function manualReason(stop) {
  return `手動で停止（${stop?.reason ?? ""}）。再開は、標準オーナーが端末で pnpm devkit supervisor clear --role 技術 --note "…"`;
}

// 時間帯（"22:00-07:00"）の終わりの時刻のうち、at より後で最も近いもの（タイムゾーンで）
export function endOfHours(at, hours, tz) {
  const end = parseHHMM(String(hours).split("-")[1]);
  const p = zonedParts(at, tz);
  for (let add = 0; add < 3; add++) {
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
    const cand = zonedToDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), end.h, end.mi, tz);
    if (cand.getTime() > at.getTime()) return cand;
  }
  return new Date(at.getTime() + 24 * 3600_000);
}

