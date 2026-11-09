#!/usr/bin/env node
// 社内標準の準拠チェッカー（docs/standard/rules.json の check: "auto" と "flag" を検査する）
//
//   node scripts/standard/check.mjs                    違反を表示する（pnpm standard:check。pnpm verify に含める）
//   node scripts/standard/check.mjs --release          本番リリース前の検査も行う（SEC-09・OPS-05 など。pnpm standard:release）
//   node scripts/standard/check.mjs --base <commit>    人の確認が必要な変更（フラグ）も検出する。比べる先は作業ツリー（未追跡のファイルを含む）
//   node scripts/standard/check.mjs --base <a> --head <b>   比べる先をコミット b にする
//   node scripts/standard/check.mjs --json             結果を JSON で出力する
//   node scripts/standard/check.mjs --list [--markdown]     ルール一覧
//   node <新しい版>/scripts/standard/check.mjs --standard <新しい版>/docs/standard
//                                                      案件をそのままに、指定した版の標準で検査する（標準の更新の前に）
//
// 依存パッケージなし（Node.js 22 以上）。
// 終了コード: 0 = 違反なし、1 = 違反あり、2 = 実行できない（引数の誤り・標準が見つからない）。
// フラグ（flags）と注意（warnings）は終了コードに影響しない。
// 検査は規約をすり抜けにくくするための機械的な網で、完全ではない。残りは独立レビューと人間ゲートが確かめる。
// 検査できないもの（読めないファイル・シンボリックリンク・取れない差分）は、違反かフラグにして人の確認に倒す。

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const USAGE =
  "使い方: node scripts/standard/check.mjs [--json] [--release] [--base <コミット> [--head <コミット>]] [--list [--markdown]] [--standard <標準のディレクトリ>]\n";

// ---------------------------------------------------------------------------
// 引数と出力
// ---------------------------------------------------------------------------

/** 実行できないときは、短い説明を標準エラーに書いて終了コード 2 で終える */
function fatal(message) {
  try {
    writeSync(2, `✗ ${message}\n`);
  } catch {
    // 標準エラーに書けなくても終了コードで伝わる
  }
  process.exit(2);
}

/** 出力を書き切ってから終える（パイプに大きな出力を書いた直後に process.exit すると途中で切れるため） */
async function finish(text, code) {
  process.exitCode = code;
  process.stdout.on("error", () => {}); // 読み手が先に閉じても（| head など）止まらない
  await new Promise((resolve) => process.stdout.write(text, () => resolve()));
  process.exit(code);
}

async function parseArgs(argv) {
  const o = {
    json: false,
    release: false,
    list: false,
    markdown: false,
    standard: null,
    base: { given: false, value: null },
    head: { given: false, value: null },
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    // 値を取る引数。値がない（次が --xxx か末尾）ときは null
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    const bool = (key) => {
      if (inline !== undefined) fatal(`${name} は値を取りません`);
      o[key] = true;
    };
    switch (name) {
      case "--json":
        bool("json");
        break;
      case "--release":
        bool("release");
        break;
      case "--list":
        bool("list");
        break;
      case "--markdown":
        bool("markdown");
        break;
      case "--base":
        o.base = { given: true, value: value() };
        break;
      case "--head":
        o.head = { given: true, value: value() };
        break;
      case "--standard": {
        const v = value();
        if (!v) fatal("--standard には標準のディレクトリ（rules.json がある場所）を指定してください");
        o.standard = v;
        break;
      }
      case "--help":
      case "-h":
        await finish(USAGE, 0);
        break;
      default:
        fatal(`知らない引数です: ${arg}\n${USAGE}`);
    }
  }
  return o;
}

const opt = await parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 準備（案件のルート・標準・案件の設定）
// ---------------------------------------------------------------------------

/**
 * docs/standard/rules.json がある案件のルートを、カレントディレクトリから上に探す。
 * git のルート（.git のディレクトリかファイルがあるところ）で止め、それより上には上らない。
 */
function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "docs", "standard", "rules.json"))) return { root: dir };
    if (existsSync(path.join(dir, ".git"))) return { root: null, gitRoot: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: null };
    dir = parent;
  }
}

const FOUND = findRoot(process.cwd());
if (!FOUND.root && !opt.standard) fatal("標準（docs/standard/rules.json）が見つかりません。案件のディレクトリで実行してください");
const ROOT = FOUND.root ?? FOUND.gitRoot ?? path.resolve(process.cwd());
const STD = opt.standard ? path.resolve(opt.standard) : path.join(ROOT, "docs", "standard");

/** 改行を LF にそろえ、BOM を除く（行番号は変わらない） */
function normalize(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** ROOT からの相対パス（区切りは /） */
function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function abs(relPath) {
  return path.join(ROOT, ...relPath.split("/"));
}

function readJsonAt(file) {
  if (!existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(normalize(readFileSync(file, "utf8"))) };
  } catch (e) {
    return { error: `${rel(file)} を読めません: ${e.message}` };
  }
}

const RULES_JSON = readJsonAt(path.join(STD, "rules.json"));
if (RULES_JSON.missing) fatal(`標準（${path.join(STD, "rules.json")}）が見つかりません`);
if (RULES_JSON.error || !Array.isArray(RULES_JSON.value?.rules)) {
  fatal(`標準の rules.json を読めません${RULES_JSON.error ? `: ${RULES_JSON.error}` : "（rules がありません）"}`);
}
const RULES = RULES_JSON.value;
const RULE = Object.fromEntries(RULES.rules.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// ルール一覧（--list）。検査は行わない
// ---------------------------------------------------------------------------

function kindLabel(r) {
  const label = RULES.kinds?.[r.check]?.label ?? r.check;
  return r.release ? `${label}（リリース前）` : label;
}

if (opt.list) {
  const lines = [];
  if (opt.markdown) {
    lines.push("| ID | 層 | ルール | 確かめ方 |", "|---|---|---|---|");
    for (const r of RULES.rules) lines.push(`| ${r.id} | ${RULES.layers?.[r.layer] ?? r.layer} | ${r.title} | ${kindLabel(r)} |`);
  } else {
    for (const r of RULES.rules) lines.push(`${r.id.padEnd(8)} [${kindLabel(r)}] ${r.title}`);
  }
  await finish(`${lines.join("\n")}\n`, 0);
}

const DEPS_JSON = readJsonAt(path.join(STD, "dependencies.json"));
const DEPS = DEPS_JSON.value ?? {};
const PROFILE_JSON = readJsonAt(abs("docs/profile.json"));
const PROFILE = PROFILE_JSON.value && typeof PROFILE_JSON.value === "object" ? PROFILE_JSON.value : null;
const EXC_JSON = readJsonAt(abs("docs/exceptions.json"));

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = localDate();

/** 実在する日付（YYYY-MM-DD）か。2026-02-30 のような日付は通さない */
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1970 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

// ---------------------------------------------------------------------------
// 例外（docs/exceptions.json）の検証（ESC-06）。記録が欠けた例外は適用しない
// ---------------------------------------------------------------------------

const EXC_VALID = [];
const EXC_PROBLEMS = [];
const EXC_LIST = Array.isArray(EXC_JSON.value?.exceptions) ? EXC_JSON.value.exceptions : [];
{
  const seen = new Set();
  for (const e of EXC_LIST) {
    const missing = [];
    const obj = e && typeof e === "object" ? e : {};
    if (!nonEmpty(obj.id)) missing.push("id");
    else if (seen.has(obj.id)) missing.push(`id「${obj.id}」が重複`);
    else seen.add(obj.id);
    if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.some((r) => !RULE[r])) {
      missing.push("rules（標準にあるルール ID の配列）");
    } else if (obj.rules.includes("ESC-06")) {
      missing.push("ESC-06 は例外にできない");
    }
    if (!nonEmpty(obj.subject)) missing.push("subject");
    if (!nonEmpty(obj.reason)) missing.push("reason");
    if (!nonEmpty(obj.approvedBy)) missing.push("approvedBy（承認した標準オーナー）");
    if (!validDate(obj.approvedAt)) missing.push("approvedAt（実在する日付 YYYY-MM-DD）");
    else if (obj.approvedAt > TODAY) missing.push("approvedAt が未来の日付");
    if (!validDate(obj.reviewBy)) missing.push("reviewBy（見直し期限。実在する日付 YYYY-MM-DD）");
    else if (validDate(obj.approvedAt) && obj.reviewBy < obj.approvedAt) missing.push("reviewBy が approvedAt より前");
    if (!nonEmpty(obj.adr)) missing.push("adr（ADR のパス）");
    else {
      const adrAbs = path.resolve(ROOT, obj.adr);
      const inside = !path.isAbsolute(obj.adr) && !path.relative(ROOT, adrAbs).startsWith("..");
      let isFile = false;
      try {
        isFile = inside && statSync(adrAbs).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) missing.push(`adr「${obj.adr}」が案件の中に存在しない`);
    }
    if (missing.length) EXC_PROBLEMS.push({ e: obj, missing });
    else EXC_VALID.push(obj);
  }
}

/** 承認済みの例外か（subject の完全一致か "*"。ESC-06 は例外にできない） */
function excepted(ruleId, subject) {
  if (ruleId === "ESC-06") return false;
  return EXC_VALID.some((e) => e.rules.includes(ruleId) && (e.subject === "*" || (subject != null && e.subject === subject)));
}

// ---------------------------------------------------------------------------
// 結果の入れ物
// ---------------------------------------------------------------------------

const violations = [];
const flags = [];
const warnings = [];
const checked = new Set();
const reported = new Set();

/**
 * 違反を記録する。where.subject が例外の対象（省略時は file:<パス>）。
 * 承認済みの例外（その subject か "*"）があれば記録しない。同じ違反は1回だけ記録する。
 */
function violate(ruleId, message, where = {}) {
  const file = where.file ?? null;
  const line = where.line ?? null;
  const subject = where.subject ?? (file ? `file:${file}` : null);
  if (excepted(ruleId, subject)) return;
  const key = `${ruleId}\0${file}\0${line}\0${message}`;
  if (reported.has(key)) return;
  reported.add(key);
  violations.push({ rule: ruleId, title: RULE[ruleId]?.title ?? "", file, line, message });
}

function warn(ruleId, message, file = null) {
  warnings.push({ rule: ruleId, title: RULE[ruleId]?.title ?? "", file, message });
}

function flag(ruleId, role, message, items = []) {
  checked.add(ruleId);
  flags.push({ rule: ruleId, role, title: RULE[ruleId]?.title ?? "", message, items });
}

/** ルールを検査する。検査そのものが失敗したら、そのルールの違反にする（安全側に倒す） */
function check(ruleIds, fn) {
  const ids = Array.isArray(ruleIds) ? ruleIds : [ruleIds];
  for (const id of ids) checked.add(id);
  try {
    fn();
  } catch (e) {
    for (const id of ids) violate(id, `検査中にエラーが起きました（${e?.message ?? e}）。安全のため違反として扱います`);
  }
}

// ---------------------------------------------------------------------------
// ファイルの一覧（シンボリックリンクはたどらない）
// ---------------------------------------------------------------------------

// どこにあっても読まない生成物・作業用のディレクトリ
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".data",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "test-reports",
  "playwright-report",
  ".turbo",
  ".vercel",
  ".pnpm-store",
]);
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name === ".next" || name.startsWith(".next-");
// devkit と標準の部品（案件のコードの規約は当てない。秘密情報の検査はする）
const KIT = /^(?:\.claude\/|\.devkit\/|scripts\/devkit\/|scripts\/standard\/)/;
const SKIP_PATHS = new Set([".claude/worktrees", ".devkit/worktrees", ".devkit/tmp", ".devkit/logs", ".devkit/cache", ".devkit/gates"]);

const INVENTORY = { files: [], symlinks: [], unreadable: [] };
(function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    if (dir !== ROOT) INVENTORY.unreadable.push(rel(dir));
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const r = rel(full);
    if (e.isDirectory()) {
      if (isSkippedDir(e.name) || SKIP_PATHS.has(r)) continue;
      walk(full);
    } else if (e.isSymbolicLink()) INVENTORY.symlinks.push(r);
    else if (e.isFile()) INVENTORY.files.push(r);
  }
})(ROOT);
INVENTORY.files.sort();
INVENTORY.symlinks.sort();

const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|avif|bmp|tiff?|svgz|heic|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|mp4|mp3|wav|ogg|webm|mov|avi|xlsx?|docx?|pptx?|psd|node|so|dylib|dll|exe|bin|dat|sqlite3?|db)$/i;
const LOCK_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;
const isBinaryPath = (p) => BINARY_EXT.test(p);
const CODE_EXT = /\.[cm]?[jt]sx?$/;
const CODE_LIMIT = 5_000_000; // コードとして読む上限（これを超えると検査できないので違反）
const TEXT_LIMIT = 20_000_000; // 秘密情報の検査で読む上限

/** ファイルを読む。{ text } か { problem }（読めない・大きすぎる・NUL を含む） */
function readFileChecked(relPath, limit) {
  try {
    const st = lstatSync(abs(relPath));
    if (st.isSymbolicLink()) return { problem: "シンボリックリンク" };
    if (!st.isFile()) return { problem: "ファイルではない" };
    if (st.size > limit) return { problem: `${(st.size / 1_000_000).toFixed(1)}MB で上限（${limit / 1_000_000}MB）を超える` };
    const buf = readFileSync(abs(relPath));
    if (buf.includes(0)) return { problem: "NUL を含む（テキストとして読めない）" };
    return { text: normalize(buf.toString("utf8")) };
  } catch (e) {
    return { problem: `読めない（${e?.code ?? e?.message ?? e}）` };
  }
}
const readText = (relPath, limit = CODE_LIMIT) => readFileChecked(relPath, limit).text ?? null;

/** テストのファイルか: ファイル名が *.test.* / *.spec.* か、ルート直下の tests/ と e2e/ の中 */
const isTest = (p) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /^(?:tests|e2e)\//.test(p);
/** ルート直下の設定ファイル（next.config.ts など。ビルドとツールの設定として process.env を読んでよい） */
const isRootConfig = (p) => /^[^/]+\.config\.[cm]?[jt]s$/.test(p);

/** 行番号を引けるソース。字句解析（コメントと文字列の区別）は必要になったときに行う */
class Source {
  constructor(relPath, text) {
    this.path = relPath;
    this.text = text;
  }
  get lexed() {
    if (!this._lexed) this._lexed = lex(this.text);
    return this._lexed;
  }
  /** コメントを空白にしたテキスト（文字列は残す） */
  get code() {
    return this.lexed.code;
  }
  /** コメントと文字列・テンプレート・正規表現の中身を空白にしたテキスト（区切り文字は残す） */
  get mask() {
    return this.lexed.mask;
  }
  get imports() {
    if (!this._imports) this._imports = importsOf(this);
    return this._imports;
  }
  line(index) {
    if (!this._starts) {
      this._starts = [0];
      for (let i = 0; i < this.text.length; i++) if (this.text[i] === "\n") this._starts.push(i + 1);
    }
    let lo = 0;
    let hi = this._starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

// 案件のコード（devkit と標準の部品を除く）。読めないものは ARCH-11 の違反にする
const UNCHECKABLE = [];
const CODE_FILES = [];
for (const p of INVENTORY.files) {
  if (!CODE_EXT.test(p) || KIT.test(p)) continue;
  const r = readFileChecked(p, CODE_LIMIT);
  if (r.problem) UNCHECKABLE.push({ file: p, problem: r.problem });
  else CODE_FILES.push(new Source(p, r.text));
}
const CODE = new Map(CODE_FILES.map((s) => [s.path, s]));
const APP_CODE = CODE_FILES.filter((f) => !isTest(f.path));

function loadSource(relPath) {
  if (CODE.has(relPath)) return CODE.get(relPath);
  const text = readText(relPath);
  return text == null ? null : new Source(relPath, text);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const GIT_CONFIG = [
  "-c",
  "core.quotepath=off",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=never",
  "-c",
  "diff.noprefix=false",
  "--literal-pathspecs",
];

function git(args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  delete env.GIT_EXTERNAL_DIFF;
  const r = spawnSync("git", [...GIT_CONFIG, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env });
  return {
    code: r.error ? 1 : (r.status ?? 1),
    out: r.stdout ?? "",
    err: (r.stderr ?? "").trim() || r.error?.message || (r.signal ? `signal ${r.signal}` : ""),
  };
}

let insideGitCache;
function insideGit() {
  if (insideGitCache === undefined) {
    const r = git(["rev-parse", "--is-inside-work-tree"]);
    insideGitCache = r.code === 0 && r.out.trim() === "true";
  }
  return insideGitCache;
}

let projectFilesCache;
/** 案件のファイル（git 管理なら追跡中と未追跡のうち無視されていないもの。git でなければ一覧から .env などを除いたもの） */
function projectFiles() {
  if (projectFilesCache) return projectFilesCache;
  let list = null;
  if (insideGit()) {
    const r = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    if (r.code === 0) list = [...new Set(r.out.split("\0").filter(Boolean))];
  }
  if (!list) list = INVENTORY.files.filter((p) => !/(^|\/)\.env(\.[^/]*)?$/.test(p) || /(^|\/)\.env\.example$/.test(p));
  // git 管理なら、コミットされる生成物（dist/ など）も読む。node_modules と worktree だけは除く
  projectFilesCache = list
    .filter((p) => !/(^|\/)node_modules\//.test(p) && ![...SKIP_PATHS].some((s) => p.startsWith(`${s}/`)))
    .filter((p) => {
      try {
        return lstatSync(abs(p)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  return projectFilesCache;
}

// ---------------------------------------------------------------------------
// 字句解析（簡易）。コメント・文字列・テンプレート・正規表現を見分ける
// ---------------------------------------------------------------------------

const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%~^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/** 位置 i の "/" から始まる正規表現リテラルの終わり（閉じる "/" の位置）。同じ行で閉じなければ -1 */
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j > i + 1 ? j : -1;
  }
  return -1;
}

function lex(src) {
  const n = src.length;
  const code = src.split("");
  const mask = src.split("");
  const blank = (j, both) => {
    if (src[j] !== "\n") {
      mask[j] = " ";
      if (both) code[j] = " ";
    }
  };
  let i = 0;
  let depth = 0;
  const tpl = []; // ${ を開いたときの depth
  let inTpl = false;
  let prev = "";
  let word = "";
  let inWord = false;
  while (i < n) {
    const c = src[i];
    if (inTpl) {
      if (c === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        inTpl = false;
        prev = "`";
        inWord = false;
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        tpl.push(depth);
        depth++;
        inTpl = false;
        prev = "{";
        inWord = false;
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") blank(i++, true);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const stop = e < 0 ? n : e + 2;
      while (i < stop) blank(i++, true);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n && src[i + 1] !== "\n") blank(i++);
        blank(i++);
      }
      if (i < n && src[i] === c) i++;
      prev = c;
      inWord = false;
      continue;
    }
    if (c === "`") {
      inTpl = true;
      i++;
      continue;
    }
    if (c === "}" && tpl.length && depth - 1 === tpl[tpl.length - 1]) {
      tpl.pop();
      depth--;
      inTpl = true;
      i++;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_AFTER.has(prev) || (prev === "w" && REGEX_KEYWORDS.has(word)))) {
      const end = regexEnd(src, i);
      if (end > 0) {
        for (let j = i + 1; j < end; j++) blank(j);
        i = end + 1;
        prev = "/";
        inWord = false;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      word = inWord ? word + c : c;
      inWord = true;
      prev = "w";
    } else {
      inWord = false;
      if (!/\s/.test(c)) prev = c;
    }
    i++;
  }
  return { code: code.join(""), mask: mask.join("") };
}

/** mask[open] の括弧に対応する閉じ括弧の位置（見つからなければ末尾） */
function matching(mask, open) {
  const close = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < mask.length; i++) {
    const c = mask[i];
    if (c === "(" || c === "[" || c === "{") stack.push(close[c]);
    else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return mask.length - 1;
}

const CONTINUES_END = /(?:[=,+\-*/%?:&|^!~<>(.[{]|\b(?:await|return|new|typeof|instanceof|in|of|void|delete|yield|throw|async|extends|as|satisfies))$/;
const CONTINUES_START = /^(?:[.?:+\-*/%&|^,=]|as\b|satisfies\b|instanceof\b|in\b)/;

/** start から始まる文の終わり（; の位置、文を閉じる改行、または外側の閉じ括弧の位置） */
function statementEnd(mask, start, limit = mask.length) {
  let depth = 0;
  for (let i = start; i < limit; i++) {
    const c = mask[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth < 0) return i;
    } else if (depth === 0 && c === ";") return i;
    else if (depth === 0 && c === "\n") {
      const sofar = mask.slice(start, i).trim();
      const rest = mask.slice(i + 1, limit).trimStart();
      if (sofar && !CONTINUES_END.test(sofar) && !CONTINUES_START.test(rest)) return i;
    }
  }
  return limit;
}

/** オブジェクトの項目（start から）の終わり（一番外側の , か閉じ括弧の位置） */
function propertyEnd(mask, start) {
  let depth = 0;
  for (let i = start; i < mask.length; i++) {
    const c = mask[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth < 0) return i;
    } else if (c === "," && depth === 0) return i;
  }
  return mask.length;
}

/** 引数の後ろ（j）から関数本体を探す。{ open, close, block } */
function bodyAfterParams(mask, j) {
  let angle = 0;
  for (; j < mask.length; j++) {
    const c = mask[j];
    if (c === "=" && mask[j + 1] === ">") {
      let k = j + 2;
      while (k < mask.length && /\s/.test(mask[k])) k++;
      if (mask[k] === "{") return { open: k, close: matching(mask, k), block: true };
      let end = k;
      let d = 0;
      for (; end < mask.length; end++) {
        const ch = mask[end];
        if ("([{".includes(ch)) d++;
        else if (")]}".includes(ch)) {
          if (--d < 0) break;
        } else if (d === 0 && (ch === ";" || ch === ",")) break;
      }
      return { open: k - 1, close: end, block: false };
    }
    if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) return { open: j, close: matching(mask, j), block: true };
    else if (c === ";") return null;
  }
  return null;
}

/** mask[parenOpen] が引数の "(" の関数の本体 */
function functionBody(mask, parenOpen) {
  return bodyAfterParams(mask, matching(mask, parenOpen) + 1);
}

/** 関数本体の先頭から count 個の文（{ start, end, text, mask }）。if 文は条件と本体を1つの文として扱う */
function leadingStatements(srcObj, body, count) {
  const { mask, code } = srcObj;
  const out = [];
  let i = body.open + 1;
  const limit = body.block ? body.close : body.close;
  while (out.length < count && i < limit) {
    while (i < limit && (/\s/.test(mask[i]) || mask[i] === ";")) i++;
    if (i >= limit) break;
    const start = i;
    let end;
    const ifm = /^if\s*\(/.exec(mask.slice(start, start + 20));
    if (ifm) {
      const condClose = matching(mask, start + ifm[0].length - 1);
      let k = condClose + 1;
      while (k < limit && /\s/.test(mask[k])) k++;
      end = mask[k] === "{" ? matching(mask, k) + 1 : statementEnd(mask, k, limit);
      out.push({ start, end, text: code.slice(start, end).trim(), mask: mask.slice(start, end), condClose });
    } else {
      end = statementEnd(mask, start, limit);
      out.push({ start, end, text: code.slice(start, end).trim(), mask: mask.slice(start, end) });
    }
    i = end + 1;
  }
  if (!body.block && !out.length) out.push({ start: body.open + 1, end: body.close, text: code.slice(body.open + 1, body.close).trim() });
  return out;
}

/** オブジェクトリテラル（mask[open] が "{"）の一番外側の項目 */
function topLevelEntries(srcObj, open) {
  const { mask, code } = srcObj;
  const close = matching(mask, open);
  const entries = [];
  let depth = 0;
  let start = open + 1;
  const push = (endIdx) => {
    const raw = mask.slice(start, endIdx);
    const lead = raw.length - raw.trimStart().length;
    const s = start + lead;
    const text = code.slice(s, endIdx).trim();
    const m = mask.slice(s, endIdx).trim();
    if (m) entries.push({ start: s, end: endIdx, text, mask: m });
  };
  for (let i = open + 1; i < close; i++) {
    const c = mask[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return entries.map((e) => {
    if (e.mask.startsWith("...")) return { ...e, kind: "spread" };
    if (e.mask.startsWith("[")) return { ...e, kind: "computed" };
    let m = /^(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(e.mask);
    if (m && !/^[A-Za-z_$][\w$]*\s*:/.test(e.mask)) return { ...e, kind: "method", key: m[1], value: e.text };
    m = /^(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*:/.exec(e.text);
    if (m) return { ...e, kind: "prop", key: m[2], value: e.text.slice(m[0].length).trim() };
    m = /^([A-Za-z_$][\w$]*)\s*:/.exec(e.mask);
    if (m) return { ...e, kind: "prop", key: m[1], value: e.text.slice(e.text.indexOf(":") + 1).trim() };
    m = /^([A-Za-z_$][\w$]*)$/.exec(e.mask);
    if (m) return { ...e, kind: "shorthand", key: m[1], value: m[1] };
    return { ...e, kind: "other" };
  });
}

/** import / export from / 動的 import / require の指定子 */
function importsOf(srcObj) {
  const code = srcObj.code;
  const out = [];
  const re =
    /\bimport\s*(["'])([^"'\n]+)\1|\bimport\s+(type\s+)?([\w$*{},\s]+?)\s*\bfrom\s*(["'])([^"'\n]+)\5|\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\9|\bimport\s*\(\s*(["'`])([^"'`\n]+)\11\s*\)|\brequire\s*\(\s*(["'`])([^"'`\n]+)\13\s*\)/g;
  for (const m of code.matchAll(re)) {
    // 文字列やコメントの中の "import" は除く（mask で空白になっている）
    if (srcObj.mask.slice(m.index, m.index + 6) !== code.slice(m.index, m.index + 6)) continue;
    const end = m.index + m[0].length;
    if (m[2] !== undefined) out.push({ spec: m[2], index: m.index, end, kind: "side", typeOnly: false, clause: "" });
    else if (m[6] !== undefined) {
      const clause = m[4].trim();
      const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
      const parts = named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
      const hasDefaultOrNs = rest !== "";
      const allTypes = !hasDefaultOrNs && parts.length > 0 && parts.every((p) => /^type\s/.test(p));
      const ns = /\*\s*as\s+([\w$]+)/.exec(rest)?.[1] ?? null;
      const def = /^([\w$]+)/.exec(rest)?.[1] ?? null;
      out.push({ spec: m[6], index: m.index, end, kind: "import", typeOnly: Boolean(m[3]) || allTypes, clause, named: parts, namespace: ns, default: def === "type" ? null : def });
    } else if (m[10] !== undefined) {
      const named = /\{([^}]*)\}/.exec(m[8])?.[1] ?? "";
      out.push({ spec: m[10], index: m.index, end, kind: "export", typeOnly: Boolean(m[7]), clause: m[8], named: named.split(",").map((s) => s.trim()).filter(Boolean) });
    } else if (m[12] !== undefined) out.push({ spec: m[12], index: m.index, end, kind: "dynamic", typeOnly: false, clause: "" });
    else if (m[14] !== undefined) out.push({ spec: m[14], index: m.index, end, kind: "require", typeOnly: false, clause: "" });
  }
  return out;
}

/** import の名前の対応（ローカル名 → 元の名前） */
function importedNames(imp) {
  const map = new Map();
  for (const p of imp.named ?? []) {
    const s = p.replace(/^type\s+/, "");
    const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
    if (m) map.set(m[2] ?? m[1], m[1]);
  }
  return map;
}

/** 指定子を案件のルートからのパス（拡張子・/index なし）にする。@/ と相対パスに対応 */
function resolveSpec(fromFile, spec) {
  let p = spec;
  if (spec.startsWith("@/")) p = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return p.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}

/** 指定子が指すファイル（案件の中で見つかれば） */
function resolveFile(fromFile, spec) {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null;
  const base = resolveSpec(fromFile, spec);
  for (const ext of ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]) {
    const candidate = base + ext;
    if (CODE.has(candidate)) return candidate;
    if (ext && existsSync(abs(candidate))) return candidate;
  }
  return null;
}

/** ファイル先頭のディレクティブ（"use server" / "use client"）と、その位置 */
function directive(srcObj) {
  const m = /^\s*(["'])use (server|client)\1/.exec(srcObj.code);
  return m ? { kind: m[2], index: m.index + m[0].indexOf(m[1]) } : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "@radix-ui/react-*" のような許可リストのパターン（* は / を含まない1文字以上） */
function matchesName(pattern, name) {
  if (!pattern.includes("*")) return pattern === name;
  return new RegExp(`^${pattern.split("*").map(escapeRe).join("[^/]+")}$`).test(name);
}

/** 名前が src/server/ の値の import か（ローカル名 → 元のモジュール） */
function serverValueImports(f) {
  const map = new Map();
  for (const imp of f.imports) {
    if (imp.kind !== "import" || imp.typeOnly) continue;
    const target = resolveSpec(f.path, imp.spec);
    if (!target.startsWith("src/server/")) continue;
    for (const [local] of importedNames(imp)) map.set(local, target);
    if (imp.default) map.set(imp.default, target);
    if (imp.namespace) map.set(imp.namespace, target);
  }
  return map;
}

/** 位置 index の式を引数に持つ呼び出しの関数名（`f(…)` の f。メンバー呼び出しや呼び出しでなければ null） */
function enclosingCallee(mask, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = mask[i];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (c !== "(") return null;
      const before = mask.slice(Math.max(0, i - 200), i);
      const m = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*$/.exec(before);
      if (!m) return null;
      const pre = before.slice(0, before.length - m[0].length).trimEnd();
      if (pre.endsWith(".")) return null;
      if (/^(?:if|while|for|switch|return|await|typeof|catch|function|async)$/.test(m[1])) return null;
      return m[1];
    }
  }
  return null;
}

/** 案件の中の import をたどって、start から読み込まれるファイル（start を除く） */
function importClosure(start, max = 50) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length && seen.size < max) {
    const f = loadSource(queue.shift());
    if (!f) continue;
    for (const imp of f.imports) {
      if (imp.typeOnly) continue;
      const target = resolveFile(f.path, imp.spec);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  seen.delete(start);
  return seen;
}

// ---------------------------------------------------------------------------
// 簡易 YAML（pnpm-workspace.yaml の overrides・catalog など、入れ子のマップと配列だけ）
// ---------------------------------------------------------------------------

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root, key: null, parent: null }];
  const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    const t = line.trim();
    if (t.startsWith("- ")) {
      if (!Array.isArray(top.node)) {
        const arr = [];
        if (top.parent) top.parent[top.key] = arr;
        top.node = arr;
      }
      top.node.push(unquote(t.slice(2)));
      continue;
    }
    const m = /^((?:"[^"]*"|'[^']*'|[^:])+):(?:\s+(.*))?$/.exec(t);
    if (!m) continue;
    const key = unquote(m[1]);
    if (Array.isArray(top.node)) continue;
    if (m[2] !== undefined && m[2].trim() !== "") top.node[key] = unquote(m[2]);
    else {
      const child = {};
      top.node[key] = child;
      stack.push({ indent, node: child, key, parent: top.node });
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// 差分（--base）。違反の一部（OPS-04）とフラグに使う
// ---------------------------------------------------------------------------

const diffProblems = [];

function gitOk(r, what) {
  if (r.code !== 0) diffProblems.push(`${what}: ${r.err || `exit ${r.code}`}`);
  return r.code === 0;
}

function makeDiff() {
  if (!opt.base.given && !opt.head.given) return null;
  const d = { ok: false, base: null, head: null, changed: new Map(), cache: new Map() };
  const valueProblem = (name, v) => {
    if (v === null) return `${name} にコミットが指定されていません`;
    if (!v.trim()) return `${name} が空です`;
    if (v.startsWith("-")) return `${name} の値「${v}」はコミットではありません`;
    return null;
  };
  if (!opt.base.given) {
    diffProblems.push("--head は --base と一緒に指定してください");
    return d;
  }
  const bp = valueProblem("--base", opt.base.value);
  if (bp) diffProblems.push(bp);
  const hp = opt.head.given ? valueProblem("--head", opt.head.value) : null;
  if (hp) diffProblems.push(hp);
  if (bp || hp) return d;
  if (!insideGit()) {
    diffProblems.push("git のリポジトリの中ではありません");
    return d;
  }
  const resolve = (v, name) => {
    const r = git(["rev-parse", "--verify", "--quiet", `${v}^{commit}`]);
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(r.out.trim())) {
      diffProblems.push(`${name} のコミット「${v}」が見つかりません`);
      return null;
    }
    return r.out.trim();
  };
  d.base = resolve(opt.base.value, "--base");
  if (opt.head.given) d.head = resolve(opt.head.value, "--head");
  if (!d.base || (opt.head.given && !d.head)) return d;

  const range = d.head ? [d.base, d.head] : [d.base];
  const ns = git(["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", ...range, "--"]);
  if (!gitOk(ns, "git diff --name-status")) return d;
  const parts = ns.out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    d.changed.set(parts[i + 1], parts[i][0]);
  }
  if (!d.head) {
    const un = git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!gitOk(un, "git ls-files --others")) return d;
    for (const f of un.out.split("\0").filter(Boolean)) if (!d.changed.has(f)) d.changed.set(f, "?");
  }
  d.ok = true;
  return d;
}

let DIFF = null;
try {
  DIFF = makeDiff();
} catch (e) {
  diffProblems.push(`差分の取得中にエラー: ${e?.message ?? e}`);
  DIFF = { ok: false, changed: new Map(), cache: new Map() };
}

/** base の時点のファイルの内容（なければ null） */
function baseText(f) {
  if (!DIFF?.base) return null;
  const r = git(["cat-file", "blob", `${DIFF.base}:./${f}`]);
  if (r.code !== 0 || r.out.includes("\0")) return null;
  return normalize(r.out);
}

/** 比べる先（作業ツリーか --head）のファイルの内容 */
function newText(f) {
  if (!DIFF.head) return readText(f, TEXT_LIMIT);
  const r = git(["cat-file", "blob", `${DIFF.head}:./${f}`]);
  if (!gitOk(r, `git cat-file ${f}`)) return null;
  return r.out.includes("\0") ? null : normalize(r.out);
}

/** base から追加された行 [{ line, text }]（未追跡のファイルは全行） */
function addedLines(f) {
  if (DIFF.cache.has(f)) return DIFF.cache.get(f);
  let out = [];
  const status = DIFF.changed.get(f);
  if (status && status !== "D" && !isBinaryPath(f)) {
    if (status === "?") {
      const t = readText(f, TEXT_LIMIT);
      if (t != null) out = t.split("\n").map((text, i) => ({ line: i + 1, text }));
    } else {
      const range = DIFF.head ? [DIFF.base, DIFF.head] : [DIFF.base];
      // --text: .gitattributes の -diff / binary でも行を出す。--no-textconv / --no-ext-diff: 変換で中身を隠させない
      const r = git(["diff", "--text", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--src-prefix=a/", "--dst-prefix=b/", ...range, "--", f]);
      if (gitOk(r, `git diff ${f}`)) {
        let lineNo = 0;
        let inHunk = false;
        for (const raw of r.out.split("\n")) {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
          if (hunk) {
            lineNo = Number(hunk[1]);
            inHunk = true;
            continue;
          }
          if (!inHunk) continue;
          if (raw.startsWith("+")) out.push({ line: lineNo++, text: raw.slice(1).replace(/\r$/, "") });
        }
      }
    }
  }
  DIFF.cache.set(f, out);
  return out;
}

// ---------------------------------------------------------------------------
// 1. 技術標準
// ---------------------------------------------------------------------------

const PKG_JSON = readJsonAt(abs("package.json"));
const pkg = PKG_JSON.value && typeof PKG_JSON.value === "object" ? PKG_JSON.value : {};
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// ワークスペース（pnpm-workspace.yaml）とサブパッケージの package.json
const WORKSPACE_TEXT = existsSync(abs("pnpm-workspace.yaml")) ? readText("pnpm-workspace.yaml") : null;
const WORKSPACE = WORKSPACE_TEXT ? parseSimpleYaml(WORKSPACE_TEXT) : {};
const MANIFESTS = INVENTORY.files.filter((p) => /(^|\/)package\.json$/.test(p) && !KIT.test(p));

function manifest(relPath) {
  if (relPath === "package.json") return PKG_JSON;
  return readJsonAt(abs(relPath));
}

function depEntries(m) {
  const out = [];
  for (const field of DEP_FIELDS) {
    const deps = m[field];
    if (deps == null) continue;
    if (typeof deps !== "object" || Array.isArray(deps)) {
      out.push({ field, name: null, spec: deps });
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) out.push({ field, name, spec });
  }
  return out;
}

const allowedNames = () => [...Object.keys(DEPS.core ?? {}), ...Object.keys(DEPS.preApproved ?? {})];
const isAllowedDep = (name) => allowedNames().some((p) => matchesName(p, name));

// ESC-01（標準外の技術が必要なら止まる）は、依存の許可リスト（TECH-01）で機械的に検出する
checked.add("ESC-01");
check("TECH-01", () => {
  if (PKG_JSON.missing) return violate("TECH-01", "package.json がありません");
  if (PKG_JSON.error) return violate("TECH-01", PKG_JSON.error, { file: "package.json" });
  if (DEPS_JSON.missing || DEPS_JSON.error) {
    return violate("TECH-01", `許可リスト（dependencies.json）を読めません${DEPS_JSON.error ? `: ${DEPS_JSON.error}` : ""}`);
  }
  const notAllowed = (name, where, file) =>
    violate("TECH-01", `許可リストにない依存「${name}」（${where}）。標準外の依存が必要なら、実装せずに技術の判断依頼を出して止まる（ESC-01）`, {
      file,
      subject: `dependency:${name}`,
    });
  for (const file of MANIFESTS) {
    const m = manifest(file);
    if (m.error) {
      violate("TECH-01", m.error, { file });
      continue;
    }
    for (const { field, name } of depEntries(m.value ?? {})) {
      if (name == null) violate("TECH-01", `${field} はオブジェクトにする`, { file });
      else if (!isAllowedDep(name)) notAllowed(name, field, file);
    }
  }
  // pnpm.packageExtensions は依存の package.json に依存を足す
  for (const [target, ext] of Object.entries(pkg.pnpm?.packageExtensions ?? {})) {
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(ext?.[field] ?? {})) if (!isAllowedDep(name)) notAllowed(name, `pnpm.packageExtensions の ${target}`, "package.json");
    }
  }
  for (const [name] of Object.entries(WORKSPACE.catalog ?? {})) if (!isAllowedDep(name)) notAllowed(name, "pnpm-workspace.yaml の catalog", "pnpm-workspace.yaml");
  for (const [cat, entries] of Object.entries(WORKSPACE.catalogs ?? {})) {
    for (const name of Object.keys(entries ?? {})) if (!isAllowedDep(name)) notAllowed(name, `pnpm-workspace.yaml の catalogs.${cat}`, "pnpm-workspace.yaml");
  }
  // インストール時のスクリプトを許可するパッケージ（onlyBuiltDependencies）も許可リストで決める
  const built = new Set(Object.keys(DEPS.builtDependencies ?? {}));
  const builtLists = [
    ["package.json", pkg.pnpm?.onlyBuiltDependencies],
    ["pnpm-workspace.yaml", WORKSPACE.onlyBuiltDependencies],
  ];
  for (const [file, list] of builtLists) {
    for (const name of Array.isArray(list) ? list : []) {
      if (!built.has(name) && !isAllowedDep(name)) {
        violate("TECH-01", `インストール時のスクリプトを許可するパッケージ「${name}」（onlyBuiltDependencies）が許可リストにありません`, { file, subject: `dependency:${name}` });
      }
    }
  }
});

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** バージョン指定の問題（完全固定なら null） */
function versionProblem(spec) {
  if (typeof spec !== "string") return "文字列で書く";
  const s = spec.trim();
  if (EXACT_VERSION.test(s)) return null;
  if (/^npm:/i.test(s)) return "別名（npm:）の指定は使わない";
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)|\.git(?:#|$)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(s)) return "git の指定は使わない";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "URL の指定は使わない";
  if (/^(?:file|link|portal):|^[./~]/i.test(s)) return "ファイルの指定は使わない";
  if (/^(?:workspace|catalog|patch|jsr):/i.test(s)) return `${s.split(":")[0]}: の指定は使わない`;
  return '完全固定ではない（例: "1.2.3"。^ ~ * latest や範囲は使わない）';
}

/** catalog: の指定を pnpm-workspace.yaml の catalog で解決する（解決できなければ null） */
function catalogVersion(name, spec) {
  const m = /^catalog:(.*)$/.exec(String(spec).trim());
  if (!m) return undefined;
  const cat = m[1].trim();
  const table = !cat || cat === "default" ? (WORKSPACE.catalog ?? WORKSPACE.catalogs?.default) : WORKSPACE.catalogs?.[cat];
  return table && typeof table[name] === "string" ? table[name] : null;
}

function* overrideEntries(obj, prefix = "") {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) yield* overrideEntries(v, `${prefix}${k} > `);
    else yield [`${prefix}${k}`, v];
  }
}

check("TECH-02", () => {
  if (PKG_JSON.missing || PKG_JSON.error) return violate("TECH-02", "package.json を読めません");
  for (const file of MANIFESTS) {
    const m = manifest(file);
    if (m.error) continue;
    for (const { field, name, spec } of depEntries(m.value ?? {})) {
      if (name == null) continue;
      const fromCatalog = catalogVersion(name, spec);
      if (fromCatalog === null) {
        violate("TECH-02", `「${name}」（${field}）の「${spec}」が pnpm-workspace.yaml の catalog にありません`, { file, subject: `dependency:${name}` });
        continue;
      }
      const problem = versionProblem(fromCatalog ?? spec);
      if (problem) {
        violate("TECH-02", `「${name}」（${field}）のバージョン「${fromCatalog ?? spec}」: ${problem}`, { file, subject: `dependency:${name}` });
      }
    }
  }
  const direct = new Map(depEntries(pkg).map((e) => [e.name, e.spec]));
  const overrideFields = [
    ["package.json", "pnpm.overrides", pkg.pnpm?.overrides],
    ["package.json", "overrides", pkg.overrides],
    ["package.json", "resolutions", pkg.resolutions],
    ["pnpm-workspace.yaml", "overrides", WORKSPACE.overrides],
    ["pnpm-workspace.yaml", "catalog", WORKSPACE.catalog],
    ...Object.entries(WORKSPACE.catalogs ?? {}).map(([k, v]) => ["pnpm-workspace.yaml", `catalogs.${k}`, v]),
  ];
  for (const [file, field, obj] of overrideFields) {
    if (obj == null) continue;
    if (typeof obj !== "object" || Array.isArray(obj)) {
      violate("TECH-02", `${field} はオブジェクトにする`, { file });
      continue;
    }
    for (const [key, spec] of overrideEntries(obj)) {
      if (field.endsWith("overrides") && spec === "-") continue; // 依存を取り除く指定
      if (typeof spec === "string" && spec.startsWith("$")) {
        // npm の "$名前"（直接の依存と同じ版）。参照先が完全固定なら可
        const target = direct.get(spec.slice(1));
        if (target && !versionProblem(target)) continue;
      }
      const problem = versionProblem(spec);
      if (problem) {
        const name = key.split(" > ").pop().split(">").pop().replace(/@[^@/]*$/, "") || key;
        violate("TECH-02", `${field} の「${key}」のバージョン「${spec}」: ${problem}`, { file, subject: `dependency:${name}` });
      }
    }
  }
  for (const [target, ext] of Object.entries(pkg.pnpm?.packageExtensions ?? {})) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(ext?.[field] ?? {})) {
        const problem = versionProblem(spec);
        if (problem) violate("TECH-02", `pnpm.packageExtensions の ${target} が足す「${name}」のバージョン「${spec}」: ${problem}`, { file: "package.json", subject: `dependency:${name}` });
      }
    }
  }
  // 依存へのパッチは、依存の中身を変える（例外承認が必要）
  const patched = [
    ["package.json", pkg.pnpm?.patchedDependencies],
    ["pnpm-workspace.yaml", WORKSPACE.patchedDependencies],
  ];
  for (const [file, obj] of patched) {
    for (const key of Object.keys(obj && typeof obj === "object" ? obj : {})) {
      const name = key.replace(/@[^@/]*$/, "") || key;
      violate("TECH-02", `依存「${key}」にパッチを当てています（patchedDependencies）。依存の中身を変えるには例外承認が必要`, { file, subject: `dependency:${name}` });
    }
  }
  for (const hook of [".pnpmfile.cjs", ".pnpmfile.mjs"]) {
    if (existsSync(abs(hook))) violate("TECH-02", `${hook} があります。インストール時に依存を書き換えるフックは使わない`, { file: hook });
  }
  if (!/^pnpm@\d+\.\d+\.\d+(?:\+[\w.:-]+)?$/.test(String(pkg.packageManager ?? ""))) {
    violate("TECH-02", `packageManager に pnpm の版を完全固定で書く（例: "pnpm@10.28.0"。現在: ${pkg.packageManager ?? "なし"}）`, { file: "package.json" });
  }
  if (!existsSync(abs("pnpm-lock.yaml"))) violate("TECH-02", "pnpm-lock.yaml がありません。pnpm install で作ってコミットする");
  for (const other of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if (existsSync(abs(other))) violate("TECH-02", `${other} があります。パッケージマネージャーは pnpm だけにする`, { file: other });
  }
});

/** Dockerfile の FROM のイメージ（ARG の既定値を解決する）。[{ image, line, unresolved }] */
function dockerFroms(text) {
  const args = new Map();
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s*#.*$/, "");
    const arg = /^\s*ARG\s+([A-Za-z_][\w]*)(?:\s*=\s*["']?([^"'\s]*)["']?)?/i.exec(line);
    if (arg) {
      if (arg[2] !== undefined) args.set(arg[1], arg[2]);
      return;
    }
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (!from) return;
    let unresolved = false;
    const image = from[1].replace(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)/g, (_, a, def, b) => {
      const name = a ?? b;
      if (args.has(name)) return args.get(name);
      if (def !== undefined) return def;
      unresolved = true;
      return "";
    });
    out.push({ image, line: i + 1, unresolved, raw: from[1] });
  });
  return out;
}

check("TECH-03", () => {
  const want = String(DEPS.node ?? "").trim();
  const file = existsSync(abs(".nvmrc")) ? ".nvmrc" : existsSync(abs(".node-version")) ? ".node-version" : null;
  if (!file) return violate("TECH-03", ".nvmrc がありません（Node.js のメジャー版を書く）");
  const raw = (readText(file) ?? "").trim();
  const have = /^v?(\d+)(?:\.\d+){0,2}$/.exec(raw)?.[1];
  if (!have) violate("TECH-03", `${file} は版を数字で書く（現在: ${raw || "空"}）`, { file });
  else if (want && have !== want) violate("TECH-03", `${file} が ${have} です（標準は ${want}）`, { file });
  // 本番イメージの Node.js も同じメジャー版にする
  for (const f of readdirSync(ROOT).filter((n) => /^Dockerfile(?:\..+)?$/.test(n))) {
    for (const from of dockerFroms(readText(f) ?? "")) {
      const m = /^(?:[\w.:-]+\/)*node:(\S+)$/.exec(from.image);
      if (from.unresolved && /node/.test(from.raw)) {
        violate("TECH-03", `FROM ${from.raw} の版を解決できません（ARG に既定値を書く）`, { file: f, line: from.line });
        continue;
      }
      if (!m) continue;
      const major = /^(\d+)(?=$|[.\-])/.exec(m[1])?.[1];
      if (!major) violate("TECH-03", `node イメージのタグ「${m[1]}」にメジャー版を数字で書く（例: node:${want || "24"}-alpine）`, { file: f, line: from.line });
      else if (want && major !== want) violate("TECH-03", `node イメージが ${major} です（標準は ${want}）`, { file: f, line: from.line });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. 設計標準
// ---------------------------------------------------------------------------

const DB_PACKAGES = /^(?:drizzle-orm(?:\/|$)|pg$|pg\/|postgres$|@electric-sql\/pglite(?:\/|$))/;
const isDbPath = (p) => p === "src/db" || p.startsWith("src/db/");
const isDbAllowed = (p) => p.startsWith("src/server/") || p.startsWith("src/db/") || isTest(p);
const DB_OPS = "select|selectDistinct|selectDistinctOn|insert|update|delete|query|execute|transaction|batch|\\$count|\\$with|with|refreshMaterializedView|\\$client";

check("ARCH-02", () => {
  for (const f of CODE_FILES) {
    if (isDbAllowed(f.path)) continue;
    let touchesDb = false;
    const importRanges = [];
    for (const imp of f.imports) {
      importRanges.push([imp.index, imp.end]);
      const target = resolveSpec(f.path, imp.spec);
      const line = f.line(imp.index);
      if (DB_PACKAGES.test(imp.spec)) {
        touchesDb = true;
        violate("ARCH-02", `「${imp.spec}」を import しています。DB の操作は src/server/ の関数に書き、画面からはその関数を呼ぶ`, { file: f.path, line });
        continue;
      }
      if (!isDbPath(target)) continue;
      touchesDb = true;
      // 許すのは import { getDb } from "@/db/client"（結果は src/server の関数に直接渡す）と、
      // スキーマの行の型だけの import type（import type { Todo } from "@/db/schema"）
      const onlyGetDb =
        target === "src/db/client" && imp.kind === "import" && !imp.typeOnly && !imp.default && !imp.namespace && imp.named.length === 1 && imp.named[0] === "getDb";
      const schemaTypes = /^src\/db\/schema/.test(target) && imp.kind === "import" && imp.typeOnly;
      if (!onlyGetDb && !schemaTypes) {
        violate("ARCH-02", `「${imp.spec}」から ${imp.clause || "（モジュール全体）"} を読み込んでいます。src/server と src/db の外で使えるのは import { getDb } from "@/db/client" と、@/db/schema の import type だけ`, {
          file: f.path,
          line,
        });
      }
    }
    // getDb() の結果は、src/server の関数の引数に直接渡すだけにする（f(await getDb())）
    const server = serverValueImports(f);
    for (const m of f.mask.matchAll(/\bgetDb\b/g)) {
      if (importRanges.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const before = f.mask.slice(0, m.index);
      const awaitM = /\bawait\s+$/.exec(before);
      const after = f.mask.slice(m.index + m[0].length);
      const callM = /^\s*\(\s*\)\s*([,)])/.exec(after);
      const lead = awaitM ? before.slice(0, awaitM.index).trimEnd() : "";
      const callee = awaitM && callM && /[(,]$/.test(lead) ? enclosingCallee(f.mask, awaitM.index) : null;
      if (!callee || !server.has(callee)) {
        violate("ARCH-02", "getDb() の結果は、src/server の関数の引数に直接渡すだけにする（例: listTodos(await getDb())。変数に入れない・ここで DB を操作しない）", {
          file: f.path,
          line: f.line(m.index),
        });
      }
    }
    if (!touchesDb && !/\bgetDb\b/.test(f.mask)) continue;
    // DB を読み込んでいるファイルの直接の DB 操作（IndexedDB などの db は対象外）
    const names = new Set(["db", "tx", "database", "conn", "client"]);
    for (const m of f.mask.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\(?\s*(?:await\s+)?getDb\s*\(/g)) names.add(m[1]);
    for (const m of f.mask.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:Db|PgDatabase|NodePgDatabase|PgliteDatabase)\b/g)) names.add(m[1]);
    const call = new RegExp(`(?:\\b(?:${[...names].map(escapeRe).join("|")})|getDb\\s*\\(\\s*\\)\\s*\\))\\s*\\??\\.\\s*(${DB_OPS})\\b`, "g");
    for (const m of f.mask.matchAll(call)) {
      violate("ARCH-02", `DB を直接操作しています（.${m[1]}）。src/server/ の関数（Db を引数で受け取る）を呼ぶ`, { file: f.path, line: f.line(m.index) });
    }
  }
});

const ACTION_FILE = "src/server/action.ts";
const isActionModule = (fromFile, spec) => resolveSpec(fromFile, spec) === "src/server/action";

/** export const a = …, b = … の宣言子 [{ name, init(mask), index }]。分割代入は { destructure: true } */
function exportDeclarators(f) {
  const out = [];
  const mask = f.mask;
  for (const m of mask.matchAll(/\bexport\s+(const|let|var)\s+/g)) {
    const start = m.index + m[0].length;
    const end = statementEnd(mask, start);
    const decl = mask.slice(start, end);
    if (/^[{[]/.test(decl)) {
      out.push({ index: m.index, destructure: true, kind: m[1], init: decl });
      continue;
    }
    // 一番外側のカンマで分ける（次の宣言子の始まり「名前 =」「名前:」が続くところだけ）
    let depth = 0;
    let s = 0;
    const pieces = [];
    for (let i = 0; i < decl.length; i++) {
      const c = decl[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 0 && /^\s*[A-Za-z_$][\w$]*\s*[:=]/.test(decl.slice(i + 1))) {
        pieces.push([s, i]);
        s = i + 1;
      }
    }
    pieces.push([s, decl.length]);
    for (const [a, b] of pieces) {
      const piece = decl.slice(a, b);
      const dm = /^\s*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(=\s*)?/.exec(piece);
      if (!dm) continue;
      out.push({ index: start + a + (piece.length - piece.trimStart().length), name: dm[1], kind: m[1], init: dm[2] ? piece.slice(dm[0].length) : null });
    }
  }
  return out;
}

check("ARCH-03", () => {
  const actionSrc = CODE.get(ACTION_FILE);
  if (!actionSrc) violate("ARCH-03", `${ACTION_FILE}（defineAction）がありません`);
  else if (!/\bexport\s+(?:async\s+)?(?:function\s+defineAction\b|(?:const|let|var)\s+defineAction\b)/.test(actionSrc.mask)) {
    violate("ARCH-03", `${ACTION_FILE} が defineAction を export していません`, { file: ACTION_FILE });
  }
  for (const f of CODE_FILES) {
    const dir = directive(f);
    const isServerFile = dir?.kind === "server";
    // 関数の中の "use server"（インラインの Server Action）は defineAction を通らないので使わない
    for (const m of f.code.matchAll(/(["'])use server\1/g)) {
      if (isServerFile && m.index === dir.index) continue;
      if (f.mask[m.index] !== m[1]) continue; // 文字列の中身
      if (f.mask.slice(m.index + 1, m.index + 11).trim() !== "") continue;
      violate("ARCH-03", `関数の中の "use server"（インラインの Server Action）は使わない。"use server" ファイルに defineAction で作る`, {
        file: f.path,
        line: f.line(m.index),
      });
    }
    if (!isServerFile) continue;
    const mask = f.mask;
    const bad = [
      ...mask.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]*)/g),
      ...mask.matchAll(/\bexport\s+default\b/g),
      ...[...mask.matchAll(/\bexport\s*(type\s*)?\{[^}]*\}/g)].filter((m) => !m[1]),
      ...mask.matchAll(/\bexport\s*\*/g),
      ...mask.matchAll(/\bexport\s+(?:abstract\s+)?class\s+([\w$]+)/g),
      ...mask.matchAll(/\bexport\s+(?:declare\s+)?enum\s+([\w$]+)/g),
      ...mask.matchAll(/\bexport\s*=/g),
    ];
    for (const d of exportDeclarators(f)) {
      const ok = d.kind === "const" && !d.destructure && d.init != null && /^defineAction\s*(?:<[^>]*>)?\s*\(\s*\{/.test(d.init.trim());
      if (!ok) bad.push({ index: d.index, 1: d.name, 0: d.destructure ? "分割代入" : "" });
    }
    for (const m of bad) {
      const what = m[1] ? `「${m[1]}」` : `（${String(m[0]).replace(/\s+/g, " ").slice(0, 40)}）`;
      violate("ARCH-03", `"use server" ファイルの export${what}は export const 名前 = defineAction({ ... }) の形で作る`, {
        file: f.path,
        line: f.line(m.index),
      });
    }
    if (/\bdefineAction\b/.test(mask)) {
      const ok = f.imports.some((imp) => imp.kind === "import" && isActionModule(f.path, imp.spec) && importedNames(imp).get("defineAction") === "defineAction");
      if (!ok) violate("ARCH-03", "defineAction は @/server/action から import する（別の defineAction を使わない）", { file: f.path, line: 1 });
    }
  }
});

const isComponentPath = (p) => /^(?:src\/)?components\//.test(p) || /^(?:src\/)?app\/(?:.*\/)?components\//.test(p);
const isErrorBoundary = (p) => /^(?:src\/)?app\/(?:.*\/)?(?:global-)?error\.[cm]?[jt]sx?$/.test(p);
const SERVER_ONLY_FROM_CLIENT = (target) =>
  target === "src/server" || target.startsWith("src/server/") || isDbPath(target) || target === "src/lib/env" || target === "src/lib/logger";

check("ARCH-04", () => {
  for (const f of CODE_FILES) {
    if (directive(f)?.kind !== "client") continue;
    if (!isComponentPath(f.path) && !isErrorBoundary(f.path)) {
      violate("ARCH-04", `"use client" は components/ 配下（src/components/ か src/app/**/components/）と error.tsx・global-error.tsx だけに書く`, {
        file: f.path,
        line: 1,
      });
    }
    for (const imp of f.imports) {
      if (imp.typeOnly) continue;
      const target = resolveSpec(f.path, imp.spec);
      if (SERVER_ONLY_FROM_CLIENT(target) || DB_PACKAGES.test(imp.spec)) {
        violate("ARCH-04", `クライアントコンポーネントから「${imp.spec}」を import しています（サーバーの処理や設定がブラウザに含まれる）。型だけなら import type にする`, {
          file: f.path,
          line: f.line(imp.index),
        });
      }
    }
  }
});

check("ARCH-05", () => {
  if (!CODE.has("src/lib/env.ts")) violate("ARCH-05", "src/lib/env.ts（環境変数の唯一の読み口）がありません");
  for (const f of CODE_FILES) {
    if (f.path === "src/lib/env.ts" || isTest(f.path) || isRootConfig(f.path)) continue;
    const clientSide = directive(f)?.kind === "client" || isComponentPath(f.path);
    const procNames = ["process"];
    for (const imp of f.imports) {
      if (!/^(?:node:)?process$/.test(imp.spec)) continue;
      if (imp.namespace) procNames.push(imp.namespace);
      if (imp.default) procNames.push(imp.default);
      if (imp.kind === "import" && importedNames(imp).has("env")) violate("ARCH-05", "process の env を import しています。src/lib/env.ts の loadEnv() を使う", { file: f.path, line: f.line(imp.index) });
    }
    const names = procNames.map(escapeRe).join("|");
    const hits = [
      ...f.mask.matchAll(new RegExp(`(?:^|[^\\w$.])(?:${names})\\s*\\??\\.\\s*env\\b`, "g")),
      ...[...f.mask.matchAll(new RegExp(`\\b(?:${names})\\s*\\[\\s*(["'\`])`, "g"))].filter((m) => /\[\s*["'`]env["'`]/.test(f.code.slice(m.index))),
      ...f.mask.matchAll(new RegExp(`\\{[^{}]*\\benv\\b[^{}]*\\}\\s*=\\s*(?:globalThis\\s*\\.\\s*)?(?:${names})\\b`, "g")),
      ...f.mask.matchAll(/\.\s*process\s*\??\.\s*env\b/g),
      ...f.mask.matchAll(/\brequire\s*\(\s*(["'])\s*\1\s*\)\s*\.\s*env\b/g),
    ];
    for (const m of hits) {
      const at = m.index + (m[0].length - m[0].trimStart().length);
      const rest = f.code.slice(at, at + 80);
      // クライアント側では、ビルド時に置き換わる NODE_ENV と NEXT_PUBLIC_* だけを許す
      if (clientSide && /^(?:[^\w$.])?process\s*\.\s*env\s*\.\s*(?:NODE_ENV|NEXT_PUBLIC_[A-Z0-9_]+)\b/.test(rest)) continue;
      violate("ARCH-05", "process.env を直接読んでいます。src/lib/env.ts の loadEnv() を使う", { file: f.path, line: f.line(at) });
    }
  }
});

/** tsconfig.json（コメントと末尾のカンマを許す） */
function readTsconfig(relPath) {
  const text = readText(relPath);
  if (text == null) return { error: "読めない" };
  try {
    return { value: JSON.parse(lex(text).code.replace(/,(\s*[}\]])/g, "$1")) };
  } catch (e) {
    return { error: e.message };
  }
}

check("ARCH-11", () => {
  for (const { file, problem } of UNCHECKABLE) {
    violate("ARCH-11", `コードを検査できません（${problem}）。生成物ならディレクトリを分けて除き、コードは分割する`, { file });
  }
  for (const p of INVENTORY.unreadable) violate("ARCH-11", "ディレクトリを読めません", { file: p });
  for (const link of INVENTORY.symlinks) {
    if (/\.md$/i.test(link)) continue;
    violate("ARCH-11", "シンボリックリンクがあります（検査の外のコードや設定を読み込めてしまう）。実体のファイルを置く", { file: link });
  }
  // import の解決を変える設定（@/ の対応）は、チェッカーの前提と同じにする
  for (const file of INVENTORY.files.filter((p) => /^tsconfig[^/]*\.json$/.test(p))) {
    const t = readTsconfig(file);
    if (t.error) {
      violate("ARCH-11", `${file} を読めません（${t.error}）`, { file });
      continue;
    }
    const co = t.value?.compilerOptions ?? {};
    const paths = co.paths;
    if (paths === undefined) continue;
    const keys = Object.keys(paths ?? {});
    const ok = keys.length === 1 && keys[0] === "@/*" && JSON.stringify((paths["@/*"] ?? []).map((v) => String(v).replace(/^\.\//, ""))) === JSON.stringify(["src/*"]);
    if (!ok) violate("ARCH-11", `${file} の paths は { "@/*": ["./src/*"] } だけにする（ほかの対応を足すと、検査とビルドで読み込むファイルが変わる）`, { file });
  }
});

// ---------------------------------------------------------------------------
// 3. 品質・セキュリティ
// ---------------------------------------------------------------------------

const PERMISSIONS_FILE = "src/server/auth/permissions.ts";

/** 権限表（PERMISSIONS）の権限名。見つからなければ null */
function permissionKeys() {
  const f = CODE.get(PERMISSIONS_FILE);
  if (!f) return null;
  const m = /\bPERMISSIONS\s*(?::[^=]+)?=\s*\{/.exec(f.mask);
  if (!m) return null;
  const keys = new Set();
  for (const e of topLevelEntries(f, m.index + m[0].length - 1)) {
    if (e.kind === "prop" || e.kind === "shorthand") keys.add(e.key);
  }
  return keys;
}

check(["SEC-01", "SEC-02", "SEC-07"], () => {
  const keys = permissionKeys();
  if (keys === null) violate("SEC-01", `権限表 ${PERMISSIONS_FILE}（export const PERMISSIONS = { ... }）がありません`);
  else {
    for (const k of keys) {
      if (!/^[a-z][\w-]*\.[\w.-]+$/.test(k)) violate("SEC-01", `権限名「${k}」は <機能>.<操作> の形にする（例: todos.create）`, { file: PERMISSIONS_FILE });
    }
  }
  if (!CODE.has("src/server/audit.ts")) violate("SEC-07", "src/server/audit.ts（監査ログ）がありません");
  for (const f of APP_CODE) {
    if (f.path === ACTION_FILE) continue;
    const mask = f.mask;
    if (!/\bdefineAction\b/.test(mask)) continue;
    const importRanges = f.imports.filter((i) => i.kind === "import").map((i) => [i.index, i.end]);
    for (const imp of f.imports) {
      if (/\bdefineAction\s+as\b/.test(imp.clause ?? "") || (imp.kind === "export" && /\bdefineAction\b/.test(imp.clause ?? ""))) {
        violate("SEC-01", "defineAction を別名にしない・再公開しない（権限・入力・監査の検査をすり抜ける）", { file: f.path, line: f.line(imp.index) });
      }
    }
    for (const m of mask.matchAll(/\bdefineAction\b/g)) {
      if (importRanges.some(([a, b]) => m.index >= a && m.index <= b)) continue;
      const line = f.line(m.index);
      const after = mask.slice(m.index + m[0].length);
      const call = /^\s*(?:<[^>]*>)?\s*\(\s*/.exec(after);
      if (!call) {
        violate("SEC-01", "defineAction は defineAction({ ... }) の形で直接呼ぶ（変数に入れたり値として渡したりしない）", { file: f.path, line });
        continue;
      }
      const open = m.index + m[0].length + call[0].length;
      if (mask[open] !== "{") {
        violate("SEC-01", "defineAction の引数は、その場で書いたオブジェクト（{ permission, input, audit, handler }）にする", { file: f.path, line });
        continue;
      }
      const entries = topLevelEntries(f, open);
      const byKey = new Map();
      for (const e of entries) {
        if (e.kind === "spread") violate("SEC-01", "defineAction({ ... }) の一番外側でスプレッド（...）を使わない（権限や監査の指定が上書きされうる）", { file: f.path, line });
        else if (e.kind === "computed") violate("SEC-01", "defineAction({ ... }) で計算されたキー（[...]）を使わない", { file: f.path, line });
        else if (e.key) {
          if (byKey.has(e.key)) violate(e.key === "input" ? "SEC-02" : e.key === "audit" ? "SEC-07" : "SEC-01", `defineAction の「${e.key}」が2回書かれています`, { file: f.path, line });
          byKey.set(e.key, e);
        }
      }
      const perm = byKey.get("permission");
      const permValue = perm?.kind === "prop" ? /^(["'])([^"'\\\n]+)\1(?:\s+as\s+const)?$/.exec(perm.value) : null;
      if (!perm) violate("SEC-01", "defineAction に permission（権限表の権限名を文字列で）がありません", { file: f.path, line });
      else if (!permValue) violate("SEC-01", 'defineAction の permission は権限名を文字列で直接書く（例: permission: "todos.create"）', { file: f.path, line });
      else if (keys && !keys.has(permValue[2])) violate("SEC-01", `権限「${permValue[2]}」が権限表（${PERMISSIONS_FILE}）にありません`, { file: f.path, line });
      const input = byKey.get("input");
      if (!input || (input.kind === "prop" && !input.value)) violate("SEC-02", "defineAction に input（Zod スキーマ）がありません", { file: f.path, line });
      else if (input.kind === "prop" && /^(?:z\s*\.\s*(?:any|unknown)\s*\(\s*\)|undefined|null)$/.test(input.value)) {
        violate("SEC-02", `defineAction の input が「${input.value}」です。受け取る値を Zod スキーマで決める`, { file: f.path, line });
      }
      const audit = byKey.get("audit");
      if (!audit || audit.kind !== "prop" || !/^(?:true|false)$/.test(audit.value)) {
        violate("SEC-07", "defineAction に audit: true / false を直接書く（登録・更新・削除・権限変更は true）", { file: f.path, line });
      }
    }
  }
});

check("SEC-03", () => {
  const re = /\bdangerouslySetInnerHTML\b|\.\s*(?:inner|outer)HTML\s*(?:\+?=)(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(|\bcreateContextualFragment\s*\(/g;
  for (const f of APP_CODE) {
    for (const m of f.mask.matchAll(re)) {
      violate("SEC-03", `HTML を直接差し込んでいます（${m[0].replace(/\s*\+?=$|\s*\($/, "")}）。React の表示に任せる`, { file: f.path, line: f.line(m.index) });
    }
  }
});

// sql の別名（import { sql as q }・export { sql as q } from "drizzle-orm"・export const q = sql）は案件全体で集める
const SQL_ALIASES = new Set(["sql"]);
for (const f of CODE_FILES) {
  for (const imp of f.imports) {
    for (const [local, orig] of importedNames(imp)) if (orig === "sql") SQL_ALIASES.add(local);
    for (const p of imp.named ?? []) {
      const m = /^(?:type\s+)?sql\s+as\s+([\w$]+)$/.exec(p);
      if (m) SQL_ALIASES.add(m[1]);
    }
  }
  for (const m of f.mask.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*sql\s*[;\n]/g)) SQL_ALIASES.add(m[1]);
}

/** 名前 id が文字列として宣言・代入されているか（const s = "…" / `…` / 文字列の連結 / 引数 s: string） */
function isStringVariable(f, id) {
  const n = escapeRe(id);
  if (new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::\\s*string\\b[^=]*)?=\\s*(?:["'\`]|String\\s*\\()`).test(f.mask)) return true;
  if (new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*:\\s*string\\b`).test(f.mask)) return true;
  if (new RegExp(`(?:[(,]\\s*)${n}\\s*\\??\\s*:\\s*string\\b`).test(f.mask)) return true;
  if (new RegExp(`\\b${n}\\s*\\+?=\\s*["'\`]`).test(f.mask)) return true;
  return false;
}

check("SEC-04", () => {
  const aliases = [...SQL_ALIASES].map(escapeRe).join("|");
  const message = "SQL を文字列で実行しています。Drizzle のクエリビルダか sql`…` のタグ付きテンプレート（値はプレースホルダになる）を使う";
  for (const f of APP_CODE) {
    const hits = [];
    const mask = f.mask;
    // sql.raw とその別名、sql["raw"]、const { raw } = sql
    for (const m of mask.matchAll(new RegExp(`\\b(?:${aliases})\\s*\\??\\.\\s*raw\\b`, "g"))) hits.push(m.index);
    for (const m of mask.matchAll(/\b([A-Za-z_$][\w$]*)\s*\??\.\s*raw\s*\(/g)) if (m[1] !== "String") hits.push(m.index);
    for (const m of mask.matchAll(/\[\s*(["'`])/g)) if (/^\[\s*["'`]raw["'`]\s*\]/.test(f.code.slice(m.index))) hits.push(m.index);
    for (const m of mask.matchAll(new RegExp(`\\{[^{}]*\\braw\\b[^{}]*\\}\\s*=\\s*(?:${aliases})\\b`, "g"))) hits.push(m.index);
    // 文字列の SQL を直接実行する呼び出し（.execute("…") / .query(`…`) / .exec("…") / .unsafe("…") と、文字列の変数）
    for (const m of mask.matchAll(/\.\s*(execute|query|exec|unsafe)\s*\(\s*(["'`]|[A-Za-z_$][\w$]*)/g)) {
      if (m[1] === "exec") {
        // 正規表現の exec は対象外（/re/.exec(…)・re.exec(…) で re が正規表現）
        const recv = mask.slice(Math.max(0, m.index - 120), m.index).trimEnd();
        if (recv.endsWith("/")) continue;
        const rid = /([A-Za-z_$][\w$]*)$/.exec(recv)?.[1];
        if (rid && new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(rid)}\\s*(?::[^=]+)?=\\s*(?:\\/|new\\s+RegExp\\b)`).test(mask)) continue;
        if (rid && /^(?:re|regex|regexp|pattern|matcher)$/i.test(rid)) continue;
      }
      const arg = m[2];
      if (/^["'`]$/.test(arg) || isStringVariable(f, arg)) hits.push(m.index);
    }
    for (const index of hits) violate("SEC-04", message, { file: f.path, line: f.line(index) });
  }
});

const DEV_HOSTS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i;
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_][\w]*\}?|<[^>]*>|%[A-Za-z_]\w*%|\{\{?[^}]*\}\}?|\*+|x+|\.\.\.|[A-Z][A-Z0-9_]*)$/;
const EXAMPLE_HOST = /(^|\.)example\.(?:com|net|org|jp|co\.jp|ne\.jp|or\.jp|go\.jp|ac\.jp|ad\.jp|ed\.jp|gr\.jp|lg\.jp)$|\.(?:example|test|invalid|localhost)$/;

const SECRET_PATTERNS = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "AWS のアクセスキー"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, "秘密鍵"],
  [/\bxox[abposr]-[0-9A-Za-z-]{10,}/, "Slack のトークン"],
  [/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_\-/]{6,}/, "Slack の Webhook URL"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, "GitHub のトークン"],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{24,}/, "API キー"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{16,}/, "Stripe のシークレットキー"],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, "Google の API キー"],
  [/(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/, "Microsoft Entra ID のクライアントシークレット"],
];
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:@/"'`]+):([^\s@/"'`]+)@(\[[^\]\s]+\]|[^\s/:"'`?#]+)/gi;
// 名前に password・secret・token などを含む識別子（camelCase・snake_case）への文字列の代入
const SECRET_TOKENS = new Set(["password", "passwd", "pass", "pwd", "passphrase", "secret", "secrets", "token", "credential", "credentials"]);
const SECRET_JOINED = ["apikey", "privatekey", "accesskey", "clientsecret", "secretkey", "signingkey", "authkey"];
const ASSIGNED = /(?:^|[^\w$.])(?:(["'])([A-Za-z_$][\w$-]*)\1|([A-Za-z_$][\w$]*))\s*[:=]\s*(["'`])([\x21\x23-\x26\x28-\x5b\x5d-\x5f\x61-\x7e]{8,})\4/g;

// 値ではなく名前・場所を入れる変数（E2E_AUTH_TOKEN_COOKIE・TOKEN_HEADER・passwordField など）
const NOT_SECRET_LAST = new Set(["cookie", "name", "names", "header", "param", "field", "label", "type", "path", "url", "uri", "env", "var", "prefix", "suffix", "id", "key"]);

function isSecretName(name) {
  const t = tokens(name);
  const joined = t.join("");
  if (t.length > 1 && NOT_SECRET_LAST.has(t[t.length - 1]) && !SECRET_JOINED.some((j) => joined.endsWith(j))) return false;
  return t.some((w) => SECRET_TOKENS.has(w)) || SECRET_JOINED.some((j) => joined.includes(j));
}

/** 秘密情報らしい値か（環境変数名・URL・小文字だけの名前・テンプレートは除く） */
function looksSecret(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value) || /^(?:https?:\/\/|\/)/.test(value) || /^[a-z][a-z_.-]*$/.test(value) || value.includes("${")) return false;
  // 小文字の単語をつないだ名前（devkit-e2e-token・session_v2 など）
  if (/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/.test(value)) return false;
  return /\d/.test(value) || /[^\w.-]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

/** compose ファイルの開発用の DB（サービス名と POSTGRES_PASSWORD） */
function composeDevDb(text) {
  const services = new Set();
  let inServices = false;
  for (const line of text.split("\n")) {
    if (/^services\s*:/.test(line)) inServices = true;
    else if (/^\S/.test(line)) inServices = false;
    else if (inServices) {
      const m = /^ {2}([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
      if (m) services.add(m[1]);
    }
  }
  const passwords = new Set([...text.matchAll(/\bPOSTGRES_PASSWORD\s*[:=]\s*["']?([^"'\s]+)/g)].map((m) => m[1]));
  return { services, passwords };
}

check("SEC-05", () => {
  for (const file of projectFiles()) {
    if (LOCK_FILE.test(file) || isBinaryPath(file)) continue;
    const r = readFileChecked(file, TEXT_LIMIT);
    if (r.problem) {
      violate("SEC-05", `秘密情報の検査ができません（${r.problem}）`, { file });
      continue;
    }
    const text = r.text;
    const src = new Source(file, text);
    for (const [re, what] of SECRET_PATTERNS) {
      const m = re.exec(text);
      if (m) violate("SEC-05", `${what}らしき文字列があります。環境変数（本番はシークレット管理）に移す`, { file, line: src.line(m.index) });
    }
    const compose = /(^|\/)[^/]*compose[^/]*\.ya?ml$/i.test(file) ? composeDevDb(text) : null;
    // テストの中の接続文字列は、テスト用の値（形式を確かめるためのもの）として除く
    for (const m of isTest(file) ? [] : text.matchAll(DB_URL)) {
      const [, user, pass, hostRaw] = m;
      const host = hostRaw.toLowerCase();
      if (DEV_HOSTS.test(host) || PLACEHOLDER.test(pass) || PLACEHOLDER.test(hostRaw) || (PLACEHOLDER.test(user) && /^[A-Z]/.test(user) && /^[A-Z]/.test(pass)) || EXAMPLE_HOST.test(host)) continue;
      if (compose?.services.has(hostRaw) && compose.passwords.has(pass)) continue; // compose の開発用 DB サービス
      violate("SEC-05", `パスワード付きの接続文字列（${m[0].split("://")[0]}://…@${hostRaw}）があります。環境変数に移す`, { file, line: src.line(m.index) });
    }
    if (CODE_EXT.test(file) && !isTest(file) && !KIT.test(file)) {
      for (const m of text.matchAll(ASSIGNED)) {
        const name = m[2] ?? m[3];
        if (!isSecretName(name) || !looksSecret(m[5])) continue;
        violate("SEC-05", `「${name}」に値を直書きしています。環境変数から読む`, { file, line: src.line(m.index + (m[0].length - m[0].trimStart().length)) });
      }
    }
  }
});

const NEXT_CONFIGS = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];

/** src の中で名前 id を宣言している範囲（const / let / var の初期化式か function）。なければ null */
function declarationRange(src, id) {
  const { mask } = src;
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRe(id)}\\s*(?::[^=\\n]+)?=`).exec(mask);
  if (decl) {
    const start = decl.index + decl[0].length;
    return { a: start, b: statementEnd(mask, start) };
  }
  const fn = new RegExp(`\\bfunction\\s*\\*?\\s*${escapeRe(id)}\\s*(?:<[^>]*>)?\\s*\\(`).exec(mask);
  if (fn) {
    const body = functionBody(mask, fn.index + fn[0].length - 1);
    if (body) return { a: fn.index, b: body.close + 1 };
  }
  return null;
}

/**
 * next.config の headers() の定義のテキスト（コメントを除く）。
 * 本体が参照している定数・関数の定義も足す（同じファイルの securityHeaders や、
 * ./src/lib/security-headers から import した contentSecurityPolicy() など。相対パスと @/ の import をたどる）。
 */
function headersDefinition(f) {
  const queue = [];
  for (const m of f.mask.matchAll(/\bheaders\s*(?:\(|[:=]\s*(?:async\s+)?(?:function\b[^(]*)?\()/g)) {
    const body = functionBody(f.mask, m.index + m[0].length - 1);
    if (body) queue.push({ src: f, a: m.index, b: body.close + 1, depth: 0 });
  }
  if (!queue.length) return null;
  const parts = [];
  const seen = new Set();
  while (queue.length) {
    const { src, a, b, depth } = queue.shift();
    parts.push(src.code.slice(a, b));
    if (depth >= 8) continue;
    const imports = src.imports.filter((i) => i.kind === "import");
    for (const id of new Set(src.mask.slice(a, b).match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const key = `${src.path}#${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const local = declarationRange(src, id);
      if (local) {
        queue.push({ src, ...local, depth: depth + 1 });
        continue;
      }
      for (const imp of imports) {
        const original = importedNames(imp).get(id);
        if (!original) continue;
        const target = resolveFile(src.path, imp.spec);
        const t = target && loadSource(target);
        const r = t && declarationRange(t, original);
        if (r) queue.push({ src: t, ...r, depth: depth + 1 });
      }
    }
  }
  return parts.join("\n");
}

check("SEC-06", () => {
  const file = NEXT_CONFIGS.find((f) => existsSync(abs(f)));
  if (!file) return violate("SEC-06", "next.config.ts がありません");
  const f = loadSource(file);
  if (!f) return violate("SEC-06", `${file} を読めません`, { file });
  const def = headersDefinition(f);
  if (def == null) return violate("SEC-06", `${file} に headers()（セキュリティヘッダの設定）がありません`, { file });
  const header = (name) => new RegExp(`(["'\`])${escapeRe(name)}\\1`, "i").test(def);
  const need = (cond, message) => {
    if (!cond) violate("SEC-06", message, { file });
  };
  need(header("X-Content-Type-Options") && /\bnosniff\b/i.test(def), "headers() に X-Content-Type-Options: nosniff がありません");
  need(header("Referrer-Policy"), "headers() に Referrer-Policy がありません");
  need(header("Strict-Transport-Security") && /max-age=\d+/i.test(def), "headers() に Strict-Transport-Security（max-age=…）がありません");
  need(header("X-Frame-Options") || /\bframe-ancestors\b/i.test(def), "headers() に X-Frame-Options か CSP の frame-ancestors がありません");
  if (!header("Content-Security-Policy")) need(false, "headers() に Content-Security-Policy がありません");
  else {
    need(/\bobject-src\s+'none'/i.test(def), "Content-Security-Policy に object-src 'none' がありません");
    need(/\bbase-uri\s+'(?:none|self)'/i.test(def), "Content-Security-Policy に base-uri 'none' か 'self' がありません");
    need(/\bframe-ancestors\s+'none'/i.test(def), "Content-Security-Policy に frame-ancestors 'none' がありません");
  }
  need(/\bsource\s*:\s*(["'`])(?:\/\(\.\*\)|\/:path\*|\/:path\(\.\*\))\1/.test(def), 'headers() をすべてのパス（source: "/(.*)"）に当てる');
});

const GUARD_FILE = "src/server/auth/guard.ts";
const GUARDS = ["requireUser", "requirePermission", "allowAnonymous"];
const CHECKED_GUARDS = ["requireUser", "requirePermission"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const EXIT_CALLS = /^(?:return\b|throw\b|(?:redirect|permanentRedirect|notFound|forbidden|unauthorized)\s*\()/;
const APP_DIR = /^(?:src\/)?app\//;
const METADATA_ROUTE = /^(?:src\/)?app\/(?:.*\/)?(?:opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\d*\.[cm]?[jt]sx?$/;
const LAYOUT_LIKE = /^(?:src\/)?app\/(?:.*\/)?(?:layout|template|default|not-found|loading)\.[cm]?[jt]sx?$/;

/** 画面（default export）の関数本体 */
function defaultExportBody(f) {
  const mask = f.mask;
  let m = /\bexport\s+default\s+(?:async\s+)?function\b[^(]*\(/.exec(mask);
  if (m) return functionBody(mask, m.index + m[0].length - 1);
  m = /\bexport\s+default\s+(?:async\s*)?\(/.exec(mask);
  if (m) return functionBody(mask, m.index + m[0].length - 1);
  m = /\bexport\s+default\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(mask);
  if (m) return bodyAfterParams(mask, m.index + m[0].length - 2);
  m = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(mask) ?? /\bexport\s*\{[^}]*\b([A-Za-z_$][\w$]*)\s+as\s+default\b[^}]*\}/.exec(mask);
  return m ? namedFunctionBody(mask, m[1]) : null;
}

function namedFunctionBody(mask, name) {
  const n = escapeRe(name);
  let m = new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*(?:<[^>]*>)?\\s*\\(`).exec(mask);
  if (m) return functionBody(mask, m.index + m[0].length - 1);
  m = new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b[^(]*)?\\(`).exec(mask);
  if (m) return functionBody(mask, m.index + m[0].length - 1);
  m = new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`).exec(mask);
  if (m) return bodyAfterParams(mask, m.index + m[0].length - 2);
  return null;
}

/** ファイルが DB や src/server の処理に触れるか（レイアウトやメタデータの入口の確認に使う） */
function touchesServerData(f) {
  if (/\bgetDb\b/.test(f.mask)) return true;
  return f.imports.some((imp) => {
    if (imp.typeOnly) return false;
    const target = resolveSpec(f.path, imp.spec);
    return DB_PACKAGES.test(imp.spec) || isDbPath(target) || (target.startsWith("src/server/") && target !== "src/server/auth/guard");
  });
}

check("SEC-11", () => {
  const guardSrc = CODE.get(GUARD_FILE);
  if (!guardSrc) violate("SEC-11", `${GUARD_FILE}（requireUser / requirePermission / allowAnonymous）がありません`);
  else {
    for (const g of GUARDS) {
      if (!new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\s+${g}\\b|(?:const|let|var)\\s+${g}\\b)`).test(guardSrc.mask)) {
        violate("SEC-11", `${GUARD_FILE} が ${g} を export していません`, { file: GUARD_FILE });
      }
    }
  }
  for (const f of APP_CODE) {
    if (/^(?:src\/)?pages\//.test(f.path)) {
      violate("SEC-11", "pages/（Pages Router）は使わない。画面と API は app/ に置き、入口でガードを呼ぶ", { file: f.path, line: 1 });
      continue;
    }
    if (!APP_DIR.test(f.path)) continue;
    if (f.path.startsWith("app/") && existsSync(abs("src/app"))) {
      violate("SEC-11", "app/ と src/app/ の両方があります（Next.js はルートの app/ を使い、src/app/ を無視する）。src/app/ だけにする", { file: f.path, line: 1 });
    }
    const kind = /\/(page|route)\.[cm]?[jt]sx?$/.exec(f.path)?.[1] ?? (METADATA_ROUTE.test(f.path) ? "metadata" : LAYOUT_LIKE.test(f.path) ? "layout" : null);
    const hasGenerateMetadata = /\bexport\s+(?:async\s+function\s+|function\s+|(?:const|let|var)\s+)generateMetadata\b/.test(f.mask);
    if (!kind && !hasGenerateMetadata) continue;
    const needsData = touchesServerData(f);
    // レイアウト・メタデータは、DB やサーバーの処理に触れるときだけ入口の確認を求める
    if ((kind === "layout" || kind === "metadata" || !kind) && !needsData) continue;

    const local = new Map();
    for (const imp of f.imports) {
      if (imp.kind !== "import" || resolveSpec(f.path, imp.spec) !== "src/server/auth/guard") continue;
      for (const [l, o] of importedNames(imp)) if (GUARDS.includes(o)) local.set(l, o);
    }
    const label = { page: "画面", route: "API", layout: "レイアウト", metadata: "メタデータ" }[kind] ?? "メタデータ";
    // Better Auth の認証の API（app/api/auth/ の export const { GET, POST } = toNextJsHandler(auth)）は、ガードの外で公開する
    const betterAuth =
      kind === "route" &&
      /^(?:src\/)?app\/api\/auth\//.test(f.path) &&
      f.imports.some((imp) => imp.spec === "better-auth/next-js" && importedNames(imp).get("toNextJsHandler") === "toNextJsHandler");
    if (!local.size && !betterAuth) {
      violate("SEC-11", `${label}の入口で @/server/auth/guard の requireUser / requirePermission（結果を確かめる）か allowAnonymous("理由") を呼ぶ`, { file: f.path, line: 1 });
      continue;
    }
    const names = local.size ? [...local.keys()].map(escapeRe).join("|") : "(?!)";
    const checkBody = (body, what, index) => {
      const line = f.line(index);
      if (!body) return violate("SEC-11", `${what}の関数が見つからず、入口の確認ができません。関数として直接 export する`, { file: f.path, line });
      const [first, second] = leadingStatements(f, body, 2);
      const stmt = first?.text ?? "";
      const anon = new RegExp(`^(?:await\\s+)?(${names})\\s*\\(`).exec(stmt);
      if (anon && local.get(anon[1]) === "allowAnonymous") {
        if (!/^\s*(["'`])\s*[^\s"'`]/.test(stmt.slice(anon[0].length))) {
          violate("SEC-11", 'allowAnonymous には公開する理由を文字列で書く（例: allowAnonymous("ヘルスチェックは監視から呼ぶ")）', { file: f.path, line });
        }
        return;
      }
      if (anon) return violate("SEC-11", `${what}: ${anon[1]} の結果を変数に受けて、if (!結果.ok) で return する（結果を捨てると、権限がなくても処理が続く）`, { file: f.path, line });
      const assigned = new RegExp(`^(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*await\\s+(${names})\\s*(?:<[^>]*>)?\\s*\\(`).exec(stmt);
      if (!assigned || !CHECKED_GUARDS.includes(local.get(assigned[2]))) {
        const destructured = new RegExp(`^(?:const|let)\\s*[{[][^=]*=\\s*await\\s+(?:${names})\\b`).test(stmt);
        return violate(
          "SEC-11",
          destructured
            ? `${what}: ガードの結果を分割代入しない。const access = await requirePermission(…); if (!access.ok) return …; の形にする`
            : `${what}の最初の文で requireUser / requirePermission（結果を確かめる）か allowAnonymous("理由") を呼ぶ`,
          { file: f.path, line },
        );
      }
      // 次の文で結果を確かめて抜ける: if (!access.ok) return / redirect() / notFound() / throw
      const v = escapeRe(assigned[1]);
      const ifm = second && /^if\s*\(/.exec(second.text);
      let ok = false;
      if (ifm && second.condClose !== undefined) {
        const cond = f.code.slice(second.start + ifm[0].length, second.condClose).replace(/\s+/g, "");
        const condOk = new RegExp(`^(?:!${v}\\??\\.ok|!\\(${v}\\??\\.ok\\)|${v}\\??\\.ok===?false|false===?${v}\\??\\.ok|${v}\\??\\.ok!==?true)$`).test(cond);
        const consequent = f.code.slice(second.condClose + 1, second.end).trim().replace(/^\{\s*/, "");
        ok = condOk && EXIT_CALLS.test(consequent);
      }
      if (!ok) {
        violate("SEC-11", `${what}: ${assigned[2]} の結果をすぐ次の文で確かめる（if (!${assigned[1]}.ok) return … / redirect() / notFound() / throw）`, { file: f.path, line });
      }
    };

    if (kind === "page" || kind === "layout" || kind === "metadata") {
      const m = /\bexport\s+default\b/.exec(f.mask);
      checkBody(m ? defaultExportBody(f) : null, label, m?.index ?? 0);
    }
    if (hasGenerateMetadata && needsData) {
      const m = /\bexport\s+(?:async\s+function\s+|function\s+|(?:const|let|var)\s+)generateMetadata\b/.exec(f.mask);
      checkBody(namedFunctionBody(f.mask, "generateMetadata"), "generateMetadata", m.index);
    }
    if (kind !== "route") continue;
    // API はメソッドごとに確かめる
    for (const method of HTTP_METHODS) {
      for (const m of f.mask.matchAll(new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s*${method}\\b\\s*(?:<[^>]*>)?\\s*\\(`, "g"))) {
        checkBody(functionBody(f.mask, m.index + m[0].length - 1), method, m.index);
      }
    }
    for (const d of exportDeclarators(f)) {
      if (d.destructure) {
        // 許すのは Better Auth の export const { GET, POST } = toNextJsHandler(auth) だけ（app/api/auth/ の下）
        const allowed = betterAuth && /^\{\s*(?:GET|POST)(?:\s*,\s*(?:GET|POST))?\s*\}\s*=\s*toNextJsHandler\s*\(\s*auth(?:\s*\.\s*handler)?\s*\)\s*$/.test(d.init.trim());
        if (!allowed) violate("SEC-11", "API のメソッドを分割代入で export しない（入口の確認ができない）。関数として直接 export する", { file: f.path, line: f.line(d.index) });
        continue;
      }
      if (!HTTP_METHODS.includes(d.name)) continue;
      if (d.kind !== "const" || d.init == null) {
        violate("SEC-11", `${d.name} は let / var で export しない。関数として直接 export する`, { file: f.path, line: f.line(d.index) });
        continue;
      }
      const init = d.init;
      const fn = /^\s*(?:async\s*)?(?:function\b[^(]*)?\(/.exec(init);
      const arrow = /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.exec(init);
      const base = f.mask.indexOf(init, d.index);
      const body = fn ? functionBody(f.mask, base + fn[0].length - 1) : arrow ? bodyAfterParams(f.mask, base + arrow[0].length - 2) : null;
      checkBody(body, d.name, d.index);
    }
    for (const m of f.mask.matchAll(/\bexport\s*(type\s*)?\{([^}]*)\}/g)) {
      if (m[1]) continue;
      const exported = m[2].split(",").map((s) => s.trim().split(/\s+as\s+/).pop());
      if (exported.some((n) => HTTP_METHODS.includes(n))) {
        violate("SEC-11", "API のメソッドは export { } でまとめず、関数として直接 export する", { file: f.path, line: f.line(m.index) });
      }
    }
    for (const m of f.mask.matchAll(/\bexport\s*\*/g)) {
      violate("SEC-11", "route の export * は使わない（入口の確認ができない）", { file: f.path, line: f.line(m.index) });
    }
  }
});

// ---------------------------------------------------------------------------
// 4. 運用標準
// ---------------------------------------------------------------------------

const TIERS = ["lite", "standard", "ha"];
const AUTHS = ["dev", "none", "better-auth", "sso-entra", "sso-google"];
const HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]*[a-z][a-z0-9-]*$|^\d{1,3}(?:\.\d{1,3}){3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

check("OPS-01", () => {
  const file = "docs/profile.json";
  if (PROFILE_JSON.missing) return violate("OPS-01", "docs/profile.json（案件プロファイル）がありません");
  if (PROFILE_JSON.error) return violate("OPS-01", PROFILE_JSON.error, { file });
  if (!PROFILE || Array.isArray(PROFILE)) return violate("OPS-01", "docs/profile.json はオブジェクトにする", { file });
  const p = PROFILE;
  const v = (message) => violate("OPS-01", message, { file });
  if (typeof p.project !== "string") v("project（案件名）を文字列で書く");
  if (typeof p.users !== "string") v("users（誰が何人くらい使うか）を文字列で書く");
  if (!TIERS.includes(p.tier)) v(`tier は ${TIERS.join(" / ")} のどれか（現在: ${p.tier}）`);
  if (!AUTHS.includes(p.auth)) v(`auth は ${AUTHS.join(" / ")} のどれか（現在: ${p.auth}）`);
  if (!Array.isArray(p.externalHosts)) v("externalHosts は配列にする");
  else {
    for (const h of p.externalHosts) {
      if (typeof h !== "string" || !HOST_RE.test(h.toLowerCase())) v(`externalHosts の「${h}」はホスト名だけを書く（例: api.example.co.jp・*.example.co.jp）`);
    }
  }
  if (typeof p.released !== "boolean") v("released は true / false");
  if (typeof p.releasedMigration !== "string") v("releasedMigration は文字列（未リリースなら空）");
  const pd = p.personalData;
  if (!pd || typeof pd !== "object" || typeof pd.stored !== "boolean" || !Array.isArray(pd.items)) {
    v("personalData は { stored: true / false, items: [個人情報の項目] } にする");
  } else if (pd.stored && pd.items.length === 0) v("personalData.stored が true なら items に保存する個人情報の項目を書く");
  const owners = p.owners;
  const ownersOk = owners && typeof owners === "object" && ["business", "technical"].every((k) => Array.isArray(owners[k]));
  if (!ownersOk) return v("owners は { business: [{ name, email }], technical: [{ name, email }] } にする");
  for (const k of ["business", "technical"]) {
    for (const o of owners[k]) {
      if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.email !== "string") v(`owners.${k} の各要素は { name, email } にする`);
    }
  }
  if (opt.release) {
    if (!nonEmpty(p.project) || /__\w+__/.test(p.project)) v("リリース前に project（案件名）を記入する");
    const label = { business: "業務担当者", technical: "技術担当者（標準オーナー）" };
    for (const k of ["business", "technical"]) {
      const filled = owners[k].filter((o) => nonEmpty(o?.name) && EMAIL_RE.test(String(o?.email ?? "")));
      if (!filled.length) v(`リリース前に owners.${k}（${label[k]}）の名前とメールアドレスを記入する`);
    }
  }
});

check("OPS-02", () => {
  const f = CODE.get("src/app/api/health/route.ts") ?? CODE.get("app/api/health/route.ts");
  if (!f || !/\bexport\s+(?:async\s+function\s+GET\b|function\s+GET\b|(?:const|let|var)\s+GET\b)/.test(f.mask)) {
    violate("OPS-02", "GET /api/health（src/app/api/health/route.ts）がありません");
  }
});

const STARTUP_MIGRATE = /\bdrizzle-kit\s+(?:migrate|push)\b|\b(?:db:migrate|db:push|db:setup)\b|\bmigrate\s*\(/;

/** 行のコメント（# …）を同じ長さの空白にする（位置と行番号を保つ） */
function blankHashComments(text, alsoSlashes = false) {
  return text
    .split("\n")
    .map((l) => {
      let out = l.replace(/(^|\s)(#.*)$/, (_, a, b) => a + " ".repeat(b.length));
      if (alsoSlashes) out = out.replace(/(^|\s)(\/\/.*)$/, (_, a, b) => a + " ".repeat(b.length));
      return out;
    })
    .join("\n");
}

/** Dockerfile の命令（行の継続をつなげ、JSON の配列は空白区切りにする） */
function dockerInstructions(text, names) {
  const out = [];
  const lines = blankHashComments(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, " ") + lines[++i];
    const m = new RegExp(`^\\s*(${names.join("|")})\\s+(.*)$`, "i").exec(line);
    if (!m) continue;
    let args = m[2].trim();
    if (args.startsWith("[")) {
      try {
        args = JSON.parse(args).join(" ");
      } catch {
        args = args.replace(/[[\]",]/g, " ");
      }
    }
    out.push({ kind: m[1].toUpperCase(), args, line: start + 1 });
  }
  return out;
}

/** compose の command: / entrypoint: の値（続く行の配列・ブロックも含める） */
function composeCommands(text) {
  const out = [];
  const lines = blankHashComments(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(command|entrypoint)\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const parts = [m[3]];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || lines[j].length - lines[j].trimStart().length > indent)) parts.push(lines[j++]);
    out.push({ args: parts.join(" ").replace(/[[\]",'|>]/g, " ").replace(/\s-\s/g, " "), line: i + 1 });
  }
  return out;
}

check("OPS-03", () => {
  for (const f of APP_CODE) {
    for (const m of f.code.matchAll(/["'`]drizzle-orm\/([\w-]+)\/migrator["'`]/g)) {
      if (m[1] === "pglite") continue; // 開発・テスト用の PGlite は起動時に適用してよい
      violate("OPS-03", "本番 DB 用の migrator をアプリから呼んでいます。本番のマイグレーションはデプロイの手順で人が pnpm db:migrate を実行する", {
        file: f.path,
        line: f.line(m.index),
      });
    }
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  for (const name of ["start", "prestart", "poststart"]) {
    if (typeof scripts[name] === "string" && STARTUP_MIGRATE.test(scripts[name])) {
      violate("OPS-03", `package.json の ${name} がマイグレーションを実行しています。起動時に適用しない`, { file: "package.json" });
    }
  }
  const scanScript = (relPath, origin) => {
    const t = readText(relPath);
    if (t == null) return;
    blankHashComments(t)
      .split("\n")
      .forEach((line, i) => {
        if (STARTUP_MIGRATE.test(line)) violate("OPS-03", `起動時に実行されるスクリプト（${origin}）がマイグレーションを実行しています`, { file: relPath, line: i + 1 });
      });
  };
  const referencedScripts = (args, origin) => {
    for (const s of args.match(/[\w./-]+\.(?:sh|mjs|cjs|js|ts)\b/g) ?? []) {
      const p = s.replace(/^\.?\//, "").replace(/^app\//, "");
      if (existsSync(abs(p))) scanScript(p, origin);
    }
  };
  for (const file of projectFiles()) {
    const base = file.split("/").pop();
    if (/^Dockerfile(?:\..+)?$|\.dockerfile$/i.test(base)) {
      for (const ins of dockerInstructions(readText(file) ?? "", ["CMD", "ENTRYPOINT"])) {
        if (STARTUP_MIGRATE.test(ins.args)) {
          violate("OPS-03", `${ins.kind} でマイグレーションを実行しています。本番のマイグレーションはデプロイの手順で人が実行する`, { file, line: ins.line });
        }
        referencedScripts(ins.args, `${file} の ${ins.kind}`);
      }
    } else if (/compose[^/]*\.ya?ml$/i.test(base)) {
      for (const c of composeCommands(readText(file) ?? "")) {
        if (STARTUP_MIGRATE.test(c.args)) violate("OPS-03", "compose の command / entrypoint でマイグレーションを実行しています", { file, line: c.line });
        referencedScripts(c.args, `${file} の command`);
      }
    }
  }
});

/**
 * SQL の字句解析。コメントと文字列（'…'・E'…'）を空白にする（位置と行番号を保つ）。
 * keepIdentifiers が false なら "…" の識別子も空白にする（列名 "truncate" などで誤検出しないため）。
 * $tag$ … $tag$ の中身は SQL として読む（関数や DO の本体）。文字列は strings に集める。
 */
function sqlLex(text, { keepIdentifiers = false } = {}) {
  const out = text.split("");
  const strings = [];
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      const e = text.indexOf("\n", i);
      const stop = e < 0 ? n : e;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const escapes = /[eE]$/.test(text.slice(Math.max(0, i - 1), i)) && !/[\w$]/.test(text[i - 2] ?? "");
      let j = i + 1;
      let value = "";
      while (j < n) {
        if (escapes && text[j] === "\\") {
          value += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += text[j++];
      }
      strings.push({ index: i, end: j + 1, value });
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
      if (!keepIdentifiers) blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        blank(i, i + m[0].length); // 区切りだけを消し、中身は SQL として読む
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return { code: out.join(""), strings };
}

const DESTRUCTIVE_SQL = [
  [/\bDROP\s+(?!DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b)/gi],
  [/\bTRUNCATE\b/gi],
  [/\bDELETE\s+FROM\b/gi],
  [/\bRENAME\b/gi],
  [/\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|[\w$]+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi],
];

/** SQL の破壊的な変更 [{ index, what }]。EXECUTE の中の文字列も読む（中身を読めない動的 SQL は破壊的とみなす） */
function destructiveStatements(text) {
  const { code, strings } = sqlLex(text);
  const out = [];
  const snippet = (i) => text.slice(i, i + 60).split("\n")[0].replace(/\s+/g, " ").trim();
  for (const [re] of DESTRUCTIVE_SQL) for (const m of code.matchAll(re)) out.push({ index: m.index, what: snippet(m.index) });
  for (const m of code.matchAll(/\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)\s*/gi)) {
    const after = m.index + m[0].length;
    const str = strings.find((s) => s.index === after);
    if (!str) {
      out.push({ index: m.index, what: "動的な SQL（EXECUTE。中身を検査できない）" });
      continue;
    }
    for (const d of destructiveStatements(str.value)) out.push({ index: m.index, what: `EXECUTE の中の ${d.what}` });
  }
  return out;
}

const migrationName = (f) => f.replace(/\.sql$/, "");

check("OPS-04", () => {
  if (PROFILE?.released !== true) return;
  const dir = abs("drizzle");
  const after = migrationName(String(PROFILE.releasedMigration ?? "").trim());
  if (!after) {
    return violate("OPS-04", "released が true なら releasedMigration（本番に適用済みの最後のマイグレーション名。例: 0003_add_status）を記入する", {
      file: "docs/profile.json",
    });
  }
  const sqlFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
  if (!sqlFiles.includes(`${after}.sql`)) {
    violate("OPS-04", `releasedMigration「${after}」が drizzle/ にありません`, { file: "docs/profile.json" });
  }
  for (const name of sqlFiles) {
    if (migrationName(name) <= after) continue;
    const file = `drizzle/${name}`;
    const r = readFileChecked(file, TEXT_LIMIT);
    if (r.problem) {
      violate("OPS-04", `マイグレーションを検査できません（${r.problem}）`, { file, subject: `migration:${name}` });
      continue;
    }
    const src = new Source(file, r.text);
    const byLine = new Map();
    for (const d of destructiveStatements(r.text)) {
      const line = src.line(d.index);
      if (!byLine.has(line)) byLine.set(line, d.what);
    }
    for (const [line, what] of [...byLine].sort((a, b) => a[0] - b[0])) {
      violate("OPS-04", `リリース後のマイグレーションに破壊的な変更（${what}）があります。追加→移行→削除の段階的な変更にする`, {
        file,
        line,
        subject: `migration:${name}`,
      });
    }
  }
  // リリース済みのマイグレーションを書き換えない（--base があれば差分で確かめる）
  if (DIFF?.ok) {
    for (const [f, status] of DIFF.changed) {
      const m = /^drizzle\/([^/]+)\.sql$/.exec(f);
      if (!m || m[1] > after) continue;
      const what = status === "D" ? "削除" : "変更";
      violate("OPS-04", `リリース済みのマイグレーション ${f} が${what}されています。適用済みのファイルは変えず、新しいマイグレーションを追加する`, {
        file: f,
        subject: `migration:${m[1]}.sql`,
      });
    }
  }
});

check("ESC-06", () => {
  const file = "docs/exceptions.json";
  if (EXC_JSON.error) return violate("ESC-06", EXC_JSON.error, { file });
  if (EXC_JSON.value && !Array.isArray(EXC_JSON.value.exceptions)) return violate("ESC-06", 'docs/exceptions.json は { "exceptions": [ ... ] } にする', { file });
  for (const { e, missing } of EXC_PROBLEMS) {
    violate("ESC-06", `例外 ${nonEmpty(e.id) ? e.id : "(id なし)"} の記録が不足しているため適用しません: ${missing.join("、")}`, { file });
  }
  for (const e of EXC_VALID) {
    if (e.reviewBy < TODAY) {
      const message = `例外 ${e.id}（${e.rules.join(",")} / ${e.subject}）の見直し期限 ${e.reviewBy} を過ぎています。標準オーナーが見直す`;
      if (opt.release) violate("ESC-06", message, { file });
      else warn("ESC-06", message, file);
    }
    if (e.subject === "*") {
      warn("ESC-06", `例外 ${e.id} により、この案件では ${e.rules.join(",")} を検査していません（見直し期限 ${e.reviewBy}）`, file);
    }
  }
});

// ---------------------------------------------------------------------------
// リリース前の検査（--release）
// ---------------------------------------------------------------------------

const DEPLOY_FILE =
  /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile|[^/]*compose[^/]*\.ya?ml|\.env\.prod[^/]*|app\.ya?ml|apprunner\.ya?ml|task-definition[^/]*\.json)$|^(deploy|infra|terraform|k8s|helm|\.aws)\//i;

/** 開発用の認証を有効にする指定（AUTH_MODE=dev・AUTH_MODE dev と DEVKIT_E2E_AUTH） */
function devAuthHits(text) {
  const hits = [];
  for (const m of text.matchAll(/\bDEVKIT_E2E_AUTH\b/g)) hits.push({ index: m.index, what: "DEVKIT_E2E_AUTH" });
  for (const m of text.matchAll(/\bAUTH_MODE\b/g)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
    if (/^["']?\s*(?:[=:]\s*|[ \t]+)["']?\s*dev\b/.test(rest) || /^["']?[^\n]{0,40}\n?[^\n]{0,40}?\bvalue\b\s*["']?\s*[=:]\s*["']?\s*dev\b/.test(rest)) {
      hits.push({ index: m.index, what: "AUTH_MODE=dev" });
    }
  }
  return hits;
}

if (opt.release) {
  check("SEC-09", () => {
    const auth = PROFILE?.auth;
    if (!PROFILE || auth === "dev") {
      violate("SEC-09", "認証が開発用（auth: dev）のままです。認証を実装し docs/profile.json の auth を更新する", { file: "docs/profile.json" });
    }
    if (auth === "none" && !excepted("SEC-09", "auth:none")) {
      violate("SEC-09", "auth: none（認証なしの公開）には標準の例外承認（rules: SEC-09, subject: auth:none）が必要です", { file: "docs/profile.json" });
    }
    if (/^(?:better-auth|sso-)/.test(auth ?? "")) {
      if (!pkg.dependencies?.["better-auth"]) violate("SEC-09", `auth が ${auth} ですが better-auth が dependencies にありません`, { file: "package.json" });
      const sessionFile = "src/server/auth/session.ts";
      const session = CODE.get(sessionFile);
      const importsBetterAuth = (f) => f.imports.some((i) => /^better-auth(?:\/|$)/.test(i.spec));
      let ok = false;
      if (session) {
        ok = importsBetterAuth(session);
        // session.ts が読み込む src/server/auth/ のモジュール（auth.ts など）が Better Auth を使っていてもよい
        for (const imp of session.imports) {
          if (ok) break;
          const target = resolveFile(sessionFile, imp.spec);
          const t = target && loadSource(target);
          if (t && target.startsWith("src/server/auth/") && importsBetterAuth(t)) ok = true;
        }
      }
      if (!ok) violate("SEC-09", `auth が ${auth} ですが src/server/auth/session.ts が Better Auth を使っていません`, { file: sessionFile });
    }
    // デプロイの設定に開発用の認証が残っていないか（.github/workflows の CI のテストは対象外）
    for (const file of projectFiles()) {
      if (!DEPLOY_FILE.test(file) || file.startsWith(".github/") || isBinaryPath(file)) continue;
      const text = readText(file, TEXT_LIMIT);
      if (text == null) continue;
      const src = new Source(file, text);
      const stripped = /\.json$/i.test(file) ? text : blankHashComments(text, /\.(?:tf|hcl)$/i.test(file));
      for (const h of devAuthHits(stripped)) {
        violate("SEC-09", `デプロイの設定に開発用の認証の指定（${h.what}）があります`, { file, line: src.line(h.index) });
      }
    }
    // 本番のビルド・起動に使う package.json のスクリプト（Dockerfile から呼ばれるもの）
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const names = new Set(["build", "start"]);
    for (const file of projectFiles().filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f))) {
      for (const ins of dockerInstructions(readText(file) ?? "", ["RUN", "CMD", "ENTRYPOINT"])) {
        for (const m of ins.args.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:(?:run|-s|--silent)\s+)*([\w:.-]+)/g)) names.add(m[1]);
      }
    }
    const seen = new Set();
    const visit = (name) => {
      for (const n of [`pre${name}`, name, `post${name}`]) {
        if (seen.has(n) || typeof scripts[n] !== "string") continue;
        seen.add(n);
        if (devAuthHits(scripts[n]).length) violate("SEC-09", `本番のビルド・起動に使うスクリプト「${n}」に開発用の認証の指定があります`, { file: "package.json" });
        for (const m of scripts[n].matchAll(/\b(?:pnpm|npm|yarn)\s+(?:(?:run|-s|--silent)\s+)*([\w:.-]+)/g)) visit(m[1]);
      }
    };
    for (const n of names) visit(n);
  });

  check("OPS-05", () => {
    const file = "docs/runbook.md";
    const text = readText(file);
    if (text == null) return violate("OPS-05", "docs/runbook.md がありません");
    const lines = text.split("\n");
    for (const h of ["起動と停止", "デプロイ", "マイグレーション", "バックアップと復元", "監視と通知", "障害時の連絡先"]) {
      const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*(?:\\d+[.．]\\s*)?${h}`).test(l));
      if (start < 0) {
        violate("OPS-05", `見出し「${h}」がありません`, { file });
        continue;
      }
      // 節は、同じかそれより上の階層の次の見出しまで（下位の見出しは節に含める）
      const level = lines[start].match(/^#+/)[0].length;
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => (l.match(/^(#{1,6})\s/)?.[1].length ?? 99) <= level);
      const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
      if (!body || /（記入）|\(記入\)|未記入/.test(body)) violate("OPS-05", `「${h}」が未記入です`, { file, line: start + 1 });
    }
  });
}

// ---------------------------------------------------------------------------
// フラグ（人の確認が必要な変更）。--base のときだけ
// ---------------------------------------------------------------------------

/** 1行からコメントを除く（コード以外のファイル。行単位） */
function stripLineComment(file, text) {
  if (/\.(ya?ml|toml|sh|env|tf|hcl|py)$|(^|\/)(\.env[^/]*|Dockerfile[^/]*|\.[\w-]*ignore|\.npmrc)$/i.test(file)) return text.replace(/(^|\s)#.*$/, "$1");
  if (/\.(css|scss)$/.test(file)) return text.replace(/\/\*.*?\*\//g, "");
  if (/\.sql$/.test(file)) return text.replace(/--.*$/, "");
  return text;
}

/** 名前を単語に分ける（snake_case・camelCase・kebab-case・末尾の番号） */
function tokens(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([A-Za-z])(\d)/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// 個人情報を表す語（英語とローマ字）
const PII_WORDS = new Set([
  "email", "mail", "phone", "tel", "telephone", "mobile", "cellphone", "fax", "address", "addr", "birthday", "birthdate", "dob",
  "zip", "zipcode", "postal", "postcode", "kana", "furigana", "gender", "sex", "mynumber", "passport", "ssn", "bank", "salary",
  "nationality", "ip", "license", "licence", "contact", "contacts", "personal", "pii",
  "shimei", "seimei", "namae", "jusho", "juusho", "jyusho", "juusyo", "denwa", "keitai", "seinengappi", "tanjobi", "tanjoubi", "yubin",
  "yuubin", "seibetsu", "kojin",
]);
const PII_COMPOUNDS = [
  "fullname", "firstname", "lastname", "familyname", "givenname", "middlename", "realname", "legalname", "username", "nickname",
  "displayname", "mynumber", "dateofbirth", "birthdate", "birthday", "phonenumber", "zipcode", "postalcode", "postcode",
  "emailaddress", "mailaddress", "denwabango", "yubinbango", "seinengappi", "kojinjoho",
];
// 人を表す語。「人 + 名前・番号・コード」の列名（borrower_name・employee_no・staff_code）を個人情報とみなす
const PERSON_WORDS = new Set(
  [
    "borrower", "lender", "employee", "staff", "applicant", "member", "user", "customer", "client", "requester", "requestor",
    "assignee", "owner", "approver", "driver", "student", "patient", "guest", "visitor", "author", "reporter",
    "person", "participant", "worker", "teacher", "parent", "guardian", "tenant", "resident", "recipient", "sender",
    "receiver", "buyer", "seller", "manager", "supervisor", "operator", "inspector", "attendee", "candidate", "volunteer",
    "payee", "payer", "beneficiary", "signer", "submitter", "reviewer", "creator", "holder", "family", "spouse", "child",
    "shain", "jugyoin", "juugyouin", "kokyaku", "shinseisha", "riyosha", "riyousha", "tantosha", "tantousha", "kaiin",
    "gakusei", "kanja", "shonin", "shouninsha",
  ].flatMap((w) => [w, `${w}s`]),
);
PERSON_WORDS.add("people").add("children").add("staffs");
const PERSON_ID_WORDS = new Set(["name", "names", "kana", "no", "num", "number", "code", "cd", "mei", "namae", "bango", "bangou"]);
const PERSON_TABLE_WORDS = new Set([...PERSON_WORDS, "profile", "profiles", "account", "accounts", "contact", "contacts"]);
const TEXT_TYPES = new Set(["text", "varchar", "char", "character", "citext"]);

/** 個人情報らしき列か */
function isPii(column, table, type = "", isForeignKey = false) {
  const t = tokens(column);
  const joined = t.join("");
  const idLike = t.includes("id") && !(TEXT_TYPES.has(String(type).toLowerCase()) && !isForeignKey);
  // contact_id（外部キーや数値の ID）は対象外
  if (t.some((w) => PII_WORDS.has(w)) && !(idLike && t.some((w) => w === "contact" || w === "contacts"))) return true;
  if (PII_COMPOUNDS.some((c) => joined.includes(c))) return true;
  // 姓・名（sei・mei・sei_kana）
  if (t[0] === "sei" || t[0] === "mei") return true;
  const person = t.some((w) => PERSON_WORDS.has(w));
  if (person && t.some((w) => PERSON_ID_WORDS.has(w))) return true;
  // 社員 ID のような文字列の ID（外部キーでないもの）
  if (person && t.includes("id") && TEXT_TYPES.has(String(type).toLowerCase()) && !isForeignKey) return true;
  // name 単体は、人を表すテーブルのときだけ個人情報とみなす（商品名・部署名などを除く）
  return t.includes("name") && tokens(table ?? "").some((w) => PERSON_TABLE_WORDS.has(w));
}

// 外部接続の判定に使わないもの（devkit と標準のファイル、文書、テスト、生成物）
const notScanned = (f) =>
  !f || isTest(f) || isBinaryPath(f) || LOCK_FILE.test(f) || /\.md$/i.test(f) || /^(docs|\.devkit|\.claude|drizzle|scripts\/devkit|scripts\/standard)\//.test(f);

const KNOWN_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1", "www.w3.org"];
const NET_PACKAGES = [
  "@aws-sdk/*", "pg", "postgres", "node:http", "http", "node:https", "https", "node:http2", "http2", "node:net", "net", "node:tls",
  "tls", "node:dgram", "dgram", "undici", "axios", "ws", "nodemailer", "got", "ky", "node-fetch", "node:child_process", "child_process",
];
const isNetPackage = (spec) =>
  NET_PACKAGES.some((p) => (p.endsWith("/*") ? spec.startsWith(p.slice(0, -1)) : spec === p || spec.startsWith(`${p}/`)));

function isKnownHost(host) {
  const known = [...(Array.isArray(PROFILE?.externalHosts) ? PROFILE.externalHosts : []), ...KNOWN_HOSTS].map((h) => String(h).toLowerCase());
  if (known.some((k) => host === k || (k.startsWith("*.") && host.endsWith(k.slice(1))))) return true;
  // 例示用に予約されたドメイン（RFC 2606・JPRS）と、予約された TLD だけ。example.org.attacker.io のようなものは含めない
  if (EXAMPLE_HOST.test(host)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

const isCoreFile = (f) =>
  [
    "src/server/action.ts",
    "src/server/audit.ts",
    "src/lib/env.ts",
    "src/lib/logger.ts",
    "src/lib/security-headers.ts",
    "src/db/client.ts",
    ".dockerignore",
    "docs/profile.json",
    "docs/exceptions.json",
  ].includes(f) ||
  (f.startsWith("src/server/auth/") && f !== PERMISSIONS_FILE) ||
  /^next\.config\.[cm]?[jt]s$/.test(f) ||
  /^(?:src\/)?(?:proxy|middleware|instrumentation(?:-client)?)\.[cm]?[jt]s$/.test(f) ||
  /^tsconfig[^/]*\.json$/.test(f) ||
  /^Dockerfile(?:\..+)?$/.test(f) ||
  /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(f) ||
  f.startsWith(".github/") ||
  /(^|\/)\.gitattributes$/.test(f) ||
  f.startsWith("docs/standard/") ||
  f.startsWith("scripts/standard/");

/** 追加された行のコード（コードのファイルはファイル全体を字句解析してコメントを除く。mask は文字列も除いたもの） */
function addedCode(file) {
  const added = addedLines(file);
  if (!added.length || !CODE_EXT.test(file)) return added.map((a) => ({ ...a, code: stripLineComment(file, a.text), mask: null }));
  const text = newText(file);
  if (text == null) return added.map((a) => ({ ...a, code: a.text, mask: a.text }));
  const lexed = lex(text);
  const codeLines = lexed.code.split("\n");
  const maskLines = lexed.mask.split("\n");
  return added.map((a) => ({ ...a, code: codeLines[a.line - 1] ?? a.text, mask: maskLines[a.line - 1] ?? a.text }));
}

/** can() の実装（空白を詰めたコード）。なければ null */
function canImplementation(text) {
  if (text == null) return null;
  const s = new Source(PERMISSIONS_FILE, text);
  const body = namedFunctionBody(s.mask, "can");
  return body ? s.code.slice(body.open, body.close + 1).replace(/\s+/g, " ") : null;
}

function runFlags() {
  const changed = [...DIFF.changed.keys()].sort();

  // ESC-02 新しい外部の接続先（src の外の設定ファイルと public/ も見る）
  checked.add("ESC-02");
  const hosts = new Map();
  const calls = [];
  const netImports = [];
  for (const file of changed) {
    if (notScanned(file)) continue;
    const isCode = CODE_EXT.test(file);
    const external = file.startsWith("src/server/external/");
    for (const { line, code, mask } of addedCode(file)) {
      const text = code.replace(/(["'])\$schema\1\s*:\s*(["'])[^"'\n]*\2\s*,?/g, "");
      const found = [
        ...[...text.matchAll(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"'`]+@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)/gi)].map((m) => m[1]),
        ...[...text.matchAll(/\b(?:hostname|host|domain|server)\s*[:=]\s*["'`]([A-Za-z0-9.-]+)["'`]/gi)].map((m) => m[1]),
        ...[...text.matchAll(/(?:^|["'`=\s(@])(\d{1,3}(?:\.\d{1,3}){3})(?=[:/"'`\s)]|$)/g)].map((m) => m[1]),
      ];
      // 設定ファイル（.env・YAML など）のクオートなしのホスト（SMTP_HOST=smtp.example.co.jp）
      if (!isCode) {
        for (const m of text.matchAll(/\b[A-Za-z0-9_]*(?:HOST|HOSTNAME|DOMAIN|SERVER|ENDPOINT)[A-Za-z0-9_]*\s*[=:]\s*["']?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/gi)) found.push(m[1]);
      }
      for (const raw of found) {
        const host = raw.toLowerCase().replace(/\.$/, "");
        if (!(host.includes(".") || host.startsWith("["))) continue;
        if (/^\d+(?:\.\d+)*$/.test(host) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) continue; // 版番号
        if (!/[a-z]/.test(host.replace(/^\[.*\]$/, "x")) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) continue;
        if (!isKnownHost(host) && !excepted("ESC-02", `host:${host}`) && !hosts.has(host)) hosts.set(host, `${file}:${line}`);
      }
      if (!isCode || external || mask == null) continue;
      // 外部への呼び出し（fetch とその別名・WebSocket・EventSource・XMLHttpRequest・sendBeacon・URL の動的 import）
      for (const m of mask.matchAll(/\bfetch\b/g)) {
        const pre = mask.slice(0, m.index).trimEnd();
        const recv = /([A-Za-z_$][\w$]*)\s*\??\.$/.exec(pre);
        if (recv && !/^(?:globalThis|window|self|global)$/.test(recv[1])) continue; // 別のもののメソッド（router.fetch など）
        if (/^\s*\(\s*["'`]\/(?![/\\])/.test(code.slice(m.index + 5))) continue; // 同じオリジンへの相対パス
        if (/^\s*:/.test(mask.slice(m.index + 5)) && /[{,]\s*$/.test(pre)) continue; // オブジェクトのキー
        calls.push(`${file}:${line}（fetch）`);
        break;
      }
      const other = /\bnew\s+(?:(?:window|globalThis|self)\s*\.\s*)?(?:WebSocket|EventSource|XMLHttpRequest|RTCPeerConnection)\b|\bsendBeacon\s*\(/.exec(mask);
      if (other) calls.push(`${file}:${line}（${other[0].replace(/\s*\($/, "").replace(/\s+/g, " ").trim()}）`);
      if (/\bimport\s*\(\s*["'`]https?:/.test(code)) calls.push(`${file}:${line}（URL の import）`);
      for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)) {
        const spec = m[1];
        if (!isNetPackage(spec)) continue;
        if (file === "src/db/client.ts" && /^pg(?:\/|$)/.test(spec)) continue; // DB の接続（SEC-12 で確認する）
        netImports.push(`${file}:${line}（${spec}）`);
      }
    }
  }
  if (hosts.size) {
    flag("ESC-02", "technical", "新しい外部の接続先が追加されました。接続してよいかを確認し、よければ docs/profile.json の externalHosts に登録してください", [...hosts].map(([h, f]) => `${h}（${f}）`));
  }
  if (calls.length) {
    flag("ESC-02", "technical", "外部への呼び出しが src/server/external/ の外に追加されました（ARCH-07）。接続先・送るデータ・タイムアウトを確認してください", calls);
  }
  if (netImports.length) {
    flag("ESC-02", "technical", "ネットワークや外部コマンドを使うパッケージが src/server/external/ の外で読み込まれました（ARCH-07）。外部連携は src/server/external/ に置いてください", netImports);
  }
  const externalChanged = changed.filter((f) => f.startsWith("src/server/external/") && !isTest(f));
  if (externalChanged.length) {
    flag("ESC-02", "technical", "外部連携のコード（src/server/external/）が変わりました。接続先・送るデータ・タイムアウトを確認してください", externalChanged);
  }

  // SEC-08 個人情報らしき項目（Drizzle のスキーマと、マイグレーション SQL）
  checked.add("SEC-08");
  const cols = new Map();
  for (const file of changed) {
    const isSchema = file.startsWith("src/db/") && CODE_EXT.test(file) && !isTest(file);
    const isSql = /^drizzle\/[^/]+\.sql$/.test(file);
    if (!isSchema && !isSql) continue;
    const added = new Set(addedLines(file).map((a) => a.line));
    if (!added.size) continue;
    const text = newText(file);
    if (text == null) continue;
    const src = new Source(file, text);
    if (isSchema) {
      // pgTable("名前", { … }) の範囲（pgTable( の後で改行する書き方も）
      const tables = [];
      for (const m of src.code.matchAll(/(?:\bpgTable|\.table)\s*\(\s*(["'`])([\w.-]+)\1/g)) {
        const open = src.code.indexOf("(", m.index);
        tables.push({ name: m[2], start: open, end: matching(src.mask, open) });
      }
      for (const m of src.code.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$.]*)\s*(?:<[^>]*>)?\s*\(\s*(?:(["'`])([\w-]+)\3)?/g)) {
        const lineNo = src.line(m.index);
        if (!added.has(lineNo)) continue;
        const table = tables.filter((t) => m.index > t.start && m.index < t.end).pop()?.name ?? null;
        if (!table) continue;
        const type = m[2].split(".").pop();
        const fk = /\.references\s*\(/.test(src.code.slice(m.index, propertyEnd(src.mask, m.index)));
        for (const c of [m[1], m[4]].filter(Boolean)) {
          if (isPii(c, table, type, fk)) cols.set(`${table}.${m[4] ?? m[1]}`, `${file}:${lineNo}`);
        }
      }
      continue;
    }
    // SQL: CREATE TABLE の列と ALTER TABLE … ADD COLUMN
    const { code } = sqlLex(text, { keepIdentifiers: true });
    const ident = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))`;
    for (const m of code.matchAll(new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${ident}\s*\.\s*)?${ident}\s*\(`, "gi"))) {
      const table = m[3] ?? m[4];
      const open = m.index + m[0].length - 1;
      const close = matching(code, open);
      let depth = 0;
      let s = open + 1;
      const defs = [];
      for (let i = open + 1; i <= close; i++) {
        const c = code[i];
        if (c === "(") depth++;
        else if (c === ")" && i !== close) depth--;
        if ((c === "," && depth === 0) || i === close) {
          defs.push([s, i]);
          s = i + 1;
        }
      }
      for (const [a, b] of defs) {
        const def = code.slice(a, b);
        const lead = def.length - def.trimStart().length;
        const cm = new RegExp(String.raw`^${ident}\s+([A-Za-z]+)`).exec(def.trimStart());
        if (!cm) continue;
        const col = cm[1] ?? cm[2];
        if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)$/i.test(col) && !cm[1]) continue;
        const lineNo = src.line(a + lead);
        if (added.has(lineNo) && isPii(col, table, cm[3], /\bREFERENCES\b/i.test(def))) cols.set(`${table}.${col}`, `${file}:${lineNo}`);
      }
    }
    for (const m of code.matchAll(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:${ident}\s*\.\s*)?${ident}([^;]*)`, "gi"))) {
      const table = m[3] ?? m[4];
      const actionsStart = m.index + m[0].length - m[5].length;
      for (const a of m[5].matchAll(new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s+([A-Za-z]+)`, "gi"))) {
        const col = a[1] ?? a[2];
        if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(col) && !a[1]) continue;
        const lineNo = src.line(actionsStart + a.index);
        if (added.has(lineNo) && isPii(col, table, a[3], /\bREFERENCES\b/i.test(m[5]))) cols.set(`${table}.${col}`, `${file}:${lineNo}`);
      }
    }
  }
  if (cols.size) {
    flag("SEC-08", "technical", "個人情報らしき項目が DB に追加されました。閲覧できる人・ログへの出力・保持期間を確認し、docs/profile.json の personalData に記録してください", [...cols].map(([c, f]) => `${c}（${f}）`));
  }

  // ESC-03 権限表の変更（permissions.ts と、それが読み込む案件のファイル）
  checked.add("ESC-03");
  const permDeps = new Set([...importClosure(PERMISSIONS_FILE)]);
  const baseImports = baseText(PERMISSIONS_FILE);
  if (baseImports) {
    const s = new Source(PERMISSIONS_FILE, baseImports);
    for (const imp of s.imports) {
      const target = resolveFile(PERMISSIONS_FILE, imp.spec);
      if (target) permDeps.add(target);
    }
  }
  const permChanged = changed.filter((f) => f === PERMISSIONS_FILE || permDeps.has(f));
  if (permChanged.length) {
    flag("ESC-03", "business", "権限表（誰が何をできるか）が変わりました。業務の観点で確認してください", permChanged);
  }

  // SEC-12 安全の仕組みの中心のファイル（next.config・proxy が読み込むファイル、権限表が読み込むファイル、can() の実装を含む）
  checked.add("SEC-12");
  const coreDeps = new Set(permDeps);
  for (const start of [...NEXT_CONFIGS, "src/proxy.ts", "proxy.ts", "src/middleware.ts", "middleware.ts"]) {
    if (CODE.has(start)) for (const d of importClosure(start)) coreDeps.add(d);
  }
  const core = changed.filter((f) => isCoreFile(f) || coreDeps.has(f));
  if (DIFF.changed.has(PERMISSIONS_FILE)) {
    const before = canImplementation(baseText(PERMISSIONS_FILE));
    const after = canImplementation(newText(PERMISSIONS_FILE));
    if (before !== after) core.push(`${PERMISSIONS_FILE}（can() の実装）`);
  }
  for (const f of changed) {
    if (DIFF.changed.get(f) === "D") continue;
    try {
      if (lstatSync(abs(f)).isSymbolicLink()) core.push(`${f}（シンボリックリンク）`);
    } catch {
      // --head の比較では作業ツリーにないことがある
    }
  }
  if (core.length) {
    flag("SEC-12", "technical", "安全の仕組み（認証・権限・監査・環境変数・ログ・DB 接続・セキュリティヘッダ・import の解決・配布・CI・標準）の中心のファイルが変わりました。差分を確認してください", core);
  }

  // DATA データモデルの変更（どのマイルストーンで技術ゲートを必須にするかはランナーが決める）
  checked.add("DATA");
  const data = changed.filter((f) => /^src\/db\/schema[^/]*\.[cm]?[jt]s$/.test(f) || /^src\/db\/schema\//.test(f) || f.startsWith("drizzle/"));
  if (data.length) {
    flag("DATA", "technical", "データモデル（DB のスキーマ・マイグレーション）が変わりました。テーブル・列・制約を確認してください", data);
  }

  // DEPS 依存の変更（追加・版の変更・上書き・パッチ・インストール時のスクリプト）
  checked.add("DEPS");
  const depItems = [];
  for (const f of changed) {
    if (/(^|\/)package\.json$/.test(f) && !KIT.test(f)) {
      const parse = (t) => {
        try {
          return t == null ? {} : JSON.parse(t);
        } catch {
          return null;
        }
      };
      const before = parse(baseText(f));
      const after = parse(DIFF.changed.get(f) === "D" ? null : newText(f));
      if (!before || !after) {
        depItems.push(`${f}（読めない）`);
        continue;
      }
      for (const field of DEP_FIELDS) {
        for (const [name, spec] of Object.entries(after[field] ?? {})) {
          const old = before[field]?.[name];
          if (old === undefined) depItems.push(`${f}: ${field}.${name} を追加（${spec}）`);
          else if (old !== spec) depItems.push(`${f}: ${field}.${name} の版を変更（${old} → ${spec}）`);
        }
      }
      for (const key of ["pnpm", "overrides", "resolutions", "packageManager", "workspaces"]) {
        if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) depItems.push(`${f}: ${key} を変更`);
      }
    } else if (/^(?:pnpm-workspace\.yaml|\.pnpmfile\.[cm]?js|\.npmrc)$/.test(f)) depItems.push(`${f} を変更`);
  }
  if (depItems.length) {
    flag("DEPS", "technical", "依存（パッケージとその版・上書き・パッチ・インストール時のスクリプト）が変わりました。許可リストと必要性を確認してください", depItems);
  }
}

if (DIFF) {
  if (DIFF.ok) {
    try {
      runFlags();
    } catch (e) {
      diffProblems.push(`変更の検出中にエラー: ${e?.message ?? e}`);
    }
  }
  if (diffProblems.length) {
    flag("SEC-12", "technical", `変更の差分を正しく取得できませんでした（${[...new Set(diffProblems)].join(" / ")}）。安全のため、変更全体を技術ゲートで確認してください`);
  }
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const result = {
  version: RULES.version,
  ok: violations.length === 0,
  release: opt.release,
  checked: [...checked].sort(),
  violations,
  flags,
  warnings,
};

let output;
if (opt.json) {
  output = `${JSON.stringify(result, null, 2)}\n`;
} else {
  const out = [];
  for (const v of violations) out.push(`✗ [${v.rule}] ${v.file ? `${v.file}${v.line ? `:${v.line}` : ""} — ` : ""}${v.message}`);
  for (const f of flags) {
    out.push(`⚑ [${f.rule}] ${f.role === "business" ? "業務" : "技術"}ゲートで確認: ${f.message}${f.items.length ? `\n    ${f.items.join("\n    ")}` : ""}`);
  }
  for (const w of warnings) out.push(`△ [${w.rule}] 注意: ${w.file ? `${w.file} — ` : ""}${w.message}`);
  const autoCount = [...checked].filter((id) => RULE[id]?.check === "auto").length;
  out.push(
    violations.length
      ? `標準 ${RULES.version}: ${violations.length} 件の違反があります（ルールの説明は docs/standard/）`
      : `✓ 標準 ${RULES.version}: 自動検査 ${autoCount} 項目に合格${opt.release ? "（リリース前の検査を含む）" : "（リリース前の検査は --release）"}`,
  );
  output = `${out.join("\n")}\n`;
}
await finish(output, violations.length ? 1 : 0);
