// ランナー: 計画を実行する決定的な制御部分。判断の分岐はすべてここ（コード）にあり、AI が受け持つのは
// 実装（implementer）・レビュー（reviewer / final-reviewer）・再計画の案（replanner）だけ。
//
// 1回の起動でやること:
//   準備（ロック・設定と隔離の確認・状態の照合・中断した作業の復旧・封印） → 次の作業を選ぶ → 作業ごとに、リポジトリの外の
//   作業ディレクトリで「AI が実装 → ランナーがファイルを取り込んでコミット → 機械検証（検証コマンドはコンテナの中） →
//   別の AI がレビュー → 証拠を対象コミットに紐づけ」 → クリーンにマージできるものだけ順に統合 → 統合後の機械検証
//   （失敗なら取り消し） → マイルストーンの全体検証 → 人間ゲート（必要な承認者を計画と変更内容から決める） → … → 全マイルストーン完了
// 止まる条件: 人の判断待ち、一時停止、時間・費用・サイクルの上限、2回続けて進捗なし、再計画の上限、環境の問題、改ざんの検出。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeRole, ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import { finalReviewerPrompt, implementerPrompt, replannerPrompt, reviewerPrompt, runAgent } from "./agents.mjs";
import { commitArgs, currentBranch, dirtyFiles, git, headSha } from "./git.mjs";
import { cleanupContainers, engineInfo, ensureImage, imageFor, isolationConfig, projectKey } from "./isolation.mjs";
import {
  applyHumanDecisions,
  classifyPlanChange,
  configProblems,
  proposalRoles,
  decide,
  isApproved,
  loadConfig,
  loadControls,
  loadGraph,
  loadState,
  normalizeGraph,
  pendingRoles,
  planApproved,
  planHash,
  progressSignature,
  ratchetGate,
  requestId,
  resetForReplan,
  saveState,
  syncState,
  updateControls,
  validate,
} from "./model.mjs";
import { notify } from "./notify.mjs";
import { writeGateReport, writeRunReport, writeStatusHtml } from "./report.mjs";
import { Seal, uncommittedUnexplained } from "./seal.mjs";
import { acquireLock, appendProgress, RunInfo, releaseLock } from "./status.mjs";
import { fail, localStamp, nowIso, readJson, readText, writeJson, writeText } from "./util.mjs";
import {
  checkout,
  checkoutState,
  codeKey,
  collectWork,
  integrityNode,
  pruneWork,
  prepareImplDir,
  removeCheckout,
  removeImplDir,
  runChecker,
  runCommand,
  snapshot,
  summarizeIntegrity,
  tracedIds,
} from "./verify.mjs";

export const EXIT = { ok: 0, preflight: 1, env: 2, stalled: 3, busy: 4, tamper: 5 };

export async function run(ctx, opts = {}) {
  const r = new Runner(ctx, opts);
  return r.main();
}

// 停止条件の値（--until HH:MM、--max-hours、--max-cost-usd）。おかしな値は黙って無視せずに断る
export function parseRunLimits(opts = {}) {
  const out = { until: null, maxHours: null, maxCostUsd: null };
  if (opts.until !== undefined && opts.until !== null && opts.until !== false) {
    const m = String(opts.until).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) fail(`--until は HH:MM（24時間制。例: 07:00）で指定してください（${opts.until}）`);
    out.until = { h: Number(m[1]), m: Number(m[2]), text: String(opts.until) };
  }
  for (const [k, name] of [
    ["maxHours", "--max-hours"],
    ["maxCostUsd", "--max-cost-usd"],
  ]) {
    const v = opts[k];
    if (v === undefined || v === null || v === false) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || v === true) fail(`${name} は正の数で指定してください（${v}）`);
    out[k] = n;
  }
  return out;
}

// Claude Code のサンドボックスが使えるか（aiSandbox: required のとき）
export function sandboxProblem(config) {
  if (config.aiSandbox !== "required") return null;
  if (process.platform === "win32") return "Windows ネイティブでは Claude Code のサンドボックスを使えません。WSL2 で動かすか、.devkit/config.json の aiSandbox を off にしてください";
  if (process.platform === "linux") {
    for (const bin of ["bwrap", "socat"]) {
      if (spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status !== 0)
        return `${bin} がありません（sudo apt-get install bubblewrap socat）。入れられない場合は .devkit/config.json の aiSandbox を off にしてください（AI のコマンドが作業ディレクトリの外にも書けるようになります）`;
    }
  }
  return null;
}

class Runner {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.opts = opts;
    this.config = loadConfig(ctx);
    ctx.installCommand = this.config.installCommand;
    this.startedAt = Date.now();
    this.stamp = localStamp();
    this.logDir = join(ctx.logs, `run-${this.stamp}`);
    this.events = [];
    this.stop = null; // { reason, code }
    this.seal = new Seal(ctx);
    this.tampered = null;
  }

  log(text) {
    const line = `[devkit run] ${text}`;
    if (!this.opts.quiet) console.log(line);
    appendProgress(this.ctx, text);
    this.events.push({ at: nowIso(), text });
    this.info?.set({ lastEvent: text });
  }

  async notify(role, message) {
    await notify({ role, message, project: this.g?.mission ?? "", onResult: (r) => !r.sent && r.reason !== "送り先が設定されていない" && appendProgress(this.ctx, `通知を送れませんでした: ${r.reason}`) });
  }

  reload() {
    this.g = loadGraph(this.ctx);
    this.s = loadState(this.ctx, this.g);
    this.c = loadControls(this.ctx);
  }

  save() {
    if (this.tampered) return;
    syncState(this.g, this.s);
    saveState(this.ctx, this.s);
    this.seal.note(".devkit/state.json");
    this.info?.set({ sealed: this.seal.toJSON() });
    try {
      writeStatusHtml(this.ctx);
    } catch {}
  }

  // controls.json の変更（ランナー自身）。書く前に、人のコマンド以外から変わっていないかを確かめる
  controls(fn) {
    const r = updateControls(this.ctx, (c) => {
      const bad = this.seal.check().filter((b) => b.path === ".devkit/controls.json");
      if (bad.length) throw Object.assign(new Error("controls.json が人のコマンド以外から変わっている"), { tamper: bad });
      return fn(c);
    });
    this.seal.note(".devkit/controls.json");
    this.c = loadControls(this.ctx);
    return r;
  }

  commitState(message) {
    if (this.tampered) return;
    if (this.checkSeal()) return;
    git(this.ctx.root, ["add", "-A", "--", ".devkit", "docs/decisions.md"]);
    const staged = git(this.ctx.root, ["diff", "--cached", "--name-only"]).out;
    if (staged) git(this.ctx.root, commitArgs(this.ctx.root, message));
  }

  head() {
    return headSha(this.ctx.root);
  }

  // 封印を確かめ、改ざんがあれば止める（true を返す）
  checkSeal() {
    if (this.tampered) return true;
    const bad = this.seal.check();
    if (!bad.length) return false;
    this.tampered = bad;
    this.stop = { reason: `保護されたファイルが、ランナーと人のコマンド以外から変わった: ${bad.map((b) => b.path).slice(0, 6).join(", ")}`, code: EXIT.tamper };
    this.log(this.stop.reason);
    return true;
  }

  // ---------- 起動 ----------

  preflight() {
    const { ctx, config } = this;
    if (ctx.inWorker) fail("ランナーはメインの作業ツリーで起動します（作業用の場所の中からは起動しない）");
    this.limits = parseRunLimits(this.opts);
    const cp = configProblems(config);
    if (cp.length) fail(`.devkit/config.json に問題があります:\n${cp.map((p) => `  - ${p}`).join("\n")}`);
    this.reload();
    const { errors } = validate(ctx, this.g, { controls: this.c });
    if (errors.length) fail(`計画に問題があります（pnpm devkit check で確認）:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.finishPendingReplan();
    const plan = planApproved(ctx, this.c);
    if (!plan.ok)
      fail(
        plan.changedAfterApproval
          ? "計画（graph.json・仕様書・mission.md）が承認の後に変わっています。人が内容を確かめ、端末で pnpm devkit approve plan --role business と --role technical を実行してください"
          : `計画が承認されていません。端末で ${plan.pending.map((r) => `pnpm devkit approve plan --role ${r}`).join(" と ")} を実行してください`,
      );
    if (this.s.outer === "idle") fail("まだ開始していません。pnpm devkit start で開始してください");
    if (this.s.outer === "done") return "done";
    if (this.s.outer !== "running") fail(`状態が ${this.s.outer} です（${this.s.reason}）。理由を確かめてから pnpm devkit resume で再開してください`);
    const branch = currentBranch(ctx.root);
    if (branch !== this.g.branch) fail(`統合ブランチ ${this.g.branch} にいません（今は ${branch || "detached"}）。git switch ${this.g.branch} してから起動してください`);
    const dirty = dirtyFiles(ctx.root).filter((f) => !f.startsWith(".devkit/") && f !== "docs/decisions.md");
    if (dirty.length) fail(`未コミットの変更があります: ${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? " ほか" : ""}。コミットするか片付けてから起動してください`);
    const unexplained = uncommittedUnexplained(ctx, readJson(ctx.runFile, null));
    if (unexplained.length)
      fail(
        `devkit のコマンドの記録と合わない未コミットの変更があります: ${unexplained.join(", ")}。git diff で内容を確かめ、正しければ人がコミットし、でなければ git checkout -- <ファイル> で戻してから起動してください`,
      );
    if (!existsSync(ctx.checker)) fail("標準チェッカー（scripts/standard/check.mjs）がありません。/devkit:update で実行部品を入れ直してください");
    const sb = sandboxProblem(config);
    if (sb) fail(`AI のサンドボックスを使えません: ${sb}`);
    const iso = isolationConfig(config);
    if (iso.mode === "container") {
      const info = engineInfo(iso);
      if (!info.ok) fail(`検証用のコンテナ（${iso.engine}）を使えません: ${info.reason}。Docker か Podman を動かすか、隔離なしで回すなら人が .devkit/config.json の isolation.mode を none にします（推奨しない）`, EXIT.env);
    }
    const lock = acquireLock(ctx);
    if (lock !== true) fail(`別のランナーが実行中です（pid ${lock.busy?.pid}、${lock.busy?.host ?? ""}）。状況は pnpm devkit status`, EXIT.busy);
    return "ok";
  }

  // 再計画を書いている途中で落ちた: graph.json が新しい案のとおりなら承認済みのハッシュを進め、そうでなければ案を捨てる
  finishPendingReplan() {
    const pr = this.c.pendingReplan;
    if (!pr) return;
    const hash = planHash(this.ctx);
    updateControls(this.ctx, (c) => {
      if (hash === pr.hash) {
        c.plan.approvedHash = hash;
        c.plan.history.push({ type: "auto-replan", id: pr.id, hash, at: nowIso(), summary: pr.summary, decisions: pr.decisions ?? [], recovered: true });
      }
      c.pendingReplan = null;
    }, { journal: "recover-replan" });
    this.c = loadControls(this.ctx);
    appendProgress(this.ctx, hash === pr.hash ? `中断していた再計画 ${pr.id} の記録を完了しました` : `中断していた再計画 ${pr.id} は計画に入っていなかったので捨てました`);
  }

  async main() {
    let pre;
    try {
      pre = this.preflight();
    } catch (e) {
      if (!this.opts.quiet) console.error(`[devkit run] ${e.message}`);
      return e.code === EXIT.busy ? EXIT.busy : e.code === EXIT.env ? EXIT.env : EXIT.preflight;
    }
    if (pre === "done") {
      console.log("[devkit run] ミッションは完了しています");
      return EXIT.ok;
    }
    this.seal.start();
    this.info = new RunInfo(this.ctx, { logDir: this.logDir, cycle: this.s.cycle, sealed: this.seal.toJSON() });
    this.info.start();
    mkdirSync(this.logDir, { recursive: true });
    const onSignal = (sig) => {
      this.stop ??= { reason: `シグナル ${sig} を受け取った（実行中の作業が終わり次第止める）`, code: EXIT.ok };
      this.interrupted = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let code = EXIT.ok;
    try {
      this.log(`ランナー開始（pid ${process.pid}${this.limits.until ? `、${this.limits.until.text} まで` : ""}、検証: ${isolationConfig(this.config).mode === "container" ? "コンテナ" : "隔離なし"}、AI のサンドボックス: ${this.config.aiSandbox}）`);
      await this.notify(null, "ランナーを開始しました");
      await this.recover();
      if (!this.stop) await this.baseline();
      while (!this.stop) await this.step();
      code = this.stop.code;
    } catch (e) {
      if (e.tamper) {
        this.tampered = e.tamper;
        this.stop = { reason: `保護されたファイルが、ランナーと人のコマンド以外から変わった: ${e.tamper.map((b) => b.path).join(", ")}`, code: EXIT.tamper };
      } else this.stop = { reason: `ランナーのエラー: ${e.message}`, code: EXIT.env };
      code = this.stop.code;
      this.log(this.stop.reason);
      if (process.env.DEVKIT_DEBUG) console.error(e);
    } finally {
      try {
        const keep = this.tampered ? [] : Object.values(this.s?.nodes ?? {}).filter((ns) => ns.resume && ns.implDir).map((ns) => ns.implDir);
        pruneWork(this.ctx, this.config, { keep, keepImpl: Boolean(this.tampered) });
        if (this.tampered) {
          this.writeTamperReport();
        } else {
          this.reload();
          this.s.usage = this.s.usage ?? { costUsd: 0, turns: 0 };
          this.save();
        }
        const report = writeRunReport(this.ctx, { startedAt: new Date(this.startedAt).toISOString(), stamp: this.stamp, stop: this.stop, events: this.events, usage: this.info.data.usage });
        this.info.stop(this.stop?.reason ?? "");
        this.log(`ランナー終了: ${this.stop?.reason ?? ""}（まとめ: ${report}）`);
        try {
          writeStatusHtml(this.ctx);
        } catch {}
        this.commitState(`devkit: ランナー終了（${this.stop?.reason ?? ""}）`.slice(0, 120));
        await this.notify(this.stop?.code === EXIT.ok ? null : "technical", `ランナーが止まりました: ${this.stop?.reason ?? ""}（まとめ: ${report}）`);
      } finally {
        releaseLock(this.ctx);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    return code;
  }

  writeTamperReport() {
    const file = join(this.ctx.reports, `tamper-${this.stamp}.md`);
    const diff = git(this.ctx.root, ["status", "--porcelain"]).out;
    writeText(
      file,
      [
        "# 保護されたファイルの変更を検出して止まりました",
        "",
        "承認・計画・判断の記録・devkit 自身のファイルが、ランナーと人のコマンド（approve など）以外から変わりました。",
        "ランナーはこの状態をコミットしていません。人が内容を確かめてください。",
        "",
        "| ファイル | 期待した内容 | 今の内容 |",
        "| --- | --- | --- |",
        ...this.tampered.map((b) => `| ${b.path} | ${b.expected} | ${b.actual} |`),
        "",
        "## 作業ツリーの状態（git status）",
        "",
        "```",
        diff || "（変更なし）",
        "```",
        "",
        "## 次にすること",
        "",
        "1. `git diff` で何が変わったかを確かめる。",
        "2. 正しい変更なら人がコミットする。そうでなければ `git checkout -- <ファイル>` で戻す。",
        "3. 原因（隔離なしの設定・サンドボックスの無効化・手での編集など）を取り除いてから `pnpm devkit run`。",
        "",
      ].join("\n"),
    );
    return file;
  }

  // 中断した作業を照合して、安全に続けられる状態に戻す
  async recover() {
    const { ctx } = this;
    let changed = false;
    const iso = isolationConfig(this.config);
    const n = cleanupContainers(iso, projectKey(ctx).toLowerCase().replace(/[^a-z0-9_.-]/g, "-"));
    if (n) this.log(`前回のランナーが残した検証用のコンテナ ${n} 個を片付けました`);
    if (existsSync(join(ctx.root, ".git", "MERGE_HEAD"))) {
      changed = true;
      git(ctx.root, ["merge", "--abort"]);
      this.log("中断していたマージを取り消しました");
    }
    const pm = this.s.pendingMerge;
    if (pm) {
      if (this.head() !== pm.pre) {
        const r = git(ctx.root, ["reset", "--keep", pm.pre]);
        this.log(r.code === 0 ? `統合後の検証の前に中断した ${pm.node} のマージを取り消しました（もう一度統合する）` : `中断したマージを戻せませんでした: ${r.err}`);
        if (r.code !== 0) throw new Error("中断したマージを安全に戻せません。人が git log で状態を確かめてください");
      }
      this.s.pendingMerge = null;
      changed = true;
    }
    const keep = [];
    for (const node of this.g.nodes) {
      const ns = this.s.nodes[node.id];
      if (ns.status === "running") {
        changed = true;
        const hasBranch = ns.branch && git(ctx.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${ns.branch}`]).code === 0;
        ns.status = "pending";
        ns.resume = Boolean(hasBranch);
        this.log(`${node.id}: 前回の実行が途中で止まっていた。${hasBranch ? "同じブランチの続きから再開する" : "最初からやり直す"}`);
      }
      if (ns.resume && ns.implDir) keep.push(ns.implDir);
    }
    for (const m of this.g.milestones) {
      const ms = this.s.milestones[m.id];
      if (ms.status === "verifying") {
        ms.status = "active";
        changed = true;
      }
    }
    pruneWork(ctx, this.config, { keep });
    // v4.0 の、リポジトリの中の worktree が残っていれば片付ける
    if (existsSync(ctx.legacyWorktrees)) {
      rmSync(ctx.legacyWorktrees, { recursive: true, force: true });
      git(ctx.root, ["worktree", "prune"]);
    }
    if (changed) {
      this.save();
      this.commitState("devkit: 中断からの復旧");
    }
  }

  // ミッションの起点と、比較の基準になるテストの棚卸し
  async baseline() {
    const head = this.head();
    if (!this.s.missionBase) this.s.missionBase = head;
    this.info.set({ phase: "開始時点の検証" });
    if (isolationConfig(this.config).mode === "container") {
      const pkg = readJson(join(this.ctx.root, "package.json"), {}) ?? {};
      const image = imageFor(isolationConfig(this.config), pkg);
      const img = await ensureImage(isolationConfig(this.config), image, { logFile: join(this.logDir, "image-pull.log") });
      if (!img.ok) {
        this.stop = { reason: `環境の問題で止まりました: ${img.reason}`, code: EXIT.env };
        this.log(this.stop.reason);
        return;
      }
    }
    const snap = await snapshot(this.ctx, this.config, this.g, { head, logDir: this.logDir, label: "baseline" });
    if (snap.envError) {
      this.stop = { reason: `環境の問題で止まりました: ${snap.reason}`, code: EXIT.env };
      this.log(this.stop.reason);
      return;
    }
    if (!snap.ok) {
      this.stop = { reason: `開始時点のコードで検証が通りません（雛形・環境を確かめる）: ${snap.failures[0]?.split("\n")[0] ?? ""}`, code: EXIT.env };
      this.log(this.stop.reason);
      return;
    }
    this.s.lastSnapshot = head;
    this.save();
  }

  limitReached() {
    const { limits } = this;
    if (this.interrupted) return this.stop?.reason;
    if (limits.until) {
      const end = new Date(this.startedAt);
      end.setHours(limits.until.h, limits.until.m, 0, 0);
      if (end.getTime() <= this.startedAt) end.setDate(end.getDate() + 1);
      if (Date.now() >= end.getTime()) return `終了時刻 ${limits.until.text} になった`;
    }
    if (limits.maxHours && Date.now() - this.startedAt >= limits.maxHours * 3600_000) return `${limits.maxHours} 時間に達した`;
    if (limits.maxCostUsd && (this.info.data.usage.costUsd ?? 0) >= limits.maxCostUsd) return `費用の上限 $${limits.maxCostUsd} に達した`;
    return null;
  }

  // ---------- 1手 ----------

  async step() {
    if (this.checkSeal()) return;
    this.reload();
    // 人の決定（承認・差し戻し・回答・再計画の案の承認・一時停止）を状態に反映する。
    // 計画の承認も同じロックの中で確かめる（人のコマンドが計画と承認を書いている途中を見ないように）
    const { notes, plan } = this.controls((c) => {
      this.g = loadGraph(this.ctx);
      syncState(this.g, this.s);
      return { notes: applyHumanDecisions(this.g, this.s, c), plan: planApproved(this.ctx, c) };
    });
    if (notes.length) {
      for (const n of notes) this.log(n);
      this.save();
      this.commitState("devkit: 人の判断を反映");
    }
    if (this.s.outer !== "running") {
      this.stop = { reason: `${this.s.outer === "paused" ? "一時停止" : this.s.outer}: ${this.s.reason}`, code: EXIT.ok };
      return;
    }
    const limit = this.limitReached();
    if (limit) {
      this.stop = { reason: limit, code: EXIT.ok };
      return;
    }
    if (!plan.ok) {
      this.stop = { reason: "計画が承認の後に変わった（人の承認が要る）", code: EXIT.ok };
      await this.notify("technical", "計画（graph.json・仕様書）が承認の後に変わったため止まりました。内容を確かめて pnpm devkit approve plan を実行してください");
      return;
    }
    const maxCycles = this.c.maxCycles ?? this.g.limits.maxCycles;
    const d = decide(this.g, this.s, this.c);
    const before = progressSignature(this.g, this.s, this.c, codeKey(this.ctx, this.head()));

    if (d.allDone) return this.finishMission();
    if (d.readyToMerge.length) {
      await this.mergeAll(d.readyToMerge);
    } else if (d.verifyMilestone) {
      await this.verifyMilestone(d.verifyMilestone);
    } else if (d.ready.length) {
      // 判断待ち・再計画待ちの作業があっても、依存しない作業は先に進める
      if (this.s.cycle >= maxCycles) {
        this.s.outer = "paused";
        this.s.reason = `サイクル上限（${maxCycles}）に達した`;
        this.save();
        this.stop = { reason: this.s.reason, code: EXIT.ok };
        await this.notify("technical", `${this.s.reason}。続けるなら端末で pnpm devkit resume --add-cycles <N>`);
        return;
      }
      await this.runCycle(d.ready);
    } else if (d.replan.length) {
      await this.replan(d.replan);
    } else if (d.waiting.approvals.length || d.waiting.answers.length || d.waiting.proposals.length) {
      const who = [...new Set([...d.waiting.approvals.flatMap((a) => a.roles), ...d.waiting.answers.map((a) => a.role), ...d.waiting.proposals.flatMap((p) => p.roles ?? ["technical"])])];
      this.stop = { reason: `人の判断待ち（${who.map((r) => ROLE_PERSON[r]).join("・")}）`, code: EXIT.ok };
      return;
    } else {
      this.s.outer = "stalled";
      this.s.reason = "実行できる作業も、判断待ちもない（計画を確かめる）";
      this.save();
      this.stop = { reason: this.s.reason, code: EXIT.stalled };
      await this.notify("technical", `止まりました: ${this.s.reason}`);
      return;
    }
    if (this.stop) return;
    // 2回続けて進捗がなければ止める（状態のコミットでは変わらない、コードの中身と状態で比べる）
    this.reload();
    const after = progressSignature(this.g, this.s, this.c, codeKey(this.ctx, this.head()));
    this.s.stall = after === before ? (this.s.stall ?? 0) + 1 : 0;
    if (this.s.stall >= 2) {
      this.s.outer = "stalled";
      this.s.reason = "2回続けて進捗がない（計画・goal の見直しが必要）";
      this.stop = { reason: this.s.reason, code: EXIT.stalled };
      await this.notify("technical", `止まりました: ${this.s.reason}`);
    }
    this.save();
  }

  // ---------- 作業（ノード） ----------

  async runCycle(nodes) {
    this.s.cycle += 1;
    this.info.set({ cycle: this.s.cycle, phase: "作業中" });
    this.log(`サイクル ${this.s.cycle}: ${nodes.map((n) => n.id).join(", ")} を実行`);
    for (const n of nodes) {
      const ms = this.s.milestones[n.milestone];
      if (ms.status === "pending") {
        ms.status = "active";
        ms.base = this.head();
      }
    }
    this.save();
    this.commitState(`devkit: サイクル ${this.s.cycle} 開始`);
    const results = await Promise.all(nodes.map((n) => this.runNode(n).catch((e) => ({ id: n.id, kind: "error", error: e }))));
    for (const r of results) {
      if (r.kind === "error") {
        if (r.error?.tamper) throw r.error;
        const ns = this.s.nodes[r.id];
        ns.status = "pending";
        ns.note = `ランナーのエラーで中断: ${r.error.message}`;
        this.log(`${r.id}: ランナーのエラー ${r.error.message}`);
      }
    }
    this.save();
    if (this.checkSeal()) return;
    const env = results.find((r) => r.kind === "env");
    const ready = nodes.filter((n) => this.s.nodes[n.id].status === "ready_to_merge");
    if (ready.length && !env) await this.mergeAll(ready);
    if (env) {
      this.stop = { reason: `環境の問題で止まりました: ${env.reason}`, code: EXIT.env };
      await this.notify("technical", `${this.stop.reason}（ログ: ${this.logDir}）`);
    }
    this.save();
    this.commitState(`devkit: サイクル ${this.s.cycle} 結果`);
  }

  async runNode(n) {
    const { ctx, g, config } = this;
    const ns = this.s.nodes[n.id];
    const resume = Boolean(ns.resume && ns.branch && ns.base);
    if (!resume) {
      ns.attempts += 1;
      ns.base = this.head();
      ns.branch = `${g.branch}--${n.id}-a${ns.attempts}`;
      ns.roundsDone = 0;
    }
    ns.resume = false;
    ns.status = "running";
    ns.startedAt = nowIso();
    const attempt = ns.attempts;
    const name = `${n.id}-a${attempt}`;
    const { path: wt } = prepareImplDir(ctx, config, { name, branch: ns.branch, base: ns.base, resume });
    ns.implDir = wt;
    this.save();
    const envStop = (reason) => {
      ns.status = "pending";
      ns.resume = true;
      this.info.task(n.id, null);
      return { id: n.id, kind: "env", reason };
    };
    this.info.task(n.id, { step: "準備", round: ns.roundsDone });
    const install = await runCommand(this.config.installCommand, { cwd: wt, timeoutMs: 20 * 60_000, logFile: join(this.logDir, `${name}-install.log`) });
    if (install.code !== 0) return envStop(`${n.id} の作業ディレクトリで依存をインストールできなかった（ネットワーク・pnpm を確かめる）`);
    let feedback = ns.feedback ?? "";
    let tipBefore = git(ctx.root, ["rev-parse", `refs/heads/${ns.branch}`]).out || ns.base;
    const learnings = readText(ctx.learnings).split("\n").filter((l) => /^\s*-\s/.test(l) && !/まだありません/.test(l)).join("\n");
    const finishNode = (status, extra = {}) => {
      Object.assign(ns, { status, ...extra });
      this.info.task(n.id, null);
      removeImplDir(wt);
      ns.implDir = null;
      return { id: n.id, kind: status === "ready_to_merge" ? "ready" : status };
    };
    for (let round = (ns.roundsDone ?? 0) + 1; round <= g.limits.maxRounds; round++) {
      ns.round = round;
      this.save();
      // 1) 実装（AI。作業ディレクトリの中だけ）
      this.info.task(n.id, { step: "実装", round });
      const impl = await runAgent({
        ctx,
        config,
        role: "implementer",
        cwd: wt,
        prompt: implementerPrompt({ g, node: n, round: { attempt, round }, base: ns.base, branch: ns.branch, feedback, note: ns.note, resume: resume && round === (ns.roundsDone ?? 0) + 1, learnings }),
        logFile: join(this.logDir, `c${this.s.cycle}-${name}-r${round}-implementer.jsonl`),
        timeoutMs: g.limits.taskTimeoutMinutes * 60_000,
        budgetUsd: this.config.budgetUsd?.implementer ?? g.limits.taskBudgetUsd,
        env: { DEVKIT_NODE: n.id },
      });
      this.usage(impl);
      if (this.checkSeal()) return finishNode("pending", { resume: true });
      if (impl.envError) return envStop(impl.envReason);
      const out = impl.output ?? {};
      if (out.status === "blocked" || out.status === "needs_human") {
        if (out.request?.type) {
          this.info.task(n.id, null);
          removeImplDir(wt);
          ns.implDir = null;
          return this.blockWithRequest(n, out.request, out.summary);
        }
        this.log(`${n.id}: 実装者が止まった: ${out.needs || out.summary || "理由の記載なし"}`);
        return finishNode("failed", { note: `実装者が止まった: ${out.needs || out.summary || "理由の記載なし"}` });
      }
      // 2) 作業ディレクトリのファイルを取り込んでコミットし、検証の対象を固定（ランナー）
      const got = collectWork(ctx, config, wt, { branch: ns.branch, parent: tipBefore, message: `devkit(${n.id}): ラウンド ${round}` });
      if (!got.ok) {
        feedback = `ランナーが変更を取り込めなかった（ラウンド ${round}）: ${got.error}`;
        ns.roundsDone = round;
        ns.history.push({ at: nowIso(), attempt, round, tip: null, integrity: false, failures: [got.error], impl: (out.summary ?? "").slice(0, 400) });
        this.log(`${n.id}: ラウンド ${round} 変更を取り込めなかった`);
        continue;
      }
      const tip = got.tip;
      tipBefore = tip;
      // 3) 機械検証（ランナー。検証コマンドはコンテナの中）
      this.info.task(n.id, { step: "機械検証", round });
      const ev = await integrityNode(ctx, config, g, n, { base: ns.base, tip, logDir: this.logDir, label: `c${this.s.cycle}-${name}-r${round}` });
      if (ev.envError) return envStop(ev.reason);
      if (this.checkSeal()) {
        removeCheckout(ctx, ev.checkout);
        return finishNode("pending", { resume: true });
      }
      ns.roundsDone = round;
      ns.history.push({ at: nowIso(), attempt, round, tip, integrity: ev.ok, failures: ev.failures.slice(0, 20), impl: (out.summary ?? "").slice(0, 400) });
      if (!ev.ok) {
        removeCheckout(ctx, ev.checkout);
        feedback = `ランナーの機械検証で不合格（ラウンド ${round}）:\n${ev.failures.map((f) => `- ${f}`).join("\n")}`;
        this.log(`${n.id}: ラウンド ${round} 機械検証で不合格（${ev.failures.length} 件）`);
        continue;
      }
      // 4) 独立レビュー（別の AI、読み取り専用、対象コミットのクリーンな取り出しで）
      this.info.task(n.id, { step: "レビュー", round });
      let review = null;
      for (let tries = 0; tries < 2 && !review; tries++) {
        const rv = await runAgent({
          ctx,
          config,
          role: "reviewer",
          cwd: ev.checkout.path,
          prompt: reviewerPrompt({ g, node: n, base: ns.base, tip, integrity: summarizeIntegrity(ev), implSummary: out.summary }),
          logFile: join(this.logDir, `c${this.s.cycle}-${name}-r${round}-reviewer${tries ? "-retry" : ""}.jsonl`),
          timeoutMs: g.limits.taskTimeoutMinutes * 60_000,
          budgetUsd: this.config.budgetUsd?.reviewer ?? null,
          env: { DEVKIT_NODE: n.id },
        });
        this.usage(rv);
        if (rv.envError) {
          removeCheckout(ctx, ev.checkout);
          return envStop(rv.envReason);
        }
        if (rv.output?.verdict) review = rv.output;
      }
      // 5) レビューの間に、取り出しが変えられていないか（読み取り専用の役割でも確かめる）
      const after = checkoutState(ctx, ev.checkout);
      removeCheckout(ctx, ev.checkout);
      if (this.checkSeal()) return finishNode("pending", { resume: true });
      if (after.head !== tip || after.dirty) {
        feedback = "レビューの間に、レビュー用の取り出しが変わった（もう一度検証とレビューを行う）";
        this.log(`${n.id}: ラウンド ${round} レビュー用の取り出しが変わっていた。やり直す`);
        continue;
      }
      if (!review) {
        feedback = "レビューの判定を取れなかった（もう一度検証とレビューを行う）";
        this.log(`${n.id}: ラウンド ${round} レビューの判定なし`);
        continue;
      }
      const findings = Array.isArray(review.findings) ? review.findings : [];
      const blocking = findings.filter((f) => ["critical", "important"].includes(f.severity));
      ns.history.at(-1).review = { verdict: review.verdict, blocking: blocking.length, summary: String(review.summary ?? "").slice(0, 400) };
      if (review.verdict === "impossible") {
        this.log(`${n.id}: レビュアーが「実装者の努力では満たせない」と判定: ${review.summary}`);
        return finishNode("failed", { note: `レビュアーが「実装者の努力では満たせない」と判定: ${review.summary}` });
      }
      if (review.verdict !== "pass" || blocking.length) {
        feedback = `独立レビューで修正が必要（ラウンド ${round}）: ${review.summary}\n${findings
          .filter((f) => f.severity !== "minor")
          .map((f) => `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.problem}${f.why ? `（${f.why}）` : ""}${f.fix ? ` → ${f.fix}` : ""}`)
          .join("\n")}`;
        this.log(`${n.id}: ラウンド ${round} レビューで差し戻し（重大・重要 ${blocking.length} 件）`);
        continue;
      }
      // 6) ブランチがまだ検証した対象を指しているか
      const branchTip = git(ctx.root, ["rev-parse", `refs/heads/${ns.branch}`]).out;
      if (branchTip !== tip) {
        feedback = "検証の後にブランチが変わった（もう一度検証する）";
        this.log(`${n.id}: 検証の対象とブランチが一致しない。検証し直す`);
        continue;
      }
      const evidence = {
        node: n.id,
        attempt,
        round,
        base: ns.base,
        tip,
        integrity: { ok: true, checks: ev.checks, tests: ev.tests, flags: ev.flags, deferredAcs: ev.deferredAcs },
        review: { verdict: review.verdict, summary: review.summary, findings },
        implementer: { summary: out.summary, evidence: out.evidence },
        isolation: isolationConfig(config).mode,
        at: nowIso(),
      };
      writeJson(join(ctx.evidence, `${n.id}-a${attempt}.json`), evidence);
      this.log(`${n.id}: 機械検証とレビューに合格（ラウンド ${round}、${tip.slice(0, 10)}）`);
      return finishNode("ready_to_merge", {
        tip,
        evidence: { file: `.devkit/evidence/${n.id}-a${attempt}.json`, tip },
        feedback: "",
        summary: out.summary ?? "",
        minors: findings.filter((f) => f.severity === "minor").map((f) => `${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.problem}`),
        flags: ev.flags,
      });
    }
    this.log(`${n.id}: ${g.limits.maxRounds} ラウンドで合格しなかった`);
    return finishNode("failed", { feedback, note: `${g.limits.maxRounds} ラウンドで合格しなかった` });
  }

  usage(res) {
    this.info.addUsage(res.costUsd, res.turns);
    this.s.usage = this.s.usage ?? { costUsd: 0, turns: 0 };
    this.s.usage.costUsd = Math.round(((this.s.usage.costUsd ?? 0) + (res.costUsd ?? 0)) * 10000) / 10000;
    this.s.usage.turns = (this.s.usage.turns ?? 0) + (res.turns ?? 0);
  }

  async blockWithRequest(n, raw, summary) {
    const ns = this.s.nodes[n.id];
    ns.status = "blocked";
    ns.attempts = Math.max(0, ns.attempts - 1); // 人の判断待ちは試行に数えない
    // 依頼ごとに ID を付ける。回答はこの ID と依頼の種別（役割）に紐づけ、合わない回答は受け付けない
    ns.requestSeq = (ns.requestSeq ?? 0) + 1;
    const type = normalizeRole(raw.type) ?? "technical";
    const request = { ...raw, type, id: `${n.id}-${ns.requestSeq}`, at: nowIso(), summary: summary ?? "" };
    ns.request = request;
    const rid = requestId(n.id, request);
    const file = join(this.ctx.requests, `${n.id}.md`);
    writeText(
      file,
      [
        `判断依頼: ${rid}`,
        `種別: ${ROLE_LABEL[type]}（回答するのは${ROLE_PERSON[type]}。docs/profile.json の owners.${type}）`,
        `条件: ${request.condition}`,
        `対象: ${n.id}「${n.title}」`,
        "",
        "## 何が必要か",
        request.what,
        "",
        "## なぜ必要か",
        request.why,
        "",
        "## 選択肢",
        ...(request.options ?? []).map((o) => `- ${o}`),
        "",
        "## おすすめと理由",
        request.recommendation,
        "",
        "## 回答のしかた",
        `${ROLE_PERSON[type]}が、端末で \`pnpm devkit answer ${n.id} --role ${ROLE_LABEL[type]} --request ${rid} --note "<回答>"\``,
        `（${ROLE_PERSON[type]}以外の役割の回答と、別の依頼への回答は受け付けません）`,
        "",
      ].join("\n"),
    );
    this.log(`${n.id}: ${ROLE_PERSON[type]}の判断が必要（${rid}、${request.condition}）→ .devkit/requests/${n.id}.md`);
    this.save();
    await this.notify(type, `${n.id}「${n.title}」で判断が必要です（${rid}、${request.condition}）: ${request.what}（.devkit/requests/${n.id}.md。回答: pnpm devkit answer ${n.id} --role ${ROLE_LABEL[type]} --request ${rid} --note "…"）`);
    return { id: n.id, kind: "blocked" };
  }

  // ---------- 統合 ----------

  async mergeAll(nodes) {
    this.info.set({ phase: "統合" });
    for (const n of nodes) {
      if (this.stop) return;
      if (this.s.nodes[n.id].status !== "ready_to_merge") continue;
      await this.mergeNode(n);
    }
  }

  async mergeNode(n) {
    const { ctx, g, config } = this;
    const ns = this.s.nodes[n.id];
    const pre = this.head();
    this.s.pendingMerge = { node: n.id, pre, tip: ns.tip, at: nowIso() };
    this.save();
    this.info.task(n.id, { step: "統合" });
    const m = git(ctx.root, ["merge", "--no-ff", "--no-edit", "-m", `devkit: merge ${n.id}（${n.title}）`, ns.tip], { env: { GIT_MERGE_AUTOEDIT: "no" } });
    if (m.code !== 0) {
      git(ctx.root, ["merge", "--abort"]);
      this.s.pendingMerge = null;
      this.retryLater(n, "統合ブランチと競合した（新しい統合先から作り直す）");
      this.info.task(n.id, null);
      return;
    }
    const head = this.head();
    this.info.task(n.id, { step: "統合後の検証" });
    const snap = await snapshot(ctx, config, g, { head, prevHead: this.s.lastSnapshot ?? pre, logDir: this.logDir, label: `merge-${n.id}`, allowRemoval: n.allowTestRemoval });
    if (!snap.ok) {
      const r = git(ctx.root, ["reset", "--keep", pre]);
      if (r.code !== 0) throw new Error(`統合の取り消しに失敗しました: ${r.err}`);
      this.s.pendingMerge = null;
      if (snap.envError) {
        // 環境の問題は作業の失敗に数えない（統合待ちのまま止める）
        this.stop = { reason: `環境の問題で止まりました: ${snap.reason}`, code: EXIT.env };
        this.log(`${n.id}: 統合後の検証を実行できなかった（統合を取り消した）: ${snap.reason}`);
        this.save();
      } else this.retryLater(n, `統合後の検証で不合格（統合を取り消した）:\n${snap.failures.map((f) => `- ${f}`).join("\n")}`);
      this.info.task(n.id, null);
      return;
    }
    ns.status = "done";
    ns.mergedAt = nowIso();
    ns.merge = head;
    this.s.pendingMerge = null;
    this.s.lastSnapshot = head;
    this.log(`${n.id}: 統合して完了（${head.slice(0, 10)}）`);
    this.save();
    this.commitState(`devkit: ${n.id} 完了`);
    this.info.task(n.id, null);
  }

  retryLater(n, reason) {
    const ns = this.s.nodes[n.id];
    ns.feedback = reason;
    ns.status = ns.attempts < this.g.limits.maxAttempts ? "pending" : "failed";
    ns.note = ns.status === "failed" ? `試行の上限に達した: ${reason.split("\n")[0]}` : ns.note;
    this.log(`${n.id}: ${reason.split("\n")[0]}`);
    this.save();
  }

  // ---------- マイルストーン ----------

  async verifyMilestone(mid) {
    const { ctx, g, config } = this;
    const m = g.milestones.find((x) => x.id === mid);
    const ms = this.s.milestones[mid];
    ms.status = "verifying";
    this.save();
    this.info.set({ phase: `マイルストーン ${mid} の全体検証` });
    this.log(`${mid}: 全体検証（ビルド・E2E・受入基準の照合${m.release ? "・リリース前検査・最終レビュー" : ""}）`);
    const head = this.head();
    const screensDir = join(ctx.cache, "screens", mid);
    const snap = await snapshot(ctx, config, g, { head, full: true, logDir: this.logDir, screensDir, label: `milestone-${mid}` });
    if (snap.envError) {
      ms.status = "active";
      this.save();
      this.stop = { reason: `環境の問題で止まりました: ${snap.reason}`, code: EXIT.env };
      return;
    }
    if (this.checkSeal()) return;
    const failures = [...snap.failures];
    const upTo = g.milestones.slice(0, g.milestones.findIndex((x) => x.id === mid) + 1).map((x) => x.id);
    const acs = g.nodes.filter((n) => upTo.includes(n.milestone)).flatMap((n) => n.acceptance);
    const ids = tracedIds(snap.reports);
    const missing = acs.filter((a) => !ids.has(a));
    if (missing.length) failures.push(`受入基準のテストがない・合格していない: ${missing.join(", ")}（番号をテスト名に入れ、実行されて合格すること）`);
    const co = checkout(ctx, config, `ms-${mid}`, head);
    let release = null;
    let finalReview = null;
    let checker;
    try {
      checker = runChecker(ctx, co, { base: ms.base ?? this.s.missionBase, head });
      if (checker.violations?.length) failures.push(...checker.violations.map((v) => `標準チェック ${v.rule}: ${v.file ?? ""} ${v.message}`));
      if (m.release) {
        const rel = runChecker(ctx, co, { release: true });
        release = { ok: rel.violations.length === 0, violations: rel.violations, warnings: rel.warnings ?? [] };
        if (!failures.length) {
          this.info.set({ phase: `${mid}: 最終レビュー` });
          const minors = g.nodes.flatMap((n) => (this.s.nodes[n.id].minors ?? []).map((x) => `${n.id}: ${x}`)).join("\n");
          const fr = await runAgent({
            ctx,
            config,
            role: "final-reviewer",
            cwd: co.path,
            prompt: finalReviewerPrompt({ g, base: this.s.missionBase, head, minors }),
            logFile: join(this.logDir, `final-review-${mid}.jsonl`),
            timeoutMs: g.limits.taskTimeoutMinutes * 60_000,
          });
          this.usage(fr);
          if (fr.envError) {
            ms.status = "active";
            this.save();
            this.stop = { reason: `環境の問題で止まりました: ${fr.envReason}`, code: EXIT.env };
            return;
          }
          finalReview = fr.output ?? { verdict: "changes_requested", summary: "最終レビューの判定を取れなかった", findings: [] };
          const blocking = (finalReview.findings ?? []).filter((f) => ["critical", "important"].includes(f.severity));
          if (finalReview.verdict !== "pass" || blocking.length) {
            if ((ms.fixRounds ?? 0) < g.limits.maxFinalFixRounds) {
              ms.fixRounds = (ms.fixRounds ?? 0) + 1;
              failures.push(`最終レビューで修正が必要（修正は ${g.limits.maxFinalFixRounds} 回まで）: ${finalReview.summary}\n${blocking.map((f) => `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.problem}${f.fix ? ` → ${f.fix}` : ""}`).join("\n")}`);
            } else {
              // 修正の上限に達した: 指摘を残したまま人間ゲートに回す（技術ゲートを必ず付け、確認資料に指摘を載せる）
              finalReview.unresolved = true;
              this.log(`${mid}: 最終レビューの修正が上限（${g.limits.maxFinalFixRounds} 回）に達した。指摘を残したまま、標準オーナーの判断に回す`);
            }
          }
        }
      }
    } finally {
      const st = checkoutState(ctx, co);
      removeCheckout(ctx, co);
      if (st.head !== head || st.dirty) failures.push("最終レビューの間に、取り出しが変わった（もう一度検証する）");
    }
    if (this.checkSeal()) return;
    if (failures.length) {
      ms.status = "blocked";
      ms.feedback = failures.join("\n");
      this.log(`${mid}: 全体検証で不合格（${failures.length} 件）→ 再計画`);
      this.save();
      this.commitState(`devkit: ${mid} 全体検証 不合格`);
      return;
    }
    // 必要な承認者 = 計画のゲート ＋ 変更内容から（外部接続・個人情報・権限表・安全の中心・データモデル）
    const flags = [...(checker.flags ?? [])];
    const roles = new Set(m.approvers);
    for (const f of flags) {
      if (f.rule === "DATA" && m.foundation) continue;
      if (f.role) roles.add(f.role);
    }
    if (finalReview?.unresolved) roles.add("technical");
    const required = this.controls((c) => ratchetGate(c, mid, [...roles]));
    Object.assign(ms, { head, code: codeKey(ctx, head), required, flags, release, finalReview, verifiedAt: nowIso(), screens: `.devkit/cache/screens/${mid}`, reverify: null });
    const pend = pendingRoles(this.c, mid, required, { sha: head });
    if (required.length && pend.length) {
      ms.status = "awaiting_approval";
      this.save();
      const file = writeGateReport(ctx, { g: this.g, s: this.s, mid });
      this.log(`${mid}: 全体検証に合格。${pend.map((r) => ROLE_PERSON[r]).join("・")}の承認待ち（確認資料: ${file}）`);
      for (const r of pend) await this.notify(r, `${mid}「${m.title}」の確認をお願いします。確認資料: ${file}。よければ端末で pnpm devkit approve ${mid} --role ${r}`);
    } else {
      ms.status = "done";
      this.log(`${mid}: 全体検証に合格（人間ゲートなし）→ 完了`);
    }
    this.save();
    this.commitState(`devkit: ${mid} 全体検証 合格`);
  }

  // ---------- 再計画 ----------

  async replan(items) {
    const { ctx, config } = this;
    const mid = items[0].milestone;
    const ms = this.s.milestones[mid];
    const mine = items.filter((x) => x.milestone === mid);
    if ((ms.replans ?? 0) >= this.g.limits.maxReplans) {
      this.s.outer = "stalled";
      this.s.reason = `${mid} の再計画が上限（${this.g.limits.maxReplans} 回）に達した`;
      this.save();
      this.stop = { reason: this.s.reason, code: EXIT.stalled };
      await this.notify("technical", `止まりました: ${this.s.reason}。.devkit/progress.md と /devkit:devkit-diagnose で原因を確かめてください`);
      return;
    }
    ms.replans = (ms.replans ?? 0) + 1;
    this.info.set({ phase: `${mid}: 再計画` });
    this.log(`再計画（${mid}、${ms.replans} 回目）: ${mine.map((x) => x.id).join(", ")}`);
    const failures = mine
      .map((x) => {
        if (x.scope === "milestone") return `### マイルストーン ${x.id}\n${this.s.milestones[x.id].feedback}`;
        const ns = this.s.nodes[x.id];
        const last = ns.history?.at(-1);
        return `### ノード ${x.id}（試行 ${ns.attempts}）\n${ns.note}\n${ns.feedback}\n${last ? `最後のラウンド: ${JSON.stringify(last).slice(0, 1500)}` : ""}`;
      })
      .join("\n\n");
    this.save();
    this.commitState(`devkit: 再計画の前の状態（${mid}）`);
    const co = checkout(ctx, config, `replan-${mid}`, this.head());
    let res;
    try {
      res = await runAgent({
        ctx,
        config,
        role: "replanner",
        cwd: co.path,
        prompt: replannerPrompt({ g: this.g, items: mine, failures }),
        logFile: join(this.logDir, `replan-${mid}-${ms.replans}.jsonl`),
        timeoutMs: this.g.limits.taskTimeoutMinutes * 60_000,
      });
    } finally {
      removeCheckout(ctx, co);
    }
    this.usage(res);
    if (this.checkSeal()) return;
    if (res.envError) {
      ms.replans -= 1;
      this.save();
      this.stop = { reason: `環境の問題で止まりました: ${res.envReason}`, code: EXIT.env };
      return;
    }
    const p = res.output;
    const proposalId = `replan-${mid}-${ms.replans}`;
    if (!p || p.kind === "needs_human" || !Array.isArray(p.nodes)) return this.proposalNeedsHuman(proposalId, mid, mine, p, p ? ["再計画の担当が人の判断を求めた"] : ["再計画の案を作れなかった"]);
    const raw = readJson(ctx.graph, null);
    const next = structuredClone(raw);
    const strip = (n) => {
      const { status, attempts, approved, ...rest } = n;
      return rest;
    };
    for (const pn of p.nodes) {
      const i = next.nodes.findIndex((n) => n.id === pn.id);
      if (i >= 0) next.nodes[i] = strip(pn);
      else next.nodes.push(strip(pn));
    }
    next.nodes = next.nodes.filter((n) => !(p.remove ?? []).includes(n.id));
    const nextG = normalizeGraph(structuredClone(next));
    const { errors } = validate(ctx, nextG, { controls: this.c });
    const cls = classifyPlanChange(this.g, nextG, this.s);
    if (errors.length || !cls.allowed) return this.proposalNeedsHuman(proposalId, mid, mine, { ...p, graph: next }, [...errors, ...cls.reasons]);
    // 承認済みの範囲の変更: 書く前に記録し（途中で落ちても戻せるように）、計画に入れ、承認済みのハッシュを進める
    const hash = planHash(ctx, next);
    this.controls((c) => {
      c.pendingReplan = { id: proposalId, hash, prevHash: c.plan.approvedHash, at: nowIso(), summary: p.summary, decisions: p.decisions ?? [] };
    });
    writeJson(ctx.graph, next);
    this.seal.note(".devkit/graph.json");
    this.controls((c) => {
      c.plan.approvedHash = hash;
      c.plan.history.push({ type: "auto-replan", id: proposalId, hash, at: nowIso(), summary: p.summary, decisions: p.decisions ?? [] });
      c.pendingReplan = null;
    });
    this.g = loadGraph(ctx);
    syncState(this.g, this.s);
    const note = `再計画（${proposalId}）: ${p.summary}`;
    // 案で変わったノードと、止まっていたもの（案に含まれていなくても）を、もう一度実行できる状態に戻す
    resetForReplan(this.s, [...(p.nodes ?? []).map((n) => ({ scope: "node", id: n.id })), ...mine], note);
    for (const id of p.remove ?? []) delete this.s.nodes[id];
    for (const dcs of p.decisions ?? []) appendProgress(ctx, `判断: ${dcs}`);
    this.log(`再計画を適用（${proposalId}）: ${p.summary}`);
    this.save();
    this.commitState(`devkit: replan ${proposalId}`);
  }

  async proposalNeedsHuman(id, mid, items, p, reasons) {
    const { ctx } = this;
    const roles = proposalRoles(reasons);
    writeJson(join(ctx.proposals, `${id}.json`), { id, milestone: mid, at: nowIso(), items, reasons, roles, proposal: p ?? null });
    this.s.proposals = [...(this.s.proposals ?? []).filter((x) => x.id !== id), { id, milestone: mid, items, roles, status: "needs_human", reasons }];
    this.log(`再計画の案 ${id} は人の確認が要る: ${reasons.slice(0, 3).join(" / ")}`);
    this.save();
    this.commitState(`devkit: 再計画の案 ${id}（人の確認待ち）`);
    for (const r of roles)
      await this.notify(
        r,
        `再計画の案 ${id} の確認が必要です（${reasons[0] ?? ""}）。.devkit/proposals/${id}.json を確かめ、端末で pnpm devkit proposal accept ${id} --role ${r} か、計画を直して pnpm devkit approve plan`,
      );
  }

  // ---------- 完了 ----------

  async finishMission() {
    // リリースの検証・承認が、今の統合ブランチのコードを覆っているか
    const rel = this.g.milestones.at(-1);
    const rs = this.s.milestones[rel.id];
    const now = codeKey(this.ctx, this.head());
    if (!rs?.head || codeKey(this.ctx, rs.head) !== now) {
      Object.assign(rs, { status: "active", reverify: "リリースの検証の後にコードが変わった" });
      this.log(`${rel.id}: リリースの検証の後に統合ブランチのコードが変わっている。全体検証からやり直す`);
      this.save();
      this.commitState(`devkit: ${rel.id} の検証をやり直す`);
      return;
    }
    this.s.outer = "done";
    this.s.reason = "";
    this.s.finishedAt = nowIso();
    this.save();
    this.log("全マイルストーンが完了。リリース判断・デプロイは人が行う");
    this.commitState("devkit: ミッション完了");
    this.stop = { reason: "ミッション完了", code: EXIT.ok };
    for (const r of ["business", "technical"]) await this.notify(r, "ミッションが完了しました。リリース判断・デプロイをお願いします（pnpm devkit status）");
  }
}

export { isApproved };
