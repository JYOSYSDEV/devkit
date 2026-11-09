#!/usr/bin/env node
// devkit: 計画の検証・ランナー・人の判断の記録・状況の確認を行う CLI（依存パッケージなし、Node.js 22 以上）。
//
// 誰でも（Claude からも）使えるもの
//   pnpm devkit check                 計画の検査（DAG・goal・担当パス・受入基準の割り当て・ゲート）
//   pnpm devkit status [--json] [--watch]   進捗・ランナーの生死・誰の番か
//   pnpm devkit logs [--dir <dir>]    最新の実行ログの要約
//   pnpm devkit gate <マイルストーン>   確認資料（.devkit/gates/<ID>.html）を作り直す
//   pnpm devkit next                  次に実行される作業（表示だけ）
//   pnpm devkit start                 承認済みの計画で開始する（サイクル上限を記録）
//   pnpm devkit run [--until 07:00] [--max-hours N] [--max-cost-usd N] [--detach]   ランナーを起動
//   pnpm devkit pause [理由]          止める（ランナーは今の作業が終わり次第止まる）
//   pnpm devkit log "<文>"            進捗ログに追記
//   pnpm devkit mermaid [--write]     依存グラフ（--write で .devkit/graph.md）
//   pnpm devkit goal <ノード>          ノードの /goal 条件文（手作業で進めるとき）
//   pnpm devkit shared / version / brief
//   pnpm devkit briefing [--print] [--json] [--partial] [--send] [--at <ISO>]   定時ブリーフィング（前回の締切から今回の締切まで）
//   pnpm devkit supervisor run [--once] | start | status [--json] | stop [理由]   ランナーの外側で起動・待機・再試行を管理する
//
// 人だけが端末で実行するもの（Claude とランナーの AI からは実行できない）
//   pnpm devkit approve plan --role <業務|技術> [--by 名前] [--note ...]
//   pnpm devkit approve <マイルストーン> --role <業務|技術> [--note ...] [--force --note 理由]
//   pnpm devkit approve <ノード> --before --role <業務|技術>
//   pnpm devkit reject <マイルストーン> --role <業務|技術> --note "直してほしい点"   マイルストーンの承認者の役割だけが差し戻せる
//   pnpm devkit answer <ノード> --role <依頼の種別> [--request <判断依頼の ID>] --note "回答"   依頼の種別の役割だけが回答できる
//   pnpm devkit proposal list | show <ID> | accept <ID> --role <案の確認者> [--note] | reject <ID> --role <案の確認者> --note
//   pnpm devkit exception add --rules <ID,…> --subject <対象> --reason … --adr <パス> --review-by YYYY-MM-DD --role 技術
//   pnpm devkit resume [--add-cycles N]
//   pnpm devkit record --role <業務|技術> --target <対象> --decision <判断> [--note …]   判断の記録に1行残す（devkit の更新など）
//   pnpm devkit supervisor clear --role 技術 --note "<直したこと>"   Supervisor の上限停止・環境の停止・方針違反・手動停止を解除する
//   pnpm devkit seal accept --role 技術 --note "<確かめたこと>"   devkit が書いたものと合わない記録を、確かめた上で受け入れる
//   pnpm devkit archive
//   いずれも代理なら --delegate-of <本人> --note <理由>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBriefing, flushOutbox, produceBriefing, writeBriefing } from "./lib/briefing.mjs";
import { now as clockNow } from "./lib/clock.mjs";
import { checkOwner, commitPaths, identity, recordDecision, requireHuman } from "./lib/human.mjs";
import { committedUnexplained, journal, journalProblem, journalWrite, uncommittedUnexplained, updateAnchor } from "./lib/seal.mjs";
import {
  applyHumanDecisions,
  classifyPlanChange,
  createContext,
  decide,
  gateKey,
  loadConfig,
  loadControls,
  loadGraph,
  loadState,
  nodeKey,
  normalizeGraph,
  PLAN_APPROVERS,
  pendingRoles,
  planApproved,
  planHash,
  proposalNeededRoles,
  proposalRoles,
  requestId,
  requestRole,
  requiredRoles,
  saveState,
  topoLayers,
  updateControls,
  validate,
} from "./lib/model.mjs";
import { summarizeLogs, writeGateReport, writeStatusHtml } from "./lib/report.mjs";
import { outboxEntries } from "./lib/briefing.mjs";
import { Supervisor, supervisorAlive } from "./lib/supervisor.mjs";
import { readSupervisorState, SUPERVISOR_STOPS } from "./lib/supstate.mjs";
import { parseRunLimits, run } from "./lib/runner.mjs";
import { appendProgress, computeStatus, runnerAlive, statusText } from "./lib/status.mjs";
import { DevkitError, fail, localStamp, nowIso, parseArgs, readJson, sleep, writeJson, writeText } from "./lib/util.mjs";
import { checkout, removeCheckout, runChecker } from "./lib/verify.mjs";
import { normalizeRole, ROLE_LABEL, ROLE_PERSON, SHARED_LABELS } from "./shared.mjs";
import { DEVKIT_VERSION } from "./version.mjs";

const ctx = createContext(process.cwd());
const [cmd = "status", ...rest] = process.argv.slice(2);
const { pos, opts } = parseArgs(rest, { booleans: ["json", "watch", "write", "before", "force", "detach", "release", "print", "send", "partial", "once"] });

const MUTATING = new Set(["start", "pause", "resume", "run", "approve", "reject", "answer", "proposal", "archive", "log", "exception", "record", "seal", "briefing", "supervisor"]);

function out(text) {
  console.log(text);
}

function role(opts) {
  const r = normalizeRole(opts.role);
  if (!r) fail('--role は「業務」か「技術」（business / technical）を指定してください');
  return r;
}

function note(opts, required = false) {
  const n = typeof opts.note === "string" ? opts.note.trim() : "";
  if (required && !n) fail('--note "…" を指定してください（判断の記録に残します）');
  return n;
}

function alive() {
  return runnerAlive(ctx).alive;
}

// ランナーが止まっていれば、人の決定をその場で状態に反映してコミットする（動いていればランナーが次の手で反映する）
function applyNowIfIdle(message, journalCmd = cmd) {
  if (alive()) {
    out("ランナーが実行中なので、次の手で反映されます。");
    return;
  }
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  const notes = updateControls(ctx, (c) => applyHumanDecisions(g, s, c), { journal: journalCmd });
  saveState(ctx, s, { journal: journalCmd });
  for (const n of notes) appendProgress(ctx, n);
  try {
    writeStatusHtml(ctx);
  } catch {}
  commitPaths(ctx, [".devkit/state.json", ".devkit/controls.json", ".devkit/progress.md", ".devkit/requests", ".devkit/graph.json", ".devkit/journal.jsonl", "docs/decisions.md"], message);
  if (s.outer === "running") out("続きは `pnpm devkit run`（夜間に回すなら `pnpm devkit run --until 07:00 --detach`）");
}

const commands = {
  check() {
    const g = loadGraph(ctx);
    const c = loadControls(ctx);
    const { errors, warnings } = validate(ctx, g, { controls: c });
    for (const w of warnings) out(`warn: ${w}`);
    for (const e of errors) out(`error: ${e}`);
    if (errors.length) fail(`計画に ${errors.length} 件の問題があります`);
    const { layers } = topoLayers(g);
    out(`ok: マイルストーン ${g.milestones.length} / ノード ${g.nodes.length} / ${layers.length} 段`);
    for (const m of g.milestones) out(`  ${m.id} ${m.title}${m.release ? "（リリース）" : ""}${m.foundation ? "（基盤）" : ""}: ${g.nodes.filter((n) => n.milestone === m.id).map((n) => n.id).join(", ")}　承認: ${m.approvers.map((r) => ROLE_LABEL[r]).join("・") || "なし（変更内容で追加）"}`);
    const pa = planApproved(ctx, c);
    out(pa.ok ? "計画: 承認済み" : `計画: 未承認（${pa.pending.map((r) => ROLE_PERSON[r]).join("・")}の承認待ち）`);
  },

  async status() {
    const show = () => {
      const st = computeStatus(ctx);
      if (opts.json) out(JSON.stringify(st, null, 2));
      else out(statusText(st));
    };
    if (!opts.watch) return show();
    for (;;) {
      process.stdout.write("\x1b[2J\x1b[H");
      show();
      await sleep(10_000);
    }
  },

  logs() {
    out(summarizeLogs(ctx, { dir: typeof opts.dir === "string" ? opts.dir : null }));
  },

  gate() {
    const [mid] = pos;
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    if (!g.milestones.some((m) => m.id === mid)) fail(`マイルストーン ${mid} がありません`);
    out(writeGateReport(ctx, { g, s, mid }));
  },

  next() {
    const g = loadGraph(ctx);
    const d = decide(g, loadState(ctx, g), loadControls(ctx));
    if (d.allDone) return out("すべて完了");
    out(`今のマイルストーン: ${d.current}`);
    if (d.verifyMilestone) out(`次: ${d.verifyMilestone} の全体検証`);
    for (const n of d.ready) out(`実行できる: ${n.id}\t${n.title}`);
    for (const x of d.deferred) out(`(見送り) ${x.id}: ${x.why}`);
    for (const x of d.replan) out(`(要再計画) ${x.id}: ${String(x.reason).split("\n")[0]}`);
    for (const a of d.waiting.approvals) out(`(承認待ち) ${a.target}: ${a.roles.map((r) => ROLE_PERSON[r]).join("・")}`);
    for (const a of d.waiting.answers) out(`(回答待ち) ${a.node}: ${ROLE_PERSON[a.role]}`);
  },

  shared() {
    out("作業（ノード）の owns にできない共有ファイル:");
    for (const l of SHARED_LABELS) out(`  ${l}`);
    out("ほかに、仕様（docs/spec/）・標準（docs/standard/）・人の判断の記録・devkit 自身（scripts/devkit/・scripts/standard/）・テストの設定（vitest・playwright）・.npmrc・.gitattributes・.gitignore も作業では変えられない。");
  },

  version() {
    const installed = readJson(ctx.version, null);
    const info = { runtime: DEVKIT_VERSION, installed: installed?.version ?? null, standard: readTextSafe(join(ctx.root, "docs", "standard", "VERSION")) };
    out(opts.json ? JSON.stringify(info) : `devkit ${info.runtime}（案件に入っている版: ${info.installed ?? "不明"}、社内標準 ${info.standard || "不明"}）`);
  },

  mermaid() {
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    const lines = ["flowchart LR"];
    for (const m of g.milestones) {
      lines.push(`  subgraph ${m.id}["${m.id}: ${m.title.replace(/"/g, "'")}"]`);
      for (const n of g.nodes.filter((x) => x.milestone === m.id)) lines.push(`    ${n.id}["${n.id}: ${n.title.replace(/"/g, "'")}"]:::${s.nodes[n.id]?.status ?? "pending"}`);
      lines.push("  end");
    }
    for (const n of g.nodes) for (const d of n.deps) lines.push(`  ${d} --> ${n.id}`);
    lines.push(
      "  classDef pending fill:#f4f4f5,stroke:#a1a1aa",
      "  classDef running fill:#dbeafe,stroke:#3b82f6",
      "  classDef ready_to_merge fill:#fef9c3,stroke:#ca8a04",
      "  classDef done fill:#dcfce7,stroke:#16a34a",
      "  classDef failed fill:#fee2e2,stroke:#dc2626",
      "  classDef blocked fill:#fee2e2,stroke:#dc2626",
    );
    const text = lines.join("\n");
    if (opts.write) {
      writeTextSafe(join(ctx.dir, "graph.md"), `# ${g.mission}\n\n\`\`\`mermaid\n${text}\n\`\`\`\n`);
      out(".devkit/graph.md を更新しました");
    } else out(text);
  },

  goal() {
    const g = loadGraph(ctx);
    const n = g.nodes.find((x) => x.id === pos[0]);
    if (!n) fail(`ノード ${pos[0]} がありません`);
    out(`/goal ${n.goal}`);
  },

  log() {
    appendProgress(ctx, pos.join(" "));
  },

  // 定時ブリーフィング。--print・--json は表示だけ（ファイルを書かない）。--send は保存して送信待ちに入れ、送る
  async briefing() {
    const at = typeof opts.at === "string" ? new Date(opts.at) : clockNow();
    if (!Number.isFinite(at.getTime())) fail("--at は ISO 8601 の日時で指定してください");
    if (opts.print || opts.json) {
      const b = buildBriefing(ctx, { at, partial: Boolean(opts.partial) });
      if (opts.json) return out(JSON.stringify(b, null, 2));
      return out(b.text);
    }
    if (opts.partial) {
      const b = buildBriefing(ctx, { at, partial: true });
      return out(`途中経過を保存しました: ${writeBriefing(ctx, b)}`);
    }
    const r = produceBriefing(ctx, { at });
    out(`${r.created ? "作りました" : "この締切の分は作成済みです"}: ${r.file}（${r.briefing.subject}）`);
    if (opts.send) {
      const sent = await flushOutbox(ctx);
      for (const e of sent) out(`配信: ${e.status}${e.lastError ? `（${e.lastError}）` : ""}`);
      if (!sent.length) out(`配信: ${r.entry.status}${r.entry.lastError ? `（${r.entry.lastError}）` : ""}`);
    }
  },

  start() {
    const g = loadGraph(ctx);
    const c = loadControls(ctx);
    const { errors } = validate(ctx, g, { controls: c });
    if (errors.length) fail("計画の検査に失敗しています。pnpm devkit check を通してから開始してください");
    const pa = planApproved(ctx, c);
    if (!pa.ok) fail(`計画が承認されていません（${pa.pending.map((r) => ROLE_PERSON[r]).join("・")}）。人が端末で pnpm devkit approve plan --role <業務|技術> を実行します`);
    const deps = [...(g.dependencies.prod ?? []), ...(g.dependencies.dev ?? [])];
    const pkg = readJson(join(ctx.root, "package.json"), {});
    const have = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const missing = deps.map((d) => d.replace(/@[^@/]+$/, "")).filter((d) => !have[d]);
    if (missing.length) fail(`graph の dependencies にあるパッケージがまだ入っていません: ${missing.join(", ")}（pnpm add で追加してコミットしてから開始）`);
    const s = loadState(ctx, g);
    if (s.outer === "running") return out("すでに開始しています。ランナーは pnpm devkit run");
    updateControls(
      ctx,
      (cc) => {
        cc.maxCycles ??= g.limits.maxCycles;
        cc.pause = null;
        for (const m of g.milestones) if (m.approvers.length) cc.gates[m.id] = [...new Set([...(cc.gates[m.id] ?? []), ...m.approvers])].sort();
        for (const n of g.nodes) if (n.before.length) cc.gates[gateKey("before", n.id)] = [...new Set([...(cc.gates[gateKey("before", n.id)] ?? []), ...n.before])].sort();
      },
      { journal: "start" },
    );
    s.outer = "running";
    s.reason = "";
    s.stall = 0;
    saveState(ctx, s, { journal: "start" });
    appendProgress(ctx, `開始（マイルストーン ${g.milestones.length}、ノード ${g.nodes.length}）`);
    commitPaths(ctx, [".devkit/state.json", ".devkit/controls.json", ".devkit/progress.md", ".devkit/journal.jsonl"], "devkit: start");
    out("開始しました。ランナーは `pnpm devkit run`（夜間に回すなら `pnpm devkit run --until 07:00 --detach`）");
  },

  // 止める（誰でも。Claude からも）。controls.json に書き、ランナーは次の手で止まる
  pause() {
    const reason = pos.join(" ") || "手動で一時停止";
    updateControls(
      ctx,
      (c) => {
        c.pause = { reason, at: nowIso(), applied: false };
      },
      { journal: "pause" },
    );
    appendProgress(ctx, `一時停止の指示: ${reason}`);
    const running = alive();
    applyNowIfIdle("devkit: pause", "pause");
    out(`一時停止しました（${reason}）。${running ? "ランナーは今の作業が終わり次第止まります。" : ""}再開は pnpm devkit resume`);
  },

  resume() {
    if (alive()) fail("ランナーが実行中です（止まってから再開します。止めるのは pnpm devkit pause）");
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    const add = opts["add-cycles"];
    const needsHuman = add !== undefined || s.outer === "stalled";
    let who = null;
    if (needsHuman) {
      requireHuman(add !== undefined ? `resume --add-cycles ${add}` : "resume");
      who = identity(ctx, opts.by);
      checkOwner(ctx, "technical", who, { delegateOf: opts["delegate-of"], note: note(opts) });
    }
    if (add !== undefined) {
      const n = Number(add);
      if (!Number.isInteger(n) || n < 1 || n > 100) fail("--add-cycles は 1〜100");
      updateControls(
        ctx,
        (c) => {
          c.maxCycles = (c.maxCycles ?? g.limits.maxCycles) + n;
        },
        { journal: "resume" },
      );
      recordDecision(ctx, { role: "technical", who, target: "サイクル上限", decision: `${n} 追加`, content: note(opts), command: "resume" });
    }
    if (s.outer === "stalled") {
      recordDecision(ctx, { role: "technical", who, target: "停止からの再開", decision: "再開", content: note(opts) || s.reason, command: "resume" });
      for (const m of g.milestones) if (s.milestones[m.id]) s.milestones[m.id].replans = 0;
    }
    updateControls(
      ctx,
      (c) => {
        c.pause = null;
      },
      { journal: "resume" },
    );
    s.outer = "running";
    s.reason = "";
    s.stall = 0;
    saveState(ctx, s, { journal: "resume" });
    appendProgress(ctx, "再開");
    commitPaths(ctx, [".devkit/state.json", ".devkit/controls.json", ".devkit/progress.md", ".devkit/journal.jsonl", "docs/decisions.md"], "devkit: resume");
    out("再開しました。ランナーは `pnpm devkit run`");
  },

  async run() {
    if (ctx.inWorker) fail("ランナーはメインの作業ツリーで起動します");
    if (process.env.DEVKIT_ROLE) fail("ランナーが起動した AI からランナーは起動できません");
    parseRunLimits({ until: opts.until, maxHours: opts["max-hours"], maxCostUsd: opts["max-cost-usd"], maxParallel: opts["max-parallel"] });
    if (opts.detach) {
      mkdirSync(ctx.logs, { recursive: true });
      const logFile = join(ctx.logs, `runner-${localStamp()}.log`);
      const fd = openSync(logFile, "a");
      const args = [fileURLToPath(import.meta.url), "run", ...rest.filter((a) => a !== "--detach")];
      const child = spawn(process.execPath, args, { cwd: ctx.root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
      child.unref();
      out(`ランナーを切り離して起動しました（pid ${child.pid}）。状況: pnpm devkit status ／ ログ: ${relative(ctx.root, logFile)}`);
      return;
    }
    const code = await run(ctx, { until: opts.until, maxHours: opts["max-hours"], maxCostUsd: opts["max-cost-usd"], maxParallel: opts["max-parallel"] });
    process.exitCode = code;
  },

  approve() {
    const [target] = pos;
    if (!target) fail("使い方: approve plan --role <業務|技術> ／ approve <マイルストーン> --role … ／ approve <ノード> --before --role …");
    requireHuman(`approve ${target}`);
    const r = role(opts);
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
    if (owner.warning) out(`注意: ${owner.warning}`);
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);

    if (target === "plan") {
      const c = loadControls(ctx);
      const { errors } = validate(ctx, g, { controls: c });
      if (errors.length) fail(`計画に問題があるので承認できません（pnpm devkit check）:\n${errors.slice(0, 10).map((e) => `  - ${e}`).join("\n")}`);
      const hash = planHash(ctx);
      const res = updateControls(
        ctx,
        (cc) => {
          cc.plan.approvals[r] = { hash, by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null };
          const all = PLAN_APPROVERS.every((x) => cc.plan.approvals[x]?.hash === hash);
          if (all) {
            cc.plan.approvedHash = hash;
            cc.plan.history.push({ type: "human-approval", hash, at: nowIso(), by: PLAN_APPROVERS.map((x) => cc.plan.approvals[x].by) });
          }
          return all;
        },
        { journal: "approve plan" },
      );
      recordDecision(ctx, { role: r, who, target: `計画（${g.mission}）`, decision: "承認", sha: hash, content: note(opts), delegateOf: owner.delegateOf, command: "approve plan" });
      commitPaths(ctx, [".devkit/graph.json", ".devkit/mission.md", g.spec.split("#")[0], ".devkit/controls.json", ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 計画の${ROLE_LABEL[r]}承認`);
      out(res ? "計画の承認がそろいました。Claude に「開始して」と伝えるか、pnpm devkit start → pnpm devkit run" : `${ROLE_PERSON[r]}として承認しました。残り: ${PLAN_APPROVERS.filter((x) => x !== r).map((x) => ROLE_PERSON[x]).join("・")}の承認`);
      return;
    }

    if (opts.before) {
      const n = g.nodes.find((x) => x.id === target);
      if (!n) fail(`ノード ${target} がありません`);
      const c = loadControls(ctx);
      const roles = requiredRoles(c, gateKey("before", n.id), n.before);
      if (!roles.includes(r)) fail(`${target} の着手前に${ROLE_PERSON[r]}の承認は要りません（必要: ${roles.map((x) => ROLE_PERSON[x]).join("・") || "なし"}）`);
      updateControls(
        ctx,
        (cc) => {
          cc.approvals[gateKey("before", n.id)] ??= {};
          // ノードの定義に紐づける（再計画で定義が変わったら、承認は取り直しになる）
          cc.approvals[gateKey("before", n.id)][r] = { sha: nodeKey(n), by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null };
        },
        { journal: "approve --before" },
      );
      recordDecision(ctx, { role: r, who, target: `${n.id}「${n.title}」の着手`, decision: "承認", content: note(opts), delegateOf: owner.delegateOf, command: "approve --before" });
      applyNowIfIdle(`devkit: ${n.id} 着手前の${ROLE_LABEL[r]}承認`, "approve --before");
      out(`${n.id} の着手を承認しました`);
      return;
    }

    const m = g.milestones.find((x) => x.id === target);
    if (!m) fail(`マイルストーン ${target} がありません（ノードの着手前の承認なら --before）`);
    const ms = s.milestones[m.id];
    if (ms.status !== "awaiting_approval") fail(`${target} は承認待ちではありません（${ms.status}）`);
    const c = loadControls(ctx);
    const roles = requiredRoles(c, m.id, ms.required ?? []);
    if (!roles.includes(r)) fail(`${target} に${ROLE_PERSON[r]}の承認は要りません（必要: ${roles.map((x) => ROLE_PERSON[x]).join("・")}）`);
    if (!pendingRoles(c, m.id, [r], { sha: ms.head }).length) fail(`${target} は${ROLE_PERSON[r]}が承認済みです`);
    let forced = false;
    if (m.release && r === "technical") {
      // リリース前検査は、承認の対象の版（検証したコミット）で行う
      const co = checkout(ctx, loadConfig(ctx), "approve", ms.head);
      const rel = runChecker(ctx, co, { release: true });
      removeCheckout(ctx, co);
      if (rel.violations.length) {
        for (const v of rel.violations) out(`✗ [${v.rule}] ${v.file ? `${v.file} — ` : ""}${v.message}`);
        if (!opts.force) fail("リリース前検査が通っていません。直してから承認してください（やむを得ない場合は --force と --note で理由を残す）");
        note(opts, true);
        forced = true;
      }
    }
    if (!ms.head) fail(`${target} には検証したコミットの記録がないので承認できません（ランナーの全体検証からやり直す）`);
    updateControls(
      ctx,
      (cc) => {
        cc.approvals[m.id] ??= {};
        cc.approvals[m.id][r] = { sha: ms.head, by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null, ...(forced ? { forced: true } : {}) };
      },
      { journal: "approve" },
    );
    recordDecision(ctx, { role: r, who, target: `${m.id}「${m.title}」`, decision: forced ? "承認（リリース前検査が未達のまま）" : "承認", sha: ms.head, content: note(opts), delegateOf: owner.delegateOf, command: "approve" });
    applyNowIfIdle(`devkit: ${m.id} の${ROLE_LABEL[r]}承認`, "approve");
    const left = pendingRoles(loadControls(ctx), m.id, roles, { sha: ms.head });
    out(left.length ? `${ROLE_PERSON[r]}として承認しました。残り: ${left.map((x) => ROLE_PERSON[x]).join("・")}` : `${m.id} の承認がそろいました`);
  },

  reject() {
    const [target] = pos;
    const r = role(opts);
    const text = note(opts, true);
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    const m = g.milestones.find((x) => x.id === target);
    if (!m) fail(`マイルストーン ${target} がありません`);
    const ms = s.milestones[m.id];
    if (ms.status !== "awaiting_approval") fail(`${target} は承認待ちではありません（${ms.status}）`);
    // 差し戻せるのは、そのマイルストーンの承認者の役割だけ（承認と同じ）
    const roles = requiredRoles(loadControls(ctx), m.id, ms.required ?? []);
    if (!roles.includes(r))
      fail(`${target} の承認者は${roles.map((x) => ROLE_PERSON[x]).join("・") || "いません"}です。${ROLE_PERSON[r]}は ${target} を差し戻せません（意見は承認者に伝えてください）`);
    requireHuman(`reject ${target}`, { detail: `${m.id}「${m.title}」（検証したコミット ${String(ms.head ?? "").slice(0, 10) || "なし"}）を${ROLE_PERSON[r]}として差し戻します` });
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: text });
    updateControls(
      ctx,
      (cc) => {
        cc.rejections ??= {};
        cc.rejections[m.id] = { role: r, note: text, by: who.name, email: who.email, at: nowIso(), sha: ms.head, applied: false };
      },
      { journal: "reject" },
    );
    recordDecision(ctx, { role: r, who, target: `${m.id}「${m.title}」`, decision: "差し戻し", sha: ms.head, content: text, delegateOf: owner.delegateOf, command: "reject" });
    applyNowIfIdle(`devkit: ${m.id} を${ROLE_LABEL[r]}が差し戻し`, "reject");
    out(`${m.id} を差し戻しました。ランナーが指摘を再計画に渡して直します（pnpm devkit run）`);
  },

  answer() {
    const [id] = pos;
    const r = role(opts);
    const text = note(opts, true);
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    const ns = s.nodes[id];
    if (!ns?.request || ns.status !== "blocked") fail(`${id ?? "<ノード>"} には回答待ちの判断依頼がありません`);
    // 回答は、今の判断依頼（ID）に、依頼の種別の役割が答えるものだけを受け付ける
    const rid = requestId(id, ns.request);
    const want = requestRole(ns.request);
    const asked = typeof opts.request === "string" ? opts.request.trim() : "";
    if (opts.request !== undefined && !asked) fail("--request には判断依頼の ID（.devkit/requests/<ノード>.md の先頭）を指定してください");
    if (asked && asked !== rid) fail(`${id} で回答待ちの判断依頼は ${rid} です（${asked} は回答済みか、別の依頼）。.devkit/requests/${id}.md を確かめてください`);
    if (r !== want)
      fail(
        `${id} の判断依頼 ${rid}（${ns.request.condition}）は${ROLE_PERSON[want]}が回答します。${ROLE_PERSON[r]}の回答は受け付けません` +
          `（${ROLE_PERSON[want]}が pnpm devkit answer ${id} --role ${ROLE_LABEL[want]} --request ${rid} --note "…" を実行します）`,
      );
    requireHuman(`answer ${id}`, { detail: `判断依頼 ${rid}（${ns.request.condition}、${ROLE_PERSON[want]}が回答）: ${String(ns.request.what ?? "").slice(0, 300)}` });
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: text });
    updateControls(
      ctx,
      (cc) => {
        cc.answers[id] ??= [];
        cc.answers[id].push({ request: rid, role: r, note: text, by: who.name, email: who.email, at: nowIso(), delegateOf: owner.delegateOf ?? null, applied: false });
      },
      { journal: "answer" },
    );
    recordDecision(ctx, { role: r, who, target: `${id} の判断依頼 ${rid}（${ns.request.condition}）`, decision: "回答", content: text, delegateOf: owner.delegateOf, command: "answer" });
    const reqFile = join(ctx.requests, `${id}.md`);
    if (existsSync(reqFile)) renameSync(reqFile, join(ctx.requests, `${id}-answered-${localStamp()}.md`));
    applyNowIfIdle(`devkit: ${id} の判断依頼に回答`, "answer");
    out(`${id} に回答しました`);
  },

  proposal() {
    const [sub, id] = pos;
    const g = loadGraph(ctx);
    const s = loadState(ctx, g);
    if (!sub || sub === "list") {
      for (const p of s.proposals ?? []) out(`${p.id}\t${p.status}\t${(p.reasons ?? []).join(" / ")}`);
      return;
    }
    const file = join(ctx.proposals, `${id}.json`);
    const doc = readJson(file, null);
    if (!doc) fail(`再計画の案 ${id} がありません`);
    if (sub === "show") return out(JSON.stringify(doc, null, 2));
    if (!["accept", "reject"].includes(sub)) fail("使い方: proposal list | show <ID> | accept <ID> --role 技術 [--note] | reject <ID> --role 技術 --note …");
    const entry = (s.proposals ?? []).find((p) => p.id === id);
    if (!entry || entry.status !== "needs_human") fail(`再計画の案 ${id} は人の確認待ちではありません（${entry?.status ?? "記録なし"}）`);
    const r = role(opts);
    // 確認する役割: ランナーが案を作ったときの役割と、案の計画から求め直した役割の両方（減らさない）
    const next = doc.proposal?.graph ?? null;
    const nextG = next ? normalizeGraph(structuredClone(next)) : null;
    const cls = nextG ? classifyPlanChange(g, nextG, s) : null;
    const needed = proposalNeededRoles(entry.roles ?? [], doc.roles ?? [], cls ? proposalRoles(cls.reasons) : []);
    if (!needed.includes(r))
      fail(`再計画の案 ${id} を確認するのは${needed.map((x) => ROLE_PERSON[x]).join("・")}です。${ROLE_PERSON[r]}は${sub === "accept" ? "承認" : "却下"}できません`);
    if (sub === "reject") note(opts, true);
    if (sub === "accept") {
      if (!next) fail(`案 ${id} には適用できる計画がありません（人が graph.json を直して pnpm devkit approve plan）`);
      const { errors } = validate(ctx, nextG, { controls: loadControls(ctx) });
      if (errors.length) fail(`案 ${id} の計画は検査に通りません:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }
    requireHuman(`proposal ${sub} ${id}`, { detail: `再計画の案 ${id}（${(entry.reasons ?? []).slice(0, 3).join(" / ")}）を${ROLE_PERSON[r]}として${sub === "accept" ? "承認" : "却下"}します` });
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
    if (sub === "reject") {
      const text = note(opts, true);
      updateControls(
        ctx,
        (cc) => {
          cc.proposals ??= {};
          cc.proposals[id] = { ...(cc.proposals[id] ?? {}), status: "rejected", role: r, needed, by: who.name, email: who.email, at: nowIso(), note: text, delegateOf: owner.delegateOf ?? null };
        },
        { journal: "proposal reject" },
      );
      recordDecision(ctx, { role: r, who, target: `再計画の案 ${id}`, decision: "却下", content: text, delegateOf: owner.delegateOf, command: "proposal reject" });
      applyNowIfIdle(`devkit: 再計画の案 ${id} を却下`, "proposal reject");
      return out("却下しました。計画を人が直す場合は、直したあと pnpm devkit approve plan を両方の役割で実行します");
    }
    const hash = planHash(ctx, next);
    const oldIds = new Set(g.nodes.map((n) => n.id));
    const changed = nextG.nodes.filter((n) => !oldIds.has(n.id) || JSON.stringify(n) !== JSON.stringify(g.nodes.find((x) => x.id === n.id))).map((n) => n.id);
    const removed = [...oldIds].filter((x) => !nextG.nodes.some((n) => n.id === x));
    // 役割ごとの承認を記録し、そろったら（同じロックの中で）計画に入れる
    const applied = updateControls(
      ctx,
      (cc) => {
        cc.proposals ??= {};
        const cur = cc.proposals[id] ?? { status: "pending", accepts: {} };
        cur.accepts = { ...(cur.accepts ?? {}), [r]: { by: who.name, email: who.email, at: nowIso(), note: note(opts), hash, delegateOf: owner.delegateOf ?? null } };
        cur.needed = needed;
        const all = needed.every((x) => cur.accepts[x]?.hash === hash);
        if (all) {
          journalWrite(ctx, ".devkit/graph.json", `${JSON.stringify(next, null, 2)}\n`, "proposal accept");
          Object.assign(cur, { status: "accepted", at: nowIso(), changed, removed });
          cc.plan.approvedHash = hash;
          cc.plan.history.push({ type: "human-accepted-proposal", id, hash, at: nowIso(), by: needed.map((x) => cur.accepts[x].by), reasons: cls.reasons });
        }
        cc.proposals[id] = cur;
        return all;
      },
      { journal: "proposal accept" },
    );
    recordDecision(ctx, { role: r, who, target: `再計画の案 ${id}`, decision: "承認", sha: hash, content: `${note(opts)}（人の確認が要った理由: ${cls.reasons.join("、")}）`, delegateOf: owner.delegateOf, command: "proposal accept" });
    if (!applied) {
      commitPaths(ctx, [".devkit/controls.json", ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 再計画の案 ${id} を${ROLE_LABEL[r]}が承認`);
      const cur = loadControls(ctx).proposals?.[id]?.accepts ?? {};
      const left = needed.filter((x) => cur[x]?.hash !== hash);
      return out(`${ROLE_PERSON[r]}として承認しました。残り: ${left.map((x) => ROLE_PERSON[x]).join("・")}の承認（pnpm devkit proposal accept ${id} --role ${left[0]}）`);
    }
    applyNowIfIdle(`devkit: 再計画の案 ${id} を承認`, "proposal accept");
    out(`案 ${id} を計画に入れました`);
  },

  // 社内標準の例外の登録（標準オーナーが端末で）。docs/exceptions.json は Claude からは編集できない
  exception() {
    const [sub] = pos;
    if (sub === "list" || !sub) {
      const doc = readJson(join(ctx.root, "docs", "exceptions.json"), { exceptions: [] });
      for (const e of doc.exceptions ?? []) out(`${e.id}\t${(e.rules ?? []).join(",")}\t${e.subject}\t見直し ${e.reviewBy}\t${e.reason}`);
      return;
    }
    if (sub !== "add") fail("使い方: exception list | exception add --rules TECH-01 --subject dependency:<名前> --reason … --adr docs/adr/… --review-by YYYY-MM-DD --role 技術");
    requireHuman("exception add");
    const r = role(opts);
    if (r !== "technical") fail("標準の例外は標準オーナー（--role 技術）が登録します");
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
    const rules = String(opts.rules ?? "").split(/[,\s]+/).filter(Boolean);
    const subject = String(opts.subject ?? "").trim();
    const reason = String(opts.reason ?? "").trim();
    const adr = String(opts.adr ?? "").trim();
    const reviewBy = String(opts["review-by"] ?? "").trim();
    if (!rules.length || !subject || !reason || !adr || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) fail("--rules・--subject・--reason・--adr・--review-by（YYYY-MM-DD）はすべて必要です");
    if (!existsSync(join(ctx.root, adr))) fail(`ADR ${adr} がありません（先に書く）`);
    const file = join(ctx.root, "docs", "exceptions.json");
    const doc = readJson(file, { exceptions: [] });
    doc.exceptions ??= [];
    const id = `EXC-${String(doc.exceptions.length + 1).padStart(3, "0")}`;
    const today = new Date().toLocaleDateString("sv-SE");
    doc.exceptions.push({ id, rules, subject, reason, adr, approvedBy: who.name, approvedAt: today, reviewBy });
    journalWrite(ctx, "docs/exceptions.json", `${JSON.stringify(doc, null, 2)}\n`, "exception add");
    recordDecision(ctx, { role: r, who, target: `標準の例外 ${id}（${rules.join(",")} / ${subject}）`, decision: "例外の承認", content: `${reason}（見直し ${reviewBy}、${adr}）`, delegateOf: owner.delegateOf, command: "exception add" });
    commitPaths(ctx, ["docs/exceptions.json", adr, "docs/decisions.md", ".devkit/journal.jsonl"], `devkit: 標準の例外 ${id} を承認`);
    out(`${id} を登録しました。pnpm standard:check で違反が消えたことを確かめてください`);
  },

  // Supervisor: ランナーの外側で、判断の後の自動の再開・障害の再試行・定時ブリーフィングを管理する
  async supervisor() {
    const [sub = "status"] = pos;
    if (sub === "run") {
      if (ctx.inWorker) fail("Supervisor はメインの作業ツリーで動かします");
      const sv = new Supervisor(ctx, { once: Boolean(opts.once) });
      await sv.loop();
      return;
    }
    if (sub === "start") {
      const a = supervisorAlive(ctx);
      if (a.alive) return out(`Supervisor はすでに動いています（pid ${a.lock?.pid}）`);
      mkdirSync(ctx.logs, { recursive: true });
      const logFile = join(ctx.logs, `supervisor-${localStamp()}.log`);
      const fd = openSync(logFile, "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervisor", "run"], { cwd: ctx.root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
      child.unref();
      return out(`Supervisor を切り離して起動しました（pid ${child.pid}）。常時動かすなら OS のサービスとして登録します（docs/rollout.md）。ログ: ${relative(ctx.root, logFile)}`);
    }
    if (sub === "stop") {
      const reason = pos.slice(1).join(" ") || "手動で停止";
      updateControls(
        ctx,
        (c) => {
          c.supervisor = { ...(c.supervisor ?? {}), stop: { reason, at: clockNow().toISOString() } };
        },
        { journal: "supervisor stop" },
      );
      if (!alive()) commitPaths(ctx, [".devkit/controls.json", ".devkit/journal.jsonl"], "devkit: Supervisor を手動で停止");
      return out(`Supervisor の自動の起動を止めました（${reason}）。実行中のランナーは止まりません（止めるなら pnpm devkit pause）。ブリーフィングは続けます。解除は標準オーナーが端末で pnpm devkit supervisor clear --role 技術 --note "…"`);
    }
    if (sub === "clear") {
      const r = role(opts);
      if (r !== "technical") fail("Supervisor の停止の解除は標準オーナー（--role 技術）が行います");
      const text = note(opts, true);
      const st = readSupervisorState(ctx);
      requireHuman("supervisor clear", { detail: `Supervisor の停止（${st.status}: ${st.reason || "—"}）を解除し、試行回数と今日の起動回数を数え直します` });
      const who = identity(ctx, opts.by);
      const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: text });
      updateControls(
        ctx,
        (c) => {
          c.supervisor = { stop: null, clear: { at: clockNow().toISOString(), by: who.name, email: who.email, note: text, from: st.status } };
        },
        { journal: "supervisor clear" },
      );
      recordDecision(ctx, { role: r, who, target: `Supervisor の停止の解除（${st.status}）`, decision: "解除", content: `${text}（停止の理由: ${st.reason || "—"}）`, delegateOf: owner.delegateOf, command: "supervisor clear" });
      if (!alive()) commitPaths(ctx, [".devkit/controls.json", ".devkit/journal.jsonl", "docs/decisions.md"], "devkit: Supervisor の停止を解除");
      return out("解除しました。Supervisor は次の照合で、起動してよいかを確かめ直します");
    }
    if (sub !== "status") fail("使い方: supervisor run [--once] | start | status [--json] | stop [理由] | clear --role 技術 --note …");
    const st = readSupervisorState(ctx);
    const svAlive = supervisorAlive(ctx);
    const box = outboxEntries(ctx);
    let next = null;
    try {
      const sv = new Supervisor(ctx, { log: () => {} });
      sv.load();
      sv.dryRun = true;
      next = SUPERVISOR_STOPS.includes(st.status) ? null : sv.evaluate(clockNow());
    } catch (e) {
      next = { start: false, status: "error", reason: e.message };
    }
    const info = { alive: svAlive.alive, pid: svAlive.lock?.pid ?? null, status: st.status, reason: st.reason, since: st.since, retry: st.current, day: st.day, noProgress: st.noProgress, briefing: st.briefing, outbox: box.map((e) => ({ deadline: e.deadline, status: e.status, attempts: e.attempts, lastError: e.lastError })), next };
    if (opts.json) return out(JSON.stringify(info, null, 2));
    out(`Supervisor: ${svAlive.alive ? `動いている（pid ${svAlive.lock?.pid}）` : "動いていない"}／状態 ${st.status}${st.reason ? `: ${st.reason}` : ""}`);
    if (st.current) out(`再試行: ${st.current.kind} ${st.current.attempt} 回目、${st.current.nextAt} に`);
    out(`今日の自動起動: ${st.day?.runs ?? 0} 回／進捗なしで続いた起動: ${st.noProgress ?? 0} 回`);
    if (st.briefing?.file) out(`最後のブリーフィング: ${st.briefing.file}`);
    for (const e of box.slice(-3)) out(`配信 ${e.deadline}: ${e.status}${e.lastError ? `（${e.lastError}）` : ""}`);
    if (next) out(`次の照合での判断: ${next.start ? `ランナーを起動する（${next.reason}）` : `${next.stop ?? next.status}: ${next.reason}`}`);
    if (SUPERVISOR_STOPS.includes(st.status)) out("解除は、原因を直してから標準オーナーが端末で pnpm devkit supervisor clear --role 技術 --note \"…\"");
  },

  // 記録（state.json・controls.json・exceptions.json）が devkit のコマンドとランナーの書いたものか。
  // seal accept: 標準オーナーが内容を確かめた上で受け入れる（journal に残し、判断の記録に書く）。人が端末で
  seal() {
    const [sub] = pos;
    const prev = readJson(ctx.runFile, null);
    const files = () => [...new Set([...(journalProblem(ctx) ? [".devkit/journal.jsonl"] : []), ...committedUnexplained(ctx, prev), ...uncommittedUnexplained(ctx, prev)])];
    if (sub !== "accept") {
      const bad = files();
      const jp = journalProblem(ctx);
      return out(bad.length ? `devkit のコマンドとランナーが書いたものと合わない記録: ${bad.join(", ")}${jp ? `（${jp}）` : ""}（git log -p で確かめ、正しければ標準オーナーが pnpm devkit seal accept --role 技術 --note "…"）` : "記録はすべて devkit のコマンドとランナーが書いたものです");
    }
    const r = role(opts);
    if (r !== "technical") fail("記録の受け入れは標準オーナー（--role 技術）が行います");
    const text = note(opts, true);
    const bad = files();
    if (!bad.length) return out("受け入れが要る記録はありません");
    requireHuman("seal accept", { detail: `次の記録の今の内容を、正しいものとして受け入れます: ${bad.join(", ")}` });
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: text });
    updateAnchor(ctx, { force: true });
    journal(ctx, "seal accept", bad.filter((f) => f !== ".devkit/journal.jsonl").concat([".devkit/state.json", ".devkit/controls.json"]).filter((f, i, a) => a.indexOf(f) === i));
    recordDecision(ctx, { role: r, who, target: `記録の受け入れ（${bad.join(", ")}）`, decision: "受け入れ", content: text, delegateOf: owner.delegateOf, command: "seal accept" });
    commitPaths(ctx, [...bad, ".devkit/journal.jsonl", "docs/decisions.md"], "devkit: 記録の受け入れ");
    out(`受け入れました: ${bad.join(", ")}`);
  },

  // 判断の記録に1行残す（devkit の更新・手での運用の判断など）。人が端末で
  record() {
    requireHuman("record");
    const r = role(opts);
    const who = identity(ctx, opts.by);
    const owner = checkOwner(ctx, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
    const target = typeof opts.target === "string" ? opts.target.trim() : "";
    const decision = typeof opts.decision === "string" ? opts.decision.trim() : "";
    if (!target || !decision) fail('使い方: record --role <業務|技術> --target "<対象>" --decision "<判断>" [--note "<内容>"]');
    recordDecision(ctx, { role: r, who, target, decision, content: note(opts), delegateOf: owner.delegateOf, command: "record" });
    commitPaths(ctx, ["docs/decisions.md", ".devkit/journal.jsonl"], `devkit: 判断の記録（${target}）`.slice(0, 120));
    out("判断の記録（docs/decisions.md）に残しました");
  },

  archive() {
    const g = loadGraph(ctx, { required: false });
    if (!g) return out("片付ける計画はありません");
    const s = loadState(ctx, g);
    if (s.outer !== "done" && s.outer !== "idle") requireHuman("archive");
    if (alive()) fail("ランナーが実行中です");
    const base = join(ctx.dir, "archive", `${localStamp()}-${(g.branch ?? "mission").replace(/[^A-Za-z0-9-]+/g, "-")}`);
    mkdirSync(base, { recursive: true });
    for (const f of ["mission.md", "graph.json", "graph.md", "state.json", "controls.json", "progress.md", "requests", "proposals", "evidence", "reports"]) {
      const p = join(ctx.dir, f);
      if (existsSync(p)) renameSync(p, join(base, f));
    }
    appendProgress(ctx, `前のミッションを ${relative(ctx.root, base)} に移しました`);
    commitPaths(ctx, [".devkit"], "devkit: archive");
    out(`片付けました: ${relative(ctx.root, base)}`);
  },

  // SessionStart フック: 状況を短く Claude に伝える
  brief() {
    const st = computeStatus(ctx);
    if (!st.hasPlan) {
      out("[devkit] 計画（.devkit/graph.json）はまだありません。開発の指示を受けたら、コードを書く前に devkit-kickoff スキルで仕様と計画を作ってください。");
      return;
    }
    const msgs = [`[devkit] ${statusText(st).split("\n").slice(0, 4).join(" ／ ")}`];
    if (st.runner.alive) msgs.push("ランナーが実行中。このセッションでは計画・テスト・設定ファイルを変更しない（状況の確認と案内だけ）。");
    else if (st.outer === "running" && !st.waitingFor.length) msgs.push("計画は進行中で、ランナーが止まっている。利用者に確認してから pnpm devkit run で再開する（devkit-run スキル）。");
    if (st.waitingFor.length) msgs.push("人の判断待ちがある。承認・差し戻し・回答は人が端末で行う（Claude からは実行できない）。devkit-gate-review スキルで確認を手伝う。");
    out(msgs.join("\n"));
  },
};

function readTextSafe(p) {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function writeTextSafe(p, t) {
  writeText(p, t);
}

async function main() {
  const handler = commands[cmd];
  if (!handler) fail(`知らないコマンドです: ${cmd}（使い方は scripts/devkit/devkit.mjs の先頭）`);
  if (ctx.inWorker && MUTATING.has(cmd)) fail("作業用の場所（ランナーの作業ディレクトリ・取り出し）の中からは devkit の状態を変えられません（結果は報告に書く）");
  if (process.env.DEVKIT_ROLE && MUTATING.has(cmd)) fail("ランナーが起動した AI は devkit の状態を変えられません（結果は構造化出力で報告する）");
  await handler();
}

main().catch((e) => {
  if (cmd === "brief") process.exit(0); // フックは邪魔をしない
  console.error(`[devkit] ${e instanceof DevkitError ? e.message : e.stack || e.message}`);
  process.exitCode = e instanceof DevkitError ? e.code : 1;
});
