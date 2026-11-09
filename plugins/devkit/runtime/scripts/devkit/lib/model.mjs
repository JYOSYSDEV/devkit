// 計画（graph.json）・実行の状態（state.json）・人の決定（controls.json）のモデル。
//
// 役割の分け方:
//   graph.json    計画。kickoff と再計画で作る。人が承認した時点のハッシュを controls.json に記録し、
//                 承認されていない変更はランナーが受け付けない。実行の状態は書かない。
//   state.json    実行の状態（ノード・マイルストーンの状態、試行回数、証拠）。ランナーだけが書く。
//   controls.json 人の決定（計画の承認、ゲートの記録、承認、回答、サイクル上限）。devkit のコマンドだけが書き、
//                 人の操作（承認・差し戻し・回答・上限の追加）は端末からだけ受け付ける。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTROLS_FILE,
  findRepoRoot,
  isNestedWorktree,
  isProtectedPath,
  isSharedPath,
  normalizeRole,
  ROLE_PERSON,
  ROLES,
} from "../shared.mjs";
import { insideWorkBase, ISOLATION_DEFAULTS } from "./isolation.mjs";
import { journalWrite } from "./seal.mjs";
import { fail, globToRegExp, nowIso, ownsOverlap, readJson, sha256, staticPrefix, writeJson } from "./util.mjs";

export const NODE_STATUSES = ["pending", "running", "ready_to_merge", "done", "failed", "blocked"];
export const MILESTONE_STATUSES = ["pending", "active", "verifying", "awaiting_approval", "done", "blocked"];
export const OUTER_STATES = ["idle", "running", "paused", "stalled", "done"];
export const DEFAULT_LIMITS = {
  maxParallel: 3,
  maxRounds: 3,
  maxAttempts: 3,
  maxReplans: 3,
  maxCycles: 30,
  maxFinalFixRounds: 1,
  taskTimeoutMinutes: 60,
  verifyTimeoutMinutes: 30,
  taskBudgetUsd: null,
  lookahead: false,
};
export const PLAN_APPROVERS = ["business", "technical"];

// ---------- 場所 ----------

export function createContext(base = process.cwd()) {
  const repo = findRepoRoot(base);
  let root;
  if (process.env.DEVKIT_ROOT) root = resolve(process.env.DEVKIT_ROOT);
  else if (repo) root = repo.root;
  else if (process.env.CLAUDE_PROJECT_DIR) root = resolve(process.env.CLAUDE_PROJECT_DIR);
  else root = resolve(base);
  // 作業用の場所（ランナーの作業ディレクトリ・取り出し、プロジェクトの中の worktree）では、devkit の状態を変えない
  const inWorker =
    insideWorkBase(root) ||
    ((isNestedWorktree(findRepoRoot(root)) || /[\\/](\.claude[\\/]worktrees|\.devkit[\\/](tmp|worktrees))[\\/]/.test(`${root}/`)) &&
      !process.env.DEVKIT_FORCE &&
      !process.env.DEVKIT_MAIN_SESSION);
  const dir = join(root, ".devkit");
  return {
    root,
    dir,
    inWorker,
    graph: join(dir, "graph.json"),
    state: join(dir, "state.json"),
    controls: join(dir, CONTROLS_FILE),
    config: join(dir, "config.json"),
    progress: join(dir, "progress.md"),
    mission: join(dir, "mission.md"),
    learnings: join(dir, "learnings.md"),
    runFile: join(dir, "run.json"),
    lock: join(dir, "run.lock"),
    version: join(dir, "version.json"),
    legacyWorktrees: join(dir, "worktrees"),
    logs: join(dir, "logs"),
    cache: join(dir, "cache"),
    gates: join(dir, "gates"),
    reports: join(dir, "reports"),
    requests: join(dir, "requests"),
    proposals: join(dir, "proposals"),
    evidence: join(dir, "evidence"),
    statusHtml: join(dir, "status.html"),
    decisions: join(root, "docs", "decisions.md"),
    profile: join(root, "docs", "profile.json"),
    checker: join(root, "scripts", "standard", "check.mjs"),
  };
}

// ---------- 読み書き ----------

export function loadGraph(ctx, { required = true } = {}) {
  const g = readJson(ctx.graph, null);
  if (!g) {
    if (required) fail("計画がありません（.devkit/graph.json）。devkit-kickoff スキルで作成してください。");
    return null;
  }
  return normalizeGraph(g);
}

export function normalizeGraph(g) {
  g.limits = { ...DEFAULT_LIMITS, ...(g.limits ?? {}) };
  g.verifyFull ??= "pnpm verify:full";
  g.dependencies ??= { prod: [], dev: [] };
  g.milestones ??= [];
  g.nodes ??= [];
  for (const m of g.milestones) {
    m.approvers ??= [];
    m.release ??= false;
    m.foundation ??= false;
  }
  for (const n of g.nodes) {
    n.deps ??= [];
    n.owns ??= [];
    n.acceptance ??= [];
    n.before ??= [];
    n.verify ??= "standard";
    n.allowTestRemoval ??= [];
  }
  return g;
}

export function loadState(ctx, g = null) {
  const s = readJson(ctx.state, {}) ?? {};
  const state = {
    version: 2,
    outer: "idle",
    reason: "",
    cycle: 0,
    stall: 0,
    lastHash: null,
    missionBase: null,
    pendingMerge: null,
    usage: { costUsd: 0, turns: 0 },
    nodes: {},
    milestones: {},
    updatedAt: null,
    ...s,
  };
  if (!OUTER_STATES.includes(state.outer)) fail(`state.json の outer が不正です: ${state.outer}`);
  if (g) syncState(g, state);
  return state;
}

// 計画にあるノード・マイルストーンの状態を用意する（再計画で増えたもの）
export function syncState(g, s) {
  for (const n of g.nodes) {
    s.nodes[n.id] ??= {
      status: "pending",
      attempts: 0,
      round: 0,
      roundsDone: 0,
      branch: null,
      base: null,
      tip: null,
      feedback: "",
      note: "",
      request: null,
      evidence: null,
      history: [],
    };
  }
  for (const m of g.milestones) {
    s.milestones[m.id] ??= { status: "pending", base: null, head: null, required: [], flags: [], replans: 0, fixRounds: 0, feedback: "" };
  }
  return s;
}

// journal: 人のコマンドから書くとき（ランナーの封印が、人の記録と分かるように）
export function saveState(ctx, s, { journal = null } = {}) {
  s.updatedAt = nowIso();
  if (journal) journalWrite(ctx, ".devkit/state.json", `${JSON.stringify(s, null, 2)}\n`, journal);
  else writeJson(ctx.state, s);
}

export function loadControls(ctx) {
  const c = readJson(ctx.controls, {}) ?? {};
  return {
    version: 2,
    plan: { approvedHash: null, approvals: {}, history: [] },
    maxCycles: null,
    gates: {},
    approvals: {},
    answers: {},
    rejections: {},
    proposals: {},
    pause: null,
    pendingReplan: null,
    ...c,
    plan: { approvedHash: null, approvals: {}, history: [], ...(c.plan ?? {}) },
  };
}

export function saveControls(ctx, c) {
  writeJson(ctx.controls, c);
}

// controls.json の読み・変更・書きを、ほかのプロセス（人の承認とランナー）と重ならないように行う
export function updateControls(ctx, fn, { journal = null } = {}) {
  const lock = `${ctx.controls}.lock`;
  mkdirSync(ctx.dir, { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) fail("controls.json のロックを取れませんでした（ほかの devkit のコマンドが動いていないか確かめてください）");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    const c = loadControls(ctx);
    const r = fn(c);
    if (journal) journalWrite(ctx, ".devkit/controls.json", `${JSON.stringify(c, null, 2)}\n`, journal);
    else saveControls(ctx, c);
    return r;
  } finally {
    rmSync(lock, { force: true });
  }
}

export function loadConfig(ctx) {
  const file = readJson(ctx.config, {}) ?? {};
  const config = {
    permissionMode: "dontAsk",
    claudeBin: process.env.DEVKIT_CLAUDE_BIN || "claude",
    installCommand: "pnpm install --frozen-lockfile --prefer-offline",
    agentPrefix: "devkit:",
    pluginDir: null,
    models: {},
    budgetUsd: {},
    extraArgs: [],
    // ランナーが起動する AI の Bash を Claude Code のサンドボックスで動かす（required: 使えなければ起動しない ／ off: 使わない）
    aiSandbox: "required",
    // 作業場所（AI の作業ディレクトリ・取り出し）。リポジトリの外に置く。省略時は ~/.cache/devkit/<案件>/work
    workDir: null,
    ...file,
  };
  config.isolation = { ...ISOLATION_DEFAULTS, ...(file.isolation ?? {}) };
  return config;
}

// 設定の値の確かめ（ランナーの起動前）
export function configProblems(config) {
  const p = [];
  if (!["dontAsk", "auto"].includes(config.permissionMode)) p.push(`permissionMode は dontAsk か auto（${config.permissionMode} は使えない）`);
  if (!["required", "off"].includes(config.aiSandbox)) p.push(`aiSandbox は required か off（${config.aiSandbox}）`);
  if (!["container", "none"].includes(config.isolation.mode)) p.push(`isolation.mode は container か none（${config.isolation.mode}）`);
  for (const k of ["installArgs", "verifyArgs"])
    if (!Array.isArray(config.isolation[k]) || config.isolation[k].some((a) => typeof a !== "string")) p.push(`isolation.${k} は文字列の配列`);
  if (config.isolation.mode === "container" && config.isolation.verifyArgs.some((a) => /^--(network|net|privileged|cap-add|volume|mount|pid|ipc|userns|device|security-opt)\b|^-v$/.test(a)))
    p.push("isolation.verifyArgs で、検証の段階のネットワーク・権限・マウントを広げることはできない");
  return p;
}

// ---------- 仕様書 ----------

// 仕様書の AC-n / BR-n の定義を集める（見出し `### AC-1 …` か、箇条書き `- **AC-1** …`）
export function parseSpec(text) {
  const items = new Map();
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:#{2,4}\s*|[-*]\s*)?(?:\*\*)?((?:AC|BR)-\d+)(?:\*\*)?[\s:：.．)）]*(.*)$/);
    if (!m) continue;
    const id = m[1];
    if (items.has(id)) continue;
    const body = [m[2].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*(?:#{1,4}\s|[-*]\s*(?:\*\*)?(?:AC|BR|FR)-\d+)/.test(l)) break;
      if (!l.trim() && !lines[j + 1]?.match(/^\s{2,}/)) break;
      body.push(l.trim());
    }
    items.set(id, body.filter(Boolean).join(" "));
  }
  return items;
}

export function specText(ctx, g) {
  if (!g.spec) return null;
  const p = join(ctx.root, g.spec.split("#")[0]);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// ---------- 計画のハッシュ（承認の対象） ----------

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export function planHash(ctx, rawGraph = undefined) {
  // ディスク上の graph.json（正規化する前の内容）・仕様書・mission.md をまとめてハッシュにする。
  // rawGraph を渡すと、ディスクの graph.json の代わりにそれを使う（書く前にハッシュを求める）
  const raw = rawGraph === undefined ? readJson(ctx.graph, null) : rawGraph;
  let spec = "";
  if (raw?.spec) {
    const p = join(ctx.root, String(raw.spec).split("#")[0]);
    if (existsSync(p)) spec = readFileSync(p, "utf8");
  }
  const mission = existsSync(ctx.mission) ? readFileSync(ctx.mission, "utf8") : "";
  return sha256([stable(raw), spec, mission].join("\n\u0000\n")).slice(0, 32);
}

// ---------- 計画の検査 ----------

const GOAL_PROOF = /`[^`]+`/;
const GOAL_END_STATE = /(exit\s*(code\s*)?0|\bpass(es|ed)?\b|が通る|成功する|エラー\s*0|0\s*件)/i;
const GOAL_CONSTRAINT =
  /((削除|skip|only|緩和|弱め)[^。\n]{0,40}(しない|禁止))|(owns\s*外[^。\n]{0,30}(変更しない|変更せず|触らない|禁止))/i;
const GOAL_TURN_LIMIT = /((または|or)\s*\d+\s*(ターン|turns?))|(\d+\s*(ターン|turns?)\s*で\s*(停止|止める))/i;

export function goalProblems(goal) {
  const p = [];
  const text = String(goal ?? "");
  if (!text.trim()) return ["がない"];
  if (text.length > 4000) p.push("が 4,000 文字を超えている");
  if (!GOAL_PROOF.test(text)) p.push("に証明方法（`pnpm verify` のようにバッククォートで囲んだ実行コマンド）がない");
  if (!GOAL_END_STATE.test(text)) p.push("に測定できる終了状態（「`pnpm verify` が exit 0」など）がない");
  if (!GOAL_CONSTRAINT.test(text))
    p.push("に制約（「既存テストの削除・skip・期待値の緩和はしない」「owns 外のファイルは変更しない」）がない");
  if (!GOAL_TURN_LIMIT.test(text)) p.push("にターン上限（「または 25 ターンで停止」）がない");
  return p;
}

function topo(g) {
  const ids = g.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const n of g.nodes)
    for (const d of n.deps) {
      if (!indeg.has(d)) continue;
      indeg.set(n.id, indeg.get(n.id) + 1);
      out.get(d).push(n.id);
    }
  const layers = [];
  let frontier = ids.filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (frontier.length) {
    layers.push(frontier);
    seen += frontier.length;
    const next = [];
    for (const id of frontier)
      for (const m of out.get(id)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    frontier = next;
  }
  return { layers, cyclic: seen === ids.length ? [] : ids.filter((id) => indeg.get(id) > 0) };
}

export function topoLayers(g) {
  return topo(g);
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

// owns が共有ファイル・保護されたパスを含んでしまうか（docs/** や scripts/** のような広すぎる指定も含む）
const PROTECTED_PROBES = [
  "docs/spec/x.md",
  "docs/standard/x.md",
  "docs/devkit/x.md",
  "docs/profile.json",
  "docs/exceptions.json",
  "docs/decisions.md",
  "scripts/devkit/devkit.mjs",
  "scripts/standard/check.mjs",
  ".devkit/graph.json",
  ".claude/settings.json",
  ".github/workflows/ci.yml",
  "package.json",
  "pnpm-lock.yaml",
  "vitest.config.ts",
  "playwright.config.ts",
  "next.config.ts",
  "CLAUDE.md",
  ".npmrc",
  ".gitignore",
];

function ownsTouchesProtected(o) {
  const norm = o.replace(/^\.\//, "");
  const prefix = staticPrefix(norm);
  if (isSharedPath(norm) || isProtectedPath(norm)) return true;
  if (prefix && (isSharedPath(prefix) || isProtectedPath(prefix))) return true;
  const re = globToRegExp(norm);
  return PROTECTED_PROBES.some((p) => re.test(p));
}

export function validate(ctx, g, { controls = null } = {}) {
  const errors = [];
  const warnings = [];
  if (g.version !== 2) errors.push("version は 2 にする（devkit v4 の計画形式）");
  if (!g.mission) errors.push("mission（一行の目的）がない");
  if (!g.branch) errors.push("branch（統合ブランチ名。例: devkit/expense-app）がない");
  else if (!BRANCH_RE.test(g.branch) || g.branch.includes("..") || /(^|\/)\.|\/$|\.lock$/.test(g.branch))
    errors.push(`branch「${g.branch}」は git のブランチ名として使えない`);
  if (!g.verify) errors.push("verify（作業ごとの検証コマンド。例: pnpm verify）がない");
  if (!g.spec) errors.push("spec（仕様書のパス。例: docs/spec/expense-app.md）がない");
  const deps = g.dependencies;
  if (!deps || !Array.isArray(deps.prod ?? []) || !Array.isArray(deps.dev ?? []))
    errors.push("dependencies は { prod: [...], dev: [...] } の形にする");
  const L = g.limits;
  const range = (k, lo, hi) => {
    if (!(Number.isInteger(L[k]) && L[k] >= lo && L[k] <= hi)) errors.push(`limits.${k} は ${lo}〜${hi} の整数`);
  };
  range("maxParallel", 1, 8);
  range("maxRounds", 1, 5);
  range("maxAttempts", 1, 5);
  range("maxReplans", 0, 10);
  range("maxCycles", 1, 200);
  range("maxFinalFixRounds", 0, 3);
  range("taskTimeoutMinutes", 5, 480);
  range("verifyTimeoutMinutes", 2, 240);
  if (controls?.maxCycles != null && L.maxCycles !== controls.maxCycles)
    warnings.push(`limits.maxCycles（${L.maxCycles}）は使われない。上限は開始時に記録した ${controls.maxCycles}（増やすのは人の pnpm devkit resume --add-cycles）`);

  // マイルストーン
  const mids = new Set();
  if (!Array.isArray(g.milestones) || g.milestones.length === 0) errors.push("milestones が空");
  g.milestones.forEach((m, i) => {
    const tag = `マイルストーン ${m.id ?? "(id なし)"}`;
    if (!m.id || !/^[A-Za-z0-9_-]+$/.test(m.id)) errors.push(`${tag}: id は英数字・_・- のみ`);
    if (mids.has(m.id)) errors.push(`${tag}: id が重複`);
    mids.add(m.id);
    if (!m.title) errors.push(`${tag}: title がない`);
    for (const r of m.approvers) if (!ROLES.includes(r)) errors.push(`${tag}: approvers は business / technical`);
    const last = i === g.milestones.length - 1;
    if (m.release && !last) errors.push(`${tag}: release: true は最後のマイルストーンだけ`);
    if (last && !m.release) errors.push(`${tag}: 最後のマイルストーンは release: true にする（リリース前検査と最終レビューを行う）`);
    if (m.release && !(m.approvers.includes("business") && m.approvers.includes("technical")))
      errors.push(`${tag}: release のマイルストーンは approvers に business と technical の両方を入れる`);
  });
  if (g.milestones[0] && !g.milestones[0].foundation)
    warnings.push(`最初のマイルストーン ${g.milestones[0].id} に foundation: true がない（データモデルの変更はそれ以降、技術ゲートになる）`);
  if (g.milestones[0]?.foundation && !g.milestones[0].approvers.includes("technical"))
    errors.push(`基盤のマイルストーン ${g.milestones[0].id} は approvers に technical を入れる（データモデルの確定）`);

  // ノード
  const ids = new Set();
  const msIndex = new Map(g.milestones.map((m, i) => [m.id, i]));
  const nodeMs = new Map(g.nodes.map((n) => [n.id, n.milestone]));
  for (const n of g.nodes) {
    const tag = `ノード ${n.id ?? "(id なし)"}`;
    if (!n.id || !/^[A-Za-z0-9_-]+$/.test(n.id)) errors.push(`${tag}: id は英数字・_・- のみ`);
    if (ids.has(n.id) || mids.has(n.id)) errors.push(`${tag}: id が重複（マイルストーンの id とも重ねない）`);
    ids.add(n.id);
    if (!n.title) errors.push(`${tag}: title がない`);
    if (!msIndex.has(n.milestone)) errors.push(`${tag}: milestone「${n.milestone}」が milestones にない`);
    for (const k of ["status", "attempts", "approved"])
      if (k in n) errors.push(`${tag}: ${k} は graph.json に書かない（実行の状態は state.json、承認は controls.json に devkit が記録する）`);
    if (!Array.isArray(n.owns) || n.owns.length === 0) errors.push(`${tag}: owns（変更してよいパス）がない`);
    for (const o of n.owns) {
      if (typeof o !== "string" || o.startsWith("/") || o.split("/").includes("..") || /^[A-Za-z]:/.test(o))
        errors.push(`${tag}: owns はリポジトリ相対パスで書く（${o}）`);
      else if (staticPrefix(o) === "") errors.push(`${tag}: owns「${o}」はリポジトリ全体に及ぶ。ディレクトリを絞る`);
      else if (ownsTouchesProtected(o))
        errors.push(`${tag}: owns「${o}」は共有ファイルか保護されたパスを含む（一覧は pnpm -s devkit shared）`);
    }
    if (!Array.isArray(n.acceptance)) errors.push(`${tag}: acceptance は配列`);
    for (const a of n.acceptance) if (!/^(AC|BR)-\d+$/.test(a)) errors.push(`${tag}: acceptance の「${a}」は AC-n か BR-n`);
    for (const r of n.before) if (!ROLES.includes(r)) errors.push(`${tag}: before は business / technical`);
    if (!["standard", "full"].includes(n.verify)) errors.push(`${tag}: verify は standard か full`);
    if (n.allowTestRemoval.length) {
      const m = g.milestones.find((x) => x.id === n.milestone);
      if (!m?.foundation) errors.push(`${tag}: allowTestRemoval は基盤のマイルストーンのノードだけで使える（雛形の見本の削除など）`);
    }
    errors.push(...goalProblems(n.goal).map((p) => `${tag}: goal ${p}`));
    for (const d of n.deps) {
      if (!nodeMs.has(d)) errors.push(`${tag}: deps に存在しない ${d}`);
      else if (d === n.id) errors.push(`${tag}: 自分自身に依存している`);
      else if (msIndex.get(nodeMs.get(d)) > msIndex.get(n.milestone))
        errors.push(`${tag}: 後のマイルストーンのノード ${d} に依存している`);
    }
  }
  for (const m of g.milestones) if (!g.nodes.some((n) => n.milestone === m.id)) errors.push(`マイルストーン ${m.id}: ノードがない`);
  const { cyclic } = topo(g);
  if (cyclic.length) errors.push(`依存が循環している: ${cyclic.join(", ")}`);

  // 仕様書の AC / BR がちょうど1つのノードに割り当たっているか
  const spec = specText(ctx, g);
  if (g.spec && spec === null) errors.push(`仕様書 ${g.spec} がない`);
  if (spec !== null) {
    const defined = parseSpec(spec);
    const owner = new Map();
    for (const n of g.nodes)
      for (const a of n.acceptance) {
        if (!defined.has(a)) errors.push(`ノード ${n.id}: ${a} が仕様書にない`);
        if (owner.has(a)) errors.push(`${a} が ${owner.get(a)} と ${n.id} の両方に割り当てられている（1つのノードにする）`);
        owner.set(a, n.id);
      }
    for (const id of defined.keys()) if (!owner.has(id)) errors.push(`仕様書の ${id} がどのノードの acceptance にもない`);
  }

  // 消えたゲート（承認なしに graph から外してはいけない）
  if (controls) {
    for (const key of Object.keys(controls.gates)) {
      const [id, kind] = key.split(":");
      const exists = kind === "before" ? ids.has(id) : mids.has(id);
      if (!exists && !isApproved(controls, key, controls.gates[key]))
        errors.push(`ゲート付きの ${id} が graph から消えている（ゲート付きのものの削除は人の承認が要る）`);
    }
  }
  return { errors, warnings };
}

// ---------- 承認 ----------

export function gateKey(kind, id) {
  return kind === "before" ? `${id}:before` : id;
}

// ゲートの記録に役割を足す（足すだけで、消さない）
export function ratchetGate(c, key, roles) {
  const cur = new Set(c.gates[key] ?? []);
  for (const r of roles) if (ROLES.includes(r)) cur.add(r);
  if (cur.size) c.gates[key] = [...cur].sort();
  return c.gates[key] ?? [];
}

export function requiredRoles(c, key, planned = []) {
  return [...new Set([...(c.gates[key] ?? []), ...planned])].filter((r) => ROLES.includes(r)).sort();
}

// sha を渡したとき（マイルストーンの承認）は、そのコミットに紐づいた承認だけを数える（sha のない承認は数えない）
function approvalMatches(a, sha) {
  return Boolean(a) && (!sha || a.sha === sha);
}

export function isApproved(c, key, roles, { sha = null } = {}) {
  const ap = c.approvals[key] ?? {};
  return roles.every((r) => approvalMatches(ap[r], sha));
}

export function pendingRoles(c, key, roles, { sha = null } = {}) {
  const ap = c.approvals[key] ?? {};
  return roles.filter((r) => !approvalMatches(ap[r], sha));
}

// 計画が承認済みか。人が両方の役割で承認した計画か、そこから承認済みの範囲で再計画したもの（approvedHash）と一致すること
export function planApproved(ctx, c) {
  const hash = planHash(ctx);
  const everyone = PLAN_APPROVERS.every((r) => c.plan.approvals[r]);
  const ok = c.plan.approvedHash === hash && everyone;
  const pending = c.plan.approvedHash === hash ? PLAN_APPROVERS.filter((r) => !c.plan.approvals[r]) : PLAN_APPROVERS.filter((r) => c.plan.approvals[r]?.hash !== hash);
  return { ok, hash, pending, changedAfterApproval: Boolean(c.plan.approvedHash) && c.plan.approvedHash !== hash };
}

export function parseRoleList(v) {
  return String(v ?? "")
    .split(/[,\s]+/)
    .map(normalizeRole)
    .filter(Boolean);
}

// ---------- 判断依頼（回答は、どの依頼への、どの役割の回答かに紐づける） ----------

// 判断依頼の ID。ランナーが依頼ごとに付ける（N1-1, N1-2 …）。v4.1.0 までの依頼には id がないので、ノードと依頼の時刻から作る
export function requestId(nodeId, req) {
  if (!req) return null;
  return req.id ?? `${nodeId}@${req.at ?? ""}`;
}

// 判断依頼に回答する役割（依頼の種別。分からなければ標準オーナー）
export function requestRole(req) {
  return normalizeRole(req?.type) ?? "technical";
}

// 回答が、そのノードの今の判断依頼に当てはまるか。当てはまらなければ理由を返す
export function answerProblem(nodeId, ns, a) {
  if (!ns || ns.status !== "blocked" || !ns.request) return "回答待ちの判断依頼がない";
  const rid = requestId(nodeId, ns.request);
  if (a.request !== rid) return `別の判断依頼（${a.request ?? "指定なし"}）への回答で、今の依頼 ${rid} への回答ではない`;
  if (ns.request.at && (!a.at || a.at < ns.request.at)) return `依頼 ${rid} が出る前の回答`;
  const want = requestRole(ns.request);
  if (a.role !== want) return `依頼 ${rid} は${ROLE_PERSON[want]}が回答するもので、${ROLE_PERSON[a.role] ?? a.role}の回答は受け付けない`;
  return null;
}

// 再計画の案を承認・却下する役割。ランナーが案を作ったときの役割と、案の計画から求め直した役割を合わせる（減らさない）
export function proposalNeededRoles(...lists) {
  const set = new Set(lists.flat().filter((r) => ROLES.includes(r)));
  if (!set.size) set.add("technical");
  return ROLES.filter((r) => set.has(r));
}

// ---------- 次に何をするか（ランナーと status が共用する、状態を変えない判断） ----------

export function decide(g, s, c) {
  const L = g.limits;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nodeState = (id) => s.nodes[id] ?? { status: "pending", attempts: 0 };
  const msOrder = g.milestones.map((m) => m.id);
  const msState = (id) => s.milestones[id] ?? { status: "pending" };

  const result = {
    allDone: false,
    current: null,
    open: [],
    ready: [],
    deferred: [],
    running: [],
    readyToMerge: [],
    verifyMilestone: null,
    replan: [],
    waiting: { approvals: [], answers: [], proposals: [] },
  };

  // 開いているマイルストーン（先頭の未完了。lookahead なら、承認待ちの次も）
  const open = [];
  for (const id of msOrder) {
    const st = msState(id).status;
    if (st === "done") continue;
    open.push(id);
    if (!(L.lookahead && st === "awaiting_approval")) break;
  }
  result.current = open[0] ?? null;
  result.open = open;
  if (!result.current) {
    result.allDone = g.milestones.length > 0;
    return result;
  }

  // 判断待ち（人）
  for (const id of msOrder) {
    const ms = msState(id);
    if (ms.status === "awaiting_approval") {
      const roles = requiredRoles(c, id, ms.required ?? []);
      const pend = pendingRoles(c, id, roles, { sha: ms.head });
      if (pend.length) result.waiting.approvals.push({ target: id, kind: "milestone", roles: pend, sha: ms.head });
    }
  }
  for (const n of g.nodes) {
    const ns = nodeState(n.id);
    if (ns.status === "blocked" && ns.request) result.waiting.answers.push({ node: n.id, role: requestRole(ns.request), request: requestId(n.id, ns.request) });
  }
  for (const p of s.proposals ?? []) {
    if (p.status !== "needs_human") continue;
    const d = c.proposals?.[p.id];
    if (d && ["accepted", "rejected"].includes(d.status)) continue;
    const roles = proposalNeededRoles(p.roles ?? [], d?.needed ?? []).filter((r) => !d?.accepts?.[r]);
    result.waiting.proposals.push({ ...p, roles });
  }

  for (const n of g.nodes) {
    const ns = nodeState(n.id);
    if (ns.status === "running") result.running.push(n);
    if (ns.status === "ready_to_merge") result.readyToMerge.push(n);
  }

  // マイルストーンの全体検証が必要か（全ノード done で、検証前）
  for (const id of open) {
    const ms = msState(id);
    const nodes = g.nodes.filter((n) => n.milestone === id);
    if (["pending", "active", "verifying"].includes(ms.status) && nodes.length && nodes.every((n) => nodeState(n.id).status === "done")) {
      result.verifyMilestone = id;
      break;
    }
  }

  // 再計画が必要なもの（人の回答待ちと、人の確認待ちの再計画の案があるマイルストーンは除く）
  const proposalPending = new Set(result.waiting.proposals.map((p) => p.milestone));
  for (const n of g.nodes) {
    if (!open.includes(n.milestone) || proposalPending.has(n.milestone)) continue;
    const ns = nodeState(n.id);
    if (ns.status === "failed" || (ns.status === "blocked" && !ns.request) || (ns.status === "pending" && ns.attempts >= L.maxAttempts))
      result.replan.push({ scope: "node", id: n.id, milestone: n.milestone, reason: ns.note || ns.feedback || ns.status });
  }
  for (const id of open) {
    const ms = msState(id);
    if (ms.status === "blocked" && !proposalPending.has(id)) result.replan.push({ scope: "milestone", id, milestone: id, reason: ms.feedback || "全体検証に不合格" });
  }

  // 実行できる作業
  const depsDone = (n) => n.deps.every((d) => nodeState(d).status === "done");
  const candidates = [];
  for (const n of g.nodes) {
    const ns = nodeState(n.id);
    if (ns.status !== "pending" || ns.attempts >= L.maxAttempts) continue;
    if (!open.includes(n.milestone)) continue;
    const ms = msState(n.milestone);
    if (!["pending", "active"].includes(ms.status)) continue;
    if (!depsDone(n)) continue;
    const beforeRoles = requiredRoles(c, gateKey("before", n.id), n.before);
    const pend = pendingRoles(c, gateKey("before", n.id), beforeRoles);
    if (pend.length) {
      result.waiting.approvals.push({ target: n.id, kind: "before", roles: pend, sha: null });
      continue;
    }
    candidates.push(n);
  }
  // 依存されている数の多いもの（クリティカルパス）から
  const weight = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const n of g.nodes) for (const d of n.deps) weight.set(d, (weight.get(d) ?? 0) + 1);
  candidates.sort((a, b) => msOrder.indexOf(a.milestone) - msOrder.indexOf(b.milestone) || weight.get(b.id) - weight.get(a.id) || a.id.localeCompare(b.id));
  for (const n of candidates) {
    if (result.ready.length >= L.maxParallel) {
      result.deferred.push({ id: n.id, why: "maxParallel" });
      continue;
    }
    const clash = result.ready.find((x) => ownsOverlap(x.owns, n.owns));
    if (clash) result.deferred.push({ id: n.id, why: `owns が ${clash.id} と重なる` });
    else result.ready.push(n);
  }
  result.byId = byId;
  return result;
}

// 進捗のしるし（2回続けて変わらなければ止める）。code はコードの中身のキー（codeKey。状態のコミットでは変わらない）
export function progressSignature(g, s, c, code) {
  return sha256(
    stable({
      code,
      nodes: g.nodes.map((n) => [n.id, s.nodes[n.id]?.status, s.nodes[n.id]?.attempts, s.nodes[n.id]?.roundsDone ?? 0]),
      ms: g.milestones.map((m) => [m.id, s.milestones[m.id]?.status, s.milestones[m.id]?.replans ?? 0]),
      proposals: (s.proposals ?? []).map((p) => [p.id, p.status]),
      approvals: c.approvals,
      plan: c.plan.approvedHash,
    }),
  ).slice(0, 16);
}

// 前のマイルストーンが開き直ったら、その後ろで検証・承認済みのものは、検証からやり直す（承認はコミットに紐づくので取り直しになる）
export function reopenLater(g, s, mid, why) {
  const idx = g.milestones.findIndex((m) => m.id === mid);
  const notes = [];
  for (const m of g.milestones.slice(idx + 1)) {
    const ms = s.milestones[m.id];
    if (!ms || !["verifying", "awaiting_approval", "done"].includes(ms.status)) continue;
    ms.status = "active";
    ms.reverify = why;
    notes.push(`${m.id}: 前のマイルストーン ${mid} が開き直ったので、全体検証からやり直す`);
  }
  return notes;
}

// 再計画の対象になったノード・マイルストーンを、もう一度実行できる状態に戻す
export function resetForReplan(s, items, note) {
  for (const x of items ?? []) {
    if (x.scope === "milestone") {
      const ms = s.milestones[x.id];
      if (ms?.status === "blocked") Object.assign(ms, { status: "active", feedback: "" });
      continue;
    }
    const ns = s.nodes[x.id];
    if (ns && ns.status !== "done") Object.assign(ns, { status: "pending", attempts: 0, round: 0, roundsDone: 0, resume: false, request: null, note: note.slice(0, 1000) });
  }
}

// ---------- 再計画の分類（承認済みの範囲で済むか） ----------

const SAME = (a, b) => stable(a) === stable(b);

// 人の確認が要る再計画の案を、誰が承認するか（受入基準・マイルストーン・目的・仕様に及ぶなら業務担当者も）
export function proposalRoles(reasons = []) {
  const roles = ["technical"];
  if (reasons.some((r) => /受入基準|マイルストーン|mission|spec|仕様/.test(String(r)))) roles.unshift("business");
  return roles;
}

export function classifyPlanChange(oldG, newG, s) {
  const reasons = [];
  const human = (r) => reasons.push(r);
  for (const k of ["version", "mission", "branch", "verify", "verifyFull", "spec", "limits", "dependencies"])
    if (!SAME(oldG[k], newG[k])) human(`${k} が変わる`);
  if (!SAME(oldG.milestones, newG.milestones)) human("マイルストーン（名前・承認者・release・foundation）が変わる");
  const acs = (g) => g.nodes.flatMap((n) => n.acceptance).sort();
  if (!SAME(acs(oldG), acs(newG))) human("受入基準（AC・BR）の集合が変わる");
  const oldById = new Map(oldG.nodes.map((n) => [n.id, n]));
  const newById = new Map(newG.nodes.map((n) => [n.id, n]));
  for (const [id, n] of oldById) {
    const st = s?.nodes?.[id]?.status;
    const nn = newById.get(id);
    if (st === "done") {
      if (!nn) human(`完了済みのノード ${id} を消す`);
      else if (!SAME({ ...n, goal: null }, { ...nn, goal: null })) human(`完了済みのノード ${id} を変える`);
      continue;
    }
    if (!nn) {
      if (n.before.length) human(`着手前の承認が要るノード ${id} を消す`);
      continue;
    }
    if (n.before.some((r) => !nn.before.includes(r))) human(`ノード ${id} の着手前の承認を外す`);
    if (!SAME(n.allowTestRemoval, nn.allowTestRemoval)) human(`ノード ${id} のテスト削除の許可を変える`);
    if (n.milestone !== nn.milestone) human(`ノード ${id} のマイルストーンを変える`);
  }
  for (const [id, nn] of newById) {
    if (oldById.has(id)) continue;
    if (nn.allowTestRemoval.length) human(`新しいノード ${id} にテスト削除の許可を付ける`);
    const st = s?.milestones?.[nn.milestone]?.status;
    if (st === "done") human(`完了済みのマイルストーン ${nn.milestone} にノード ${id} を足す`);
  }
  return { allowed: reasons.length === 0, reasons };
}

// ---------- 人の決定を実行の状態に反映する ----------
// 人のコマンド（approve / reject / answer / proposal）は controls.json だけに書く（ランナーが動いていても安全なように）。
// 状態（state.json）への反映は、ランナーが毎手の最初に、またはランナーが止まっていればコマンド自身が、この関数で行う。
// 戻り値: 反映した内容の説明（ログ用）
export function applyHumanDecisions(g, s, c) {
  const notes = [];
  c.rejections ??= {};
  c.proposals ??= {};
  if (c.pause && !c.pause.applied) {
    c.pause.applied = true;
    if (s.outer === "running") {
      s.outer = "paused";
      s.reason = c.pause.reason || "手動で一時停止";
      notes.push(`一時停止を反映（${s.reason}）`);
    }
  }
  for (const m of g.milestones) {
    const ms = s.milestones[m.id];
    if (!ms) continue;
    const rej = c.rejections[m.id];
    // 差し戻しは、承認待ちの同じ版（検証したコミット）に対して、そのマイルストーンの承認者の役割が行ったものだけを反映する
    if (rej && !rej.applied && ms.status === "awaiting_approval" && (rej.sha ?? null) === (ms.head ?? null)) {
      const roles = requiredRoles(c, m.id, ms.required ?? []);
      rej.applied = true;
      if (!roles.includes(rej.role)) {
        rej.ignored = `${m.id} の承認者（${roles.map((r) => ROLE_PERSON[r]).join("・") || "なし"}）ではない役割の差し戻し`;
        notes.push(`${m.id}: 差し戻しを反映しない（${rej.ignored}）`);
      } else {
        ms.status = "blocked";
        ms.feedback = `${ROLE_PERSON[rej.role]}による差し戻し: ${rej.note}`;
        notes.push(`${m.id}: 差し戻しを反映（${rej.note}）`);
        notes.push(...reopenLater(g, s, m.id, `${m.id} の差し戻し`));
        continue;
      }
    }
    if (ms.status === "awaiting_approval") {
      const roles = requiredRoles(c, m.id, ms.required ?? []);
      if (roles.length && isApproved(c, m.id, roles, { sha: ms.head })) {
        ms.status = "done";
        ms.approvedAt = nowIso();
        notes.push(`${m.id}: 必要な承認がそろったので完了`);
      }
    }
  }
  for (const [id, list] of Object.entries(c.answers ?? {})) {
    const ns = s.nodes[id];
    if (!ns) continue;
    for (const a of list) {
      if (a.applied) continue;
      a.applied = true;
      // 回答は、今の判断依頼（ID）に、依頼の種別の役割が答えたものだけを反映する
      const problem = answerProblem(id, ns, a);
      if (problem) {
        a.ignored = problem;
        notes.push(`${id}: 回答を反映しない（${problem}）`);
        continue;
      }
      ns.status = "pending";
      ns.note = `${ns.note ? `${ns.note}\n` : ""}判断依頼 ${a.request}（${ns.request.condition}）への${ROLE_PERSON[a.role]}の回答: ${a.note}`;
      ns.request = null;
      notes.push(`${id}: 判断依頼 ${a.request} への回答を反映`);
    }
  }
  for (const p of s.proposals ?? []) {
    const d = c.proposals[p.id];
    if (!d || p.status !== "needs_human" || !["accepted", "rejected"].includes(d.status)) continue;
    // 承認は必要な役割がすべて、却下は必要な役割のどれかが行ったものだけを反映する（合わなければ人の確認待ちに戻す）
    const needed = proposalNeededRoles(p.roles ?? [], d.needed ?? []);
    const problem =
      d.status === "rejected"
        ? needed.includes(d.role)
          ? null
          : `却下した役割（${ROLE_PERSON[d.role] ?? d.role ?? "記録なし"}）がこの案の確認者（${needed.map((r) => ROLE_PERSON[r]).join("・")}）ではない`
        : needed.every((r) => d.accepts?.[r])
          ? null
          : `承認がそろっていない（必要: ${needed.map((r) => ROLE_PERSON[r]).join("・")}）`;
    if (problem) {
      d.ignored = { status: d.status, role: d.role ?? null, reason: problem, at: nowIso() };
      d.status = "pending";
      notes.push(`再計画の案 ${p.id}: 人の決定を反映しない（${problem}）`);
      continue;
    }
    p.status = d.status;
    if (d.status === "accepted") {
      const note = `再計画の案 ${p.id} を人が承認: ${d.note ?? ""}`;
      resetForReplan(s, [...(d.changed ?? []).map((id) => ({ scope: "node", id })), ...(p.items ?? [])], note);
      for (const id of d.removed ?? []) delete s.nodes[id];
      const ms = s.milestones[p.milestone];
      if (ms?.status === "blocked") {
        ms.status = "active";
        ms.feedback = "";
      }
      notes.push(`再計画の案 ${p.id} を人が承認したので反映`);
    } else notes.push(`再計画の案 ${p.id} を人が却下`);
  }
  syncState(g, s);
  return notes;
}
