// 小さな共通部品（依存パッケージなし）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DevkitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function fail(message, code = 1) {
  throw new DevkitError(message, code);
}

export function nowIso() {
  return new Date().toISOString();
}

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function localTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${path} を JSON として読めません: ${e.message}`);
  }
}

// 書き込みは一時ファイル経由で置き換える（途中で落ちても壊れた JSON を残さない）
export function writeJson(path, data) {
  writeText(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Biome の整形（幅 120・字下げ 2）に合う JSON の文字列。docs/ の下に devkit が書くファイル（docs/exceptions.json）に使う。
// 値だけの配列は、幅に収まれば1行（"rules": ["TECH-01", "TECH-02"]）。中身のあるオブジェクトは必ず開く
export function biomeJson(value, { width = 120 } = {}) {
  const fmt = (v, depth, prefix) => {
    const pad = "  ".repeat(depth);
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => x === null || typeof x !== "object")) {
        const one = `[${v.map((x) => JSON.stringify(x) ?? "null").join(", ")}]`;
        if (pad.length + prefix + one.length + 1 <= width) return one;
      }
      return `[\n${v.map((x) => `${pad}  ${fmt(x === undefined ? null : x, depth + 1, 0)}`).join(",\n")}\n${pad}]`;
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${fmt(v[k], depth + 1, JSON.stringify(k).length + 2)}`).join(",\n")}\n${pad}}`;
  };
  return `${fmt(value, 0, 0)}\n`;
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readText(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

// 引数の解析: 位置引数と --name value / --flag
export function parseArgs(argv, { booleans = [] } = {}) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (booleans.includes(name) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) opts[name] = true;
      else opts[name] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function tail(text, lines = 60) {
  const arr = String(text ?? "").split(/\r?\n/);
  return arr.slice(-lines).join("\n");
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// glob をパスの正規表現にする。** / * / ? / {a,b} を解釈する。
// `[id]` `[...slug]` などは Next.js の動的セグメント（フォルダ名そのもの）として文字どおりに扱う。
export function globToRegExp(glob) {
  const g = glob.replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      re += `(?:${g
        .slice(i + 1, end)
        .split(",")
        .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // ディレクトリそのもの（末尾 / や glob なし）を書いた場合は、その下全体を含める
  const dirLike = g.endsWith("/") || !/[*?{]/.test(g);
  return new RegExp(`^${re}${dirLike ? "(?:/.*)?" : ""}$`.replace("/(?:/.*)?$", "(?:/.*)?$"));
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

// glob の固定部分（並列にしてよいかの判定に使う）
export function staticPrefix(glob) {
  const cut = glob.search(/[*?{]/);
  const p = (cut === -1 ? glob : glob.slice(0, cut)).replace(/^\.\//, "");
  if (cut === -1) return p;
  const slash = p.lastIndexOf("/");
  return slash === -1 ? "" : p.slice(0, slash + 1);
}

function under(a, b) {
  if (b === "" || a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

export function ownsOverlap(a, b) {
  for (const x of a) {
    for (const y of b) {
      const px = staticPrefix(x);
      const py = staticPrefix(y);
      if (under(px, py) || under(py, px)) return [x, y];
    }
  }
  return null;
}
