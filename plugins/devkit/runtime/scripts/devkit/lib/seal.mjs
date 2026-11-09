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
  updateAnchor(ctx);
}

// ---------- journal の錨（手元だけの記録。git では戻せない） ----------
// journal はコミットされるので、git revert などで記録ごと巻き戻せる。そこで、journal の行数と内容のハッシュを
// 手元（.devkit/cache/、コミットしない）に残し、今の journal がそれを伸ばしたもの（先頭が同じ）であることを確かめる。

function anchorPath(ctx) {
  return join(ctx.root, ".devkit", "cache", "journal-anchor.json");
}

function journalLines(ctx) {
  const p = join(ctx.root, JOURNAL);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
}

export function updateAnchor(ctx, { force = false } = {}) {
  try {
    const lines = journalLines(ctx);
    const prev = readAnchor(ctx);
    // 別のプロセスと同時に書いたときに、短い方で上書きしない（人が seal accept で受け入れたときだけ、今の journal で取り直す）
    if (!force && prev && prev.lines > lines.length) return;
    writeText(anchorPath(ctx), `${JSON.stringify({ lines: lines.length, hash: sha256(lines.join("\n")).slice(0, 32), at: nowIso() })}\n`);
  } catch {}
}

function readAnchor(ctx) {
  try {
    return JSON.parse(readFileSync(anchorPath(ctx), "utf8"));
  } catch {
    return null;
  }
}

// journal が、手元の錨より短くなった・先頭が書き換えられた（巻き戻された）なら、その説明を返す
export function journalProblem(ctx) {
  const a = readAnchor(ctx);
  if (!a || !Number.isInteger(a.lines)) return null;
  const lines = journalLines(ctx);
  if (lines.length < a.lines) return `判断の記録の journal（.devkit/journal.jsonl）が短くなった（${a.lines} 行 → ${lines.length} 行。git revert や reset で人の判断が巻き戻された可能性）`;
  if (sha256(lines.slice(0, a.lines).join("\n")).slice(0, 32) !== a.hash) return "判断の記録の journal（.devkit/journal.jsonl）の、前に書いた部分が書き換えられた";
  return null;
}

// 書く内容を先に journal に残してから書く（ランナーが途中の状態を見ても、人の記録と分かるように）
export function journalWrite(ctx, rel, text, command) {
  mkdirSync(join(ctx.root, ".devkit"), { recursive: true });
  appendFileSync(join(ctx.root, JOURNAL), `${JSON.stringify({ at: nowIso(), pid: process.pid, command, files: { [rel]: sha256(text).slice(0, 32) } })}\n`);
  updateAnchor(ctx);
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

// devkit のコマンドとランナーだけが書く記録。コミット済みの内容も、journal（人のコマンドとランナーのコミット）か、
// 前回のランナーが書いた内容と合うこと（コミットしてしまえば受け入れられる、という抜け道を塞ぐ）
export const DEVKIT_WRITTEN = [".devkit/state.json", ".devkit/controls.json", "docs/exceptions.json"];

function isEmptyExceptions(ctx) {
  try {
    const doc = JSON.parse(readFileSync(join(ctx.root, "docs", "exceptions.json"), "utf8"));
    return Array.isArray(doc?.exceptions) && doc.exceptions.length === 0;
  } catch {
    return false;
  }
}

// 起動の前に: コミット済みかどうかに関係なく、今の内容を説明できない記録を返す。
// 今の内容が、そのファイルの journal の「最後の」記録か、それより後に前回のランナーが書いた内容と合うこと
// （前の記録と合うだけでは足りない。git revert で人の判断を巻き戻した状態を受け入れないため）
export function committedUnexplained(ctx, previousRun = null) {
  const entries = readJournal(ctx, 0);
  const prev = previousRun?.sealed ?? {};
  const prevAt = Date.parse(previousRun?.heartbeatAt ?? previousRun?.endedAt ?? 0) || 0;
  const out = [];
  for (const f of DEVKIT_WRITTEN) {
    const h = hashOf(ctx, f);
    if (h === "missing") continue;
    const last = entries.filter((e) => e.files?.[f] !== undefined).at(-1);
    if (!last) {
      if (f === "docs/exceptions.json" && isEmptyExceptions(ctx)) continue;
      if (prev[f] === h) continue;
      out.push(f);
      continue;
    }
    if (last.files[f] === h) continue;
    if (prev[f] === h && prevAt >= Date.parse(last.at) - 1000) continue;
    out.push(f);
  }
  return out;
}

