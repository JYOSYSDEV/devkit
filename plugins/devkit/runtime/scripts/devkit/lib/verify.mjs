// ランナーの機械検証。AI の作業ディレクトリではなく、ランナーが対象コミットから取り出したものだけを使う。
//   - 静的な検査（ホストで。リポジトリのコードは実行しない）: 変更の範囲（owns）と保護されたパス、リンク・入れ子のリポジトリ、
//     テストの弱体化、標準チェッカー（違反と、人の確認が要る変更のフラグ）
//   - 検証コマンド（lint・型・標準チェック・テスト）: 対象コミットを git の外に取り出し、コンテナの中で実行（isolation.mjs）
//   - 実行されたテストの棚卸し（基準のコミットから減っていないか）と、受入基準のトレース（実行されて合格したテストだけ）
//   - 実行範囲の外に置かれたテストファイル
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, posix, relative } from "node:path";
import { isProtectedPath, isSharedPath, isTestish, weakeningOf } from "../shared.mjs";
import { changedFiles, diffLines, git, isCommit, lsTree, showFile } from "./git.mjs";
import { copyScreens, isolationConfig, runIsolated, runProcess, safeReadJson, sanitizedHostEnv, workBase } from "./isolation.mjs";
import { matchesAny, readJson, sha256, tail, writeJson } from "./util.mjs";

// ---------- コマンドの実行（ホスト。実装担当の作業ディレクトリでの依存のインストールに使う） ----------

export function sanitizedEnv(extra = {}) {
  return { ...sanitizedHostEnv(), DEVKIT_VERIFY: "1", DEVKIT_RUNNER: "1", FORCE_COLOR: "0", ...extra };
}

export function runCommand(command, { cwd, timeoutMs, env = {}, logFile }) {
  return runProcess(command, [], { cwd, env: sanitizedEnv(env), timeoutMs, logFile, shell: true });
}

// ---------- git の置き場所 ----------

const GIT_DIRS = new Map();
export function mainGitDir(ctx) {
  if (!GIT_DIRS.has(ctx.root)) {
    const r = git(ctx.root, ["rev-parse", "--absolute-git-dir"]);
    if (r.code !== 0) throw new Error(`git のディレクトリが分かりません: ${r.err}`);
    GIT_DIRS.set(ctx.root, r.out);
  }
  return GIT_DIRS.get(ctx.root);
}

function identityArgs(ctx) {
  const id = [];
  if (!git(ctx.root, ["config", "user.name"]).out) id.push("-c", "user.name=devkit-runner");
  if (!git(ctx.root, ["config", "user.email"]).out) id.push("-c", "user.email=devkit-runner@localhost");
  return id;
}

function rand() {
  return `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 実装担当の作業ディレクトリ（リポジトリの外の、独立した clone） ----------
// 作業ディレクトリの .git は AI が書き換えられるので、ランナーはその中の git を使わない。
// 結果は、本体の git ディレクトリと一時的な index で作業ディレクトリのファイルを読み、コミットにする（collectWork）。

export function implDirPath(ctx, config, name) {
  return join(workBase(ctx, config), `impl-${name}`);
}

export function prepareImplDir(ctx, config, { name, branch, base, resume = false, message = "中断時点の作業" }) {
  const path = implDirPath(ctx, config, name);
  let start = base;
  const tipRef = git(ctx.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).out;
  if (resume && tipRef) {
    start = tipRef;
    if (existsSync(path)) {
      const got = collectWork(ctx, config, path, { branch, parent: tipRef, message });
      if (got.ok) start = got.tip;
    }
  }
  rmSync(path, { recursive: true, force: true });
  const cl = git(ctx.root, ["clone", "-q", "--shared", "--no-checkout", ctx.root, path]);
  if (cl.code !== 0) throw new Error(`作業ディレクトリを作れませんでした: ${cl.err}`);
  const inClone = { cwd: path, env: { GIT_DIR: join(path, ".git"), GIT_WORK_TREE: path } };
  for (const args of [
    ["checkout", "-q", "-B", branch, start],
    ["remote", "remove", "origin"],
    ["config", "user.name", "devkit-implementer"],
    ["config", "user.email", "devkit-implementer@localhost"],
  ]) {
    const r = git(ctx.root, args, inClone);
    if (r.code !== 0 && args[0] === "checkout") throw new Error(`作業ディレクトリを ${start.slice(0, 10)} に合わせられませんでした: ${r.err}`);
  }
  git(ctx.root, ["update-ref", `refs/heads/${branch}`, start]);
  return { path, start };
}

// 作業ディレクトリのファイルを、parent の続きのコミットにする（変更がなければ parent を返す）
export function collectWork(ctx, config, path, { branch, parent, message }) {
  const idx = join(workBase(ctx, config), `.index-${basename(path)}-${rand()}`);
  const env = { GIT_INDEX_FILE: idx, GIT_DIR: mainGitDir(ctx), GIT_WORK_TREE: path };
  try {
    let r = git(ctx.root, ["read-tree", parent], { cwd: path, env });
    if (r.code !== 0) return { ok: false, error: `基準を読めませんでした: ${r.err}` };
    r = git(ctx.root, ["add", "-A", "--", "."], { cwd: path, env });
    if (r.code !== 0) return { ok: false, error: `変更を取り込めませんでした（入れ子の git リポジトリなど）: ${r.err.split("\n").slice(-2).join(" ")}` };
    const tree = git(ctx.root, ["write-tree"], { cwd: path, env }).out;
    const parentTree = git(ctx.root, ["rev-parse", `${parent}^{tree}`]).out;
    if (!tree) return { ok: false, error: "変更をまとめられませんでした" };
    if (tree === parentTree) return { ok: true, tip: parent, changed: false };
    const c = git(ctx.root, [...identityArgs(ctx), "commit-tree", tree, "-p", parent, "-m", message]);
    if (c.code !== 0 || !c.out) return { ok: false, error: `コミットを作れませんでした: ${c.err}` };
    git(ctx.root, ["update-ref", `refs/heads/${branch}`, c.out]);
    return { ok: true, tip: c.out, changed: true };
  } finally {
    rmSync(idx, { force: true });
  }
}

export function removeImplDir(path) {
  if (path) rmSync(path, { recursive: true, force: true });
}

// ---------- レビューと標準チェッカー用の取り出し（ホスト。リポジトリのコードは実行しない） ----------

export function checkout(ctx, config, name, sha) {
  const path = join(workBase(ctx, config), `co-${name}`);
  removeCheckout(ctx, { path });
  const r = git(ctx.root, ["worktree", "add", "--detach", "--force", path, sha]);
  if (r.code !== 0) throw new Error(`取り出しを作れませんでした: ${r.err}`);
  const pointer = readFileSync(join(path, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!pointer) throw new Error("取り出しの git ディレクトリが分かりません");
  const co = { path, gitDir: pointer, sha };
  const st = checkoutState(ctx, co);
  if (st.head !== sha || st.dirty) throw new Error(`取り出しがクリーンになりませんでした（${st.head.slice(0, 10)}、変更: ${st.dirty.slice(0, 200)}）`);
  return co;
}

// 取り出しの中の .git ファイルは信用せず、作ったときの git ディレクトリを使う
export function checkoutState(ctx, co) {
  const env = { GIT_DIR: co.gitDir, GIT_WORK_TREE: co.path };
  const head = git(ctx.root, ["rev-parse", "HEAD"], { cwd: co.path, env }).out;
  const dirty = git(ctx.root, ["status", "--porcelain", "--untracked-files=all"], { cwd: co.path, env }).out;
  return { head, dirty };
}

export function removeCheckout(ctx, co) {
  if (!co?.path) return;
  git(ctx.root, ["worktree", "remove", "--force", co.path]);
  rmSync(co.path, { recursive: true, force: true });
}

// 作業場所の片付け。impl-* は keep にあるもの以外を消す（keepImpl: true なら全部残す）
export function pruneWork(ctx, config, { keep = [], keepImpl = false } = {}) {
  git(ctx.root, ["worktree", "prune"]);
  let base;
  try {
    base = workBase(ctx, config);
  } catch {
    return;
  }
  for (const name of readdirSync(base)) {
    if (name.startsWith(".devkit-workbase")) continue;
    const p = join(base, name);
    if (keep.includes(p)) continue;
    if (name.startsWith("impl-") && keepImpl) continue;
    if (name.startsWith("co-")) removeCheckout(ctx, { path: p });
    else rmSync(p, { recursive: true, force: true });
  }
  git(ctx.root, ["worktree", "prune"]);
}

// ---------- 検証用の取り出し（git の外の普通のフォルダ） ----------

export function exportTree(ctx, config, sha, label) {
  const dir = join(workBase(ctx, config), `x-${String(label).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}-${rand()}`);
  mkdirSync(dir, { recursive: true });
  const idx = `${dir}.index`;
  const env = { GIT_INDEX_FILE: idx, GIT_DIR: mainGitDir(ctx), GIT_WORK_TREE: dir };
  try {
    let r = git(ctx.root, ["read-tree", sha], { cwd: dir, env });
    if (r.code === 0) r = git(ctx.root, ["checkout-index", "-a", "-f"], { cwd: dir, env });
    if (r.code !== 0) throw new Error(`検証用に ${sha.slice(0, 10)} を取り出せませんでした: ${r.err}`);
  } finally {
    rmSync(idx, { force: true });
  }
  return dir;
}

// 取り出して、依存のインストールと検証コマンドを（コンテナの中で）実行し、結果を読む。取り出したものは消す
export async function runVerification(ctx, config, g, { sha, full, timeoutMs, logDir, label, screensDir = null }) {
  const iso = isolationConfig(config);
  const dir = exportTree(ctx, config, sha, label);
  const screensTmp = screensDir ? join(workBase(ctx, config), `s-${label}-${rand()}`) : null;
  if (screensTmp) mkdirSync(screensTmp, { recursive: true });
  try {
    const install = await runIsolated(ctx, config, {
      phase: "install",
      dir,
      command: config.installCommand ?? DEFAULT_INSTALL,
      timeoutMs: Math.min(timeoutMs, 20 * 60_000),
      logFile: join(logDir, `${label}-install.log`),
      label,
    });
    if (install.envError) return { envError: true, reason: install.out.split("\n").find((l) => l.trim()) ?? "コンテナを使えません", install, verify: null, reports: emptyReports() };
    let verify = null;
    if (install.code === 0) {
      verify = await runIsolated(ctx, config, {
        phase: "verify",
        dir,
        command: full ? g.verifyFull : g.verify,
        timeoutMs,
        logFile: join(logDir, `${label}-verify.log`),
        screens: screensTmp,
        label,
      });
      if (verify.envError) return { envError: true, reason: verify.out.split("\n").find((l) => l.trim()) ?? "コンテナを使えません", install, verify, reports: emptyReports() };
    }
    const reports = readReports(dir, { inner: iso.mode === "none" ? dir : "/work" });
    if (screensDir && screensTmp) copyScreens(screensTmp, screensDir);
    return { install, verify, reports };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (screensTmp) rmSync(screensTmp, { recursive: true, force: true });
  }
}

// ---------- テストの結果 ----------

const ID_RE = /\b((?:AC|BR)-\d+)(?!\d)/g;

function emptyReports() {
  return { tests: [], files: { unit: new Set(), e2e: new Set() }, hasUnit: false, hasE2e: false };
}

// dir: 取り出したフォルダ（ホスト側）。inner: テストを実行した側から見た同じフォルダ（コンテナなら /work）
export function readReports(dir, { inner = dir } = {}) {
  const tests = [];
  const files = { unit: new Set(), e2e: new Set() };
  const isPosix = inner.startsWith("/");
  const rel = (p) => (isPosix ? posix.relative(inner, String(p ?? "").replaceAll("\\", "/")) : relative(inner, String(p ?? ""))).replaceAll("\\", "/");
  const joinIn = (a, b) => (isPosix ? posix.join(a, b) : join(a, b));
  const vitest = safeReadJson(dir, "test-reports/vitest.json");
  if (vitest?.testResults && Array.isArray(vitest.testResults)) {
    for (const f of vitest.testResults) {
      const file = rel(f?.name);
      files.unit.add(file);
      for (const t of Array.isArray(f?.assertionResults) ? f.assertionResults : []) {
        tests.push({ kind: "unit", file, name: String(t?.fullName ?? t?.title ?? ""), passed: t?.status === "passed" });
      }
    }
  }
  const e2e = safeReadJson(dir, "test-reports/e2e.json");
  if (e2e?.suites && Array.isArray(e2e.suites)) {
    const rootDir = typeof e2e.config?.rootDir === "string" ? e2e.config.rootDir : joinIn(inner, "e2e");
    const visit = (suite, titles, depth = 0) => {
      if (!suite || depth > 50) return;
      const here = suite.title && !/\.[cm]?[jt]sx?$/.test(suite.title) ? [...titles, String(suite.title)] : titles;
      const file = suite.file ? rel(joinIn(rootDir, String(suite.file))) : null;
      if (file) files.e2e.add(file);
      for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
        const ts = Array.isArray(spec.tests) ? spec.tests : [];
        const inverted = ts.some((t) => (t.annotations ?? []).some((a) => a.type === "fail"));
        const passed = Boolean(spec.ok) && ts.length > 0 && ts.every((t) => t.status === "expected" || t.status === "flaky") && !inverted;
        tests.push({ kind: "e2e", file: file ?? (spec.file ? rel(joinIn(rootDir, String(spec.file))) : "?"), name: [...here, String(spec.title ?? "")].join(" › "), passed });
      }
      for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child, here, depth + 1);
    };
    for (const s of e2e.suites) visit(s, []);
  }
  return { tests, files, hasUnit: Boolean(vitest?.testResults), hasE2e: Boolean(e2e?.suites) };
}

export function inventoryOf(reports) {
  const inv = { unit: reports.hasUnit ? {} : null, e2e: reports.hasE2e ? {} : null };
  for (const t of reports.tests) {
    const bucket = inv[t.kind];
    if (!bucket) continue;
    bucket[t.file] ??= 0;
    if (t.passed) bucket[t.file] += 1;
  }
  return inv;
}

export function compareInventory(base, now, { allowRemoval = [] } = {}) {
  const problems = [];
  for (const kind of ["unit", "e2e"]) {
    if (!base?.[kind]) continue;
    if (!now?.[kind]) {
      if (Object.keys(base[kind]).length) problems.push(`${kind === "unit" ? "単体" : "E2E"}テストの結果が出ていない（前回は ${Object.keys(base[kind]).length} ファイル）`);
      continue;
    }
    for (const [file, count] of Object.entries(base[kind])) {
      if (matchesAny(file, allowRemoval)) continue;
      const cur = now[kind][file];
      if (cur === undefined) problems.push(`${file}: 前回は合格していたテスト（${count} 件）のファイルが、今回の実行に出てこない`);
      else if (cur < count) problems.push(`${file}: 合格したテストが ${count} 件から ${cur} 件に減った`);
    }
  }
  return problems;
}

export function tracedIds(reports) {
  const ids = new Set();
  for (const t of reports.tests) if (t.passed) for (const m of t.name.matchAll(ID_RE)) ids.add(m[1]);
  return ids;
}

// 実行範囲の外に置かれたテストファイル（名前はテストなのに、レポートに出てこない）
export function strayTests(ctx, sha, reports) {
  const files = lsTree(ctx.root, sha) ?? [];
  const stray = [];
  for (const f of files) {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.includes("node_modules/")) continue;
    if (/^e2e\//.test(f)) {
      if (reports.hasE2e && !reports.files.e2e.has(f)) stray.push(f);
      continue;
    }
    if (!reports.files.unit.has(f)) stray.push(f);
  }
  return [...new Set(stray)];
}

// ---------- 差分の検査 ----------

export function scopeProblems(changed, owns) {
  const problems = [];
  for (const f of changed) {
    if (f.startsWith(".devkit/")) {
      problems.push(`${f}: .devkit/ は devkit が管理する（作業では変更しない）`);
      continue;
    }
    if (isProtectedPath(f) || isSharedPath(f)) {
      problems.push(`${f}: 共有ファイル・保護されたパスは作業では変更できない（必要なら報告の needs に書く）`);
      continue;
    }
    if (!matchesAny(f, owns)) problems.push(`${f}: owns の外のファイルを変更した`);
  }
  return problems;
}

// シンボリックリンク（120000）と入れ子のリポジトリ（160000）は作業では追加しない（検証や読み取りがリポジトリの外を指す）
export function modeProblems(ctx, sha, changed) {
  if (!changed.length) return [];
  const r = git(ctx.root, ["ls-tree", "-r", "-z", sha, "--", ...changed]);
  if (r.code !== 0) return ["変更したファイルの種類を確かめられませんでした（安全のため不合格）"];
  const problems = [];
  for (const entry of r.raw.split("\0").filter(Boolean)) {
    const m = entry.match(/^(\d{6}) \w+ [0-9a-f]+\t(.+)$/);
    if (!m) continue;
    if (m[1] === "120000") problems.push(`${m[2]}: シンボリックリンクは追加・変更しない`);
    if (m[1] === "160000") problems.push(`${m[2]}: 入れ子の git リポジトリ（サブモジュール）は追加しない`);
  }
  return problems;
}

export function weakeningProblems(ctx, base, tip, changed, { allowRemoval = [] } = {}) {
  const problems = [];
  const tests = changed.filter(isTestish);
  if (!tests.length) return problems;
  const lines = diffLines(ctx.root, base, tip, { paths: tests });
  if (lines === null) return ["テストの差分を取れませんでした（安全のため不合格）"];
  for (const f of tests) {
    const before = showFile(ctx.root, base, f);
    const after = showFile(ctx.root, tip, f);
    if (after === null) {
      if (before !== null && !matchesAny(f, allowRemoval)) problems.push(`${f}: テストファイルを削除した`);
      continue;
    }
    for (const p of weakeningOf(before ?? "", after)) problems.push(`${f}: ${p}`);
  }
  return problems;
}

// ---------- 標準チェッカー ----------
// 使うのは本体の作業ツリーの scripts/standard/check.mjs（統合ブランチのもの）。取り出しの中のものは実行しない。
export function runChecker(ctx, co, { base = null, head = null, release = false } = {}) {
  const broken = (message) => ({
    ok: false,
    violations: [{ rule: "STANDARD", message }],
    flags: [{ rule: "SEC-12", role: "technical", message: `${message}。変更全体を技術ゲートで確認する`, items: [] }],
    warnings: [],
  });
  if (!existsSync(ctx.checker)) return broken("標準チェッカー（scripts/standard/check.mjs）がない");
  const args = [ctx.checker, "--json"];
  if (release) args.push("--release");
  if (base !== null) args.push("--base", String(base));
  if (base !== null && head !== null) args.push("--head", String(head));
  const env = { ...sanitizedHostEnv(), GIT_DIR: co.gitDir, GIT_WORK_TREE: co.path, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: join(ctx.root, ".devkit", "cache", "no-hooks") };
  const r = spawnSync(process.execPath, args, { cwd: co.path, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env, timeout: 300_000 });
  try {
    const out = JSON.parse(r.stdout);
    if (!Array.isArray(out.violations) || !Array.isArray(out.flags)) throw new Error("形式が不正");
    return out;
  } catch {
    return broken(`標準チェッカーの結果を読めませんでした: ${tail(r.stderr || r.stdout || r.error?.message || "", 5)}`);
  }
}

// ---------- まとめた検査 ----------

export const DEFAULT_INSTALL = "pnpm install --frozen-lockfile --prefer-offline";

// 棚卸しは「コードの中身」で引く（.devkit/ と判断の記録だけが違うコミットは同じ中身として扱う）
export function codeKey(ctx, sha) {
  const r = git(ctx.root, ["ls-tree", "-r", sha]);
  if (r.code !== 0) return sha;
  const lines = r.raw.split("\n").filter((l) => l && !/\t(\.devkit\/|docs\/decisions\.md$)/.test(l));
  return sha256(lines.join("\n")).slice(0, 24);
}

export function inventoryFile(ctx, sha) {
  return join(ctx.cache, `inventory-${codeKey(ctx, sha)}.json`);
}

function verifyFailure(g, full, verify) {
  return `\`${full ? g.verifyFull : g.verify}\` が失敗（exit ${verify.code}${verify.timedOut ? "、時間切れ" : ""}）\n${tail(verify.out, 60)}`;
}

// 統合ブランチのある時点を検証し、テストの棚卸しを保存する（ノードの比較の基準になる）
export async function snapshot(ctx, config, g, { head, prevHead = null, full = false, logDir, screensDir = null, label = "snapshot", allowRemoval = [] }) {
  const failures = [];
  const timeoutMs = g.limits.verifyTimeoutMinutes * 60_000;
  let prev = null;
  if (prevHead) {
    prev = readJson(inventoryFile(ctx, prevHead), null);
    if (!prev) {
      const p = await ensureInventory(ctx, config, g, prevHead, logDir);
      if (p.envError) return { ok: false, envError: true, reason: p.reason, failures: [p.reason], reports: emptyReports(), inventory: null };
      if (!p.ok) failures.push(`比較の基準（${prevHead.slice(0, 10)}）の検証が通らない: ${p.failures[0]?.split("\n")[0] ?? ""}`);
      prev = p.inventory;
    }
  }
  const run = await runVerification(ctx, config, g, { sha: head, full, timeoutMs, logDir, label, screensDir });
  if (run.envError) return { ok: false, envError: true, reason: run.reason, failures: [run.reason], reports: run.reports, inventory: null };
  const { install, verify, reports } = run;
  if (install.code !== 0) failures.push(`依存のインストールに失敗（exit ${install.code}）\n${tail(install.out, 30)}`);
  if (verify && verify.code !== 0) failures.push(verifyFailure(g, full, verify));
  if (verify && !reports.hasUnit) failures.push("テストの結果（test-reports/vitest.json）が出ていない。検証コマンドかテストの設定が変わっていないか");
  if (full && verify && !reports.hasE2e) failures.push("E2E の結果（test-reports/e2e.json）が出ていない");
  const inventory = inventoryOf(reports);
  if (prevHead) {
    if (prev) failures.push(...compareInventory(prev, inventory, { allowRemoval }).map((p) => `統合後のテスト: ${p}`));
    const changed = changedFiles(ctx.root, prevHead, head);
    if (changed === null) failures.push("統合の差分を取れませんでした（安全のため不合格）");
    else {
      const code = changed.filter((f) => !f.startsWith(".devkit/") && f !== "docs/decisions.md");
      const prot = code.filter((f) => (isProtectedPath(f) || isSharedPath(f)) && !/^(package\.json|pnpm-lock\.yaml)$/.test(f));
      if (prot.length) failures.push(`統合で保護されたファイルが変わった: ${prot.join(", ")}`);
      failures.push(...modeProblems(ctx, head, code));
      failures.push(...weakeningProblems(ctx, prevHead, head, code, { allowRemoval }));
    }
  }
  const stray = strayTests(ctx, head, reports);
  if (verify?.code === 0 && reports.hasUnit && stray.length) failures.push(`実行されないテストファイル: ${stray.join(", ")}`);
  if (failures.length === 0) writeJson(inventoryFile(ctx, head), inventory);
  return { ok: failures.length === 0, failures, reports, inventory, verify };
}

// 同じ中身の基準を、並列のノードが同時に検証しないようにまとめる
const INFLIGHT = new Map();

export async function ensureInventory(ctx, config, g, sha, logDir) {
  const f = inventoryFile(ctx, sha);
  const have = readJson(f, null);
  if (have) return { ok: true, inventory: have, failures: [] };
  const key = `${ctx.root}\u0000${codeKey(ctx, sha)}`;
  if (!INFLIGHT.has(key)) {
    INFLIGHT.set(
      key,
      snapshot(ctx, config, g, { head: sha, logDir, label: `base-${sha.slice(0, 8)}` }).finally(() => INFLIGHT.delete(key)),
    );
  }
  const snap = await INFLIGHT.get(key);
  return { ok: snap.ok, inventory: snap.inventory, failures: snap.failures, envError: snap.envError, reason: snap.reason };
}

// ノードの機械検証。合格すれば、結果を対象コミットに紐づけた証拠として返す。
// 返り値の checkout（レビュー用の取り出し）は、呼んだ側が removeCheckout で片付ける。
export async function integrityNode(ctx, config, g, node, { base, tip, logDir, label }) {
  const failures = [];
  const checks = {};
  const record = (name, ok, detail = []) => {
    checks[name] = { ok, detail };
    if (!ok) failures.push(...detail.map((d) => `[${name}] ${d}`));
  };
  const done = (extra = {}) => ({ ok: failures.length === 0, failures, checks, base, tip, flags: [], ...extra });
  if (!isCommit(ctx.root, base) || !isCommit(ctx.root, tip)) {
    record("base", false, [`基準 ${base} か対象 ${tip} のコミットが見つからない（安全のため不合格）`]);
    return done();
  }
  const changed = changedFiles(ctx.root, base, tip);
  if (changed === null) {
    record("diff", false, ["差分を取れなかった（安全のため不合格）"]);
    return done();
  }
  if (!changed.length) record("diff", false, ["変更がない（goal を満たす実装がコミットされていない）"]);
  const scope = [...scopeProblems(changed, node.owns), ...modeProblems(ctx, tip, changed)];
  record("scope", scope.length === 0, scope);
  const weak = weakeningProblems(ctx, base, tip, changed, { allowRemoval: node.allowTestRemoval });
  record("weakening", weak.length === 0, weak);
  // 範囲の外（共有ファイル・設定・リンク）を変えたものは、検証コマンドを実行しない（検証そのものを変えられるため）
  if (scope.length) return done();

  const co = checkout(ctx, config, `${node.id}`, tip);
  const checker = runChecker(ctx, co, { base, head: tip });
  record("standard", checker.ok !== false && checker.violations.length === 0, checker.violations.map((v) => `${v.rule} ${v.file ?? ""}${v.line ? `:${v.line}` : ""} ${v.message}`));

  const baseInv = await ensureInventory(ctx, config, g, base, logDir);
  if (baseInv.envError) {
    removeCheckout(ctx, co);
    return done({ envError: true, reason: baseInv.reason });
  }
  if (!baseInv.ok) record("base", false, [`基準のコミット ${base.slice(0, 10)} の検証が通らない（比較できないので不合格）: ${baseInv.failures[0]?.split("\n")[0] ?? ""}`]);
  const full = node.verify === "full";
  const timeoutMs = g.limits.verifyTimeoutMinutes * 60_000;
  const run = await runVerification(ctx, config, g, { sha: tip, full, timeoutMs, logDir, label });
  if (run.envError) {
    removeCheckout(ctx, co);
    return done({ envError: true, reason: run.reason });
  }
  const { install, verify, reports } = run;
  record("install", install.code === 0, install.code === 0 ? [] : [`依存のインストールに失敗（exit ${install.code}）\n${tail(install.out, 20)}`]);
  if (verify) record("verify", verify.code === 0, verify.code === 0 ? [] : [verifyFailure(g, full, verify)]);
  const inventory = inventoryOf(reports);
  if (verify && !reports.hasUnit) record("reports", false, ["テストの結果（test-reports/vitest.json）が出ていない。検証コマンドかテストの設定が変わっていないか"]);
  if (baseInv.ok) {
    const inv = compareInventory(baseInv.inventory, inventory, { allowRemoval: node.allowTestRemoval });
    record("inventory", inv.length === 0, inv);
  }
  const stray = reports.hasUnit ? strayTests(ctx, tip, reports) : [];
  record("stray", stray.length === 0, stray.map((f) => `${f}: テストの名前なのに実行されていない（vitest の対象は tests/ と src/ の *.test.ts(x)、E2E は e2e/）`));
  const ids = tracedIds(reports);
  const missing = node.acceptance.filter((a) => !ids.has(a));
  const deferred = [];
  if (missing.length) {
    if (full) record("trace", false, missing.map((a) => `${a}: 番号をテスト名に含み、実行されて合格したテストがない`));
    else deferred.push(...missing); // E2E で確かめる AC はマイルストーンの全体検証で照合する
  }
  if (!checks.trace) record("trace", true);
  return {
    ...done(),
    flags: checker.flags ?? [],
    deferredAcs: deferred,
    inventory,
    tests: { passed: reports.tests.filter((t) => t.passed).length, total: reports.tests.length },
    checkout: co,
    at: new Date().toISOString(),
  };
}

export function summarizeIntegrity(ev) {
  const lines = [];
  for (const [name, c] of Object.entries(ev.checks ?? {})) lines.push(`- ${name}: ${c.ok ? "合格" : "不合格"}`);
  if (ev.tests) lines.push(`- テスト: 合格 ${ev.tests.passed} / ${ev.tests.total}`);
  if (ev.deferredAcs?.length) lines.push(`- マイルストーンの全体検証（E2E）で照合する受入基準: ${ev.deferredAcs.join(", ")}`);
  if (ev.flags?.length) lines.push(`- 人の確認が要る変更: ${ev.flags.map((f) => `${f.rule}`).join(", ")}`);
  return lines.join("\n");
}
