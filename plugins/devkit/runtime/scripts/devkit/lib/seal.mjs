// 改ざんの検出（封印）。ランナーの実行中、承認・計画・判断の記録・devkit 自身のファイルが、
// ランナー自身と人のコマンド（journal に記録が残る）以外から変わっていないかを確かめる。
//
// - ランナーが自分で書いたファイルは、書いた直後の内容を「期待する内容」として覚える（note）
// - 人のコマンド（approve など）は、書いた後に .devkit/journal.jsonl に、書いたファイルとその内容のハッシュを残す（journal）
// - check: 今の内容が、期待する内容とも journal の記録とも合わないファイルを返す
//
// 同じ利用者の権限で動くプログラムは journal も書けるため、これは隔離（コンテナ・サンドボックス）を補うもので、置き換えではない。
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";
import { nowIso, sha256, writeText } from "./util.mjs";

export const SEALED_FILES = [
  ".devkit/state.json",
  ".devkit/controls.json",
  ".devkit/graph.json",
  ".devkit/mission.md",
  ".devkit/config.json",
  ".devkit/version.json",
  "docs/decisions.md",
  "docs/exceptions.json",
  "docs/profile.json",
];
export const SEALED_DIRS = ["scripts/devkit", "scripts/standard", "docs/standard", ".claude"];

export const JOURNAL = ".devkit/journal.jsonl";

function hashFile(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `link:${sha256(String(st.size))}`;
    if (!st.isFile()) return "not-a-file";
    return sha256(readFileSync(p)).slice(0, 32);
  } catch {
    return "missing";
  }
}

function listDir(root, rel, out) {
  let names;
  try {
    names = readdirSync(join(root, rel));
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const r = `${rel}/${n}`;
    let st;
    try {
      st = lstatSync(join(root, r));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (r === ".claude/worktrees") continue;
      listDir(root, r, out);
    } else if (r !== ".claude/settings.local.json") out.push(r);
  }
}

// 封印の対象と、その内容のハッシュ
export function sealedHashes(ctx) {
  const files = [...SEALED_FILES];
  for (const d of SEALED_DIRS) listDir(ctx.root, d, files);
  const map = new Map();
  for (const f of files) map.set(f, hashFile(join(ctx.root, f)));
  const gitDir = git(ctx.root, ["rev-parse", "--absolute-git-dir"]).out;
  if (gitDir) map.set("<git>/config", hashFile(join(gitDir, "config")));
  // 封印したディレクトリに新しく置かれたファイルも分かるように、一覧そのものも記録する
  for (const d of SEALED_DIRS) map.set(`<list>/${d}`, sha256(files.filter((f) => f.startsWith(`${d}/`)).join("\n")).slice(0, 32));
  return map;
}

export function hashOf(ctx, rel) {
  return hashFile(join(ctx.root, rel));
}

// 人のコマンドが書いたファイルを記録する
export function journal(ctx, command, rels) {
  const files = {};
  for (const r of rels) files[r] = hashOf(ctx, r);
  mkdirSync(join(ctx.root, ".devkit"), { recursive: true });
  appendFileSync(join(ctx.root, JOURNAL), `${JSON.stringify({ at: nowIso(), pid: process.pid, command, files })}\n`);
}

// 書く内容を先に journal に残してから書く（ランナーが途中の状態を見ても、人の記録と分かるように）
export function journalWrite(ctx, rel, text, command) {
  mkdirSync(join(ctx.root, ".devkit"), { recursive: true });
  appendFileSync(join(ctx.root, JOURNAL), `${JSON.stringify({ at: nowIso(), pid: process.pid, command, files: { [rel]: sha256(text).slice(0, 32) } })}\n`);
  writeText(join(ctx.root, rel), text);
}

export function readJournal(ctx, sinceMs = 0) {
  const p = join(ctx.root, JOURNAL);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.at) >= sinceMs - 1000) out.push(e);
    } catch {}
  }
  return out;
}

export class Seal {
  constructor(ctx) {
    this.ctx = ctx;
    this.expected = new Map();
    this.since = Date.now();
  }

  start() {
    this.since = Date.now();
    this.expected = sealedHashes(this.ctx);
    return this;
  }

  // ランナーが書いたファイル（相対パス）
  note(...rels) {
    for (const r of rels) this.expected.set(r, hashOf(this.ctx, r));
  }

  // 前回の実行の記録（run.json）に残す
  toJSON() {
    return Object.fromEntries(this.expected);
  }

  // 期待とも journal とも合わないファイル
  check() {
    const now = sealedHashes(this.ctx);
    const entries = readJournal(this.ctx, this.since);
    const bad = [];
    for (const [k, v] of now) {
      const want = this.expected.get(k);
      if (want === v) continue;
      if (want === undefined && v === "missing") continue;
      if (entries.some((e) => e.files?.[k] === v)) {
        this.expected.set(k, v);
        continue;
      }
      bad.push({ path: k, expected: want ?? "(なし)", actual: v });
    }
    for (const [k] of this.expected) if (!now.has(k)) bad.push({ path: k, expected: this.expected.get(k), actual: "missing" });
    return bad;
  }
}

// 起動の前に: 未コミットの変更がある封印の対象は、journal の記録か、前回のランナーが書いた内容と合うこと
export function uncommittedUnexplained(ctx, previousRun = null) {
  const r = git(ctx.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...SEALED_FILES, ...SEALED_DIRS]);
  const dirty = r.raw
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3));
  if (!dirty.length) return [];
  const entries = readJournal(ctx, 0);
  const prev = previousRun?.sealed ?? {};
  return dirty.filter((f) => {
    const h = hashOf(ctx, f);
    if (prev[f] === h) return false;
    return !entries.some((e) => e.files?.[f] === h);
  });
}
