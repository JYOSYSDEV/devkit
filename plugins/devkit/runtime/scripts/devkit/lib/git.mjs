// git の呼び出し。リポジトリ側の設定（フック・fsmonitor・外部 diff など）に結果を左右されないように固定して呼ぶ。
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let NO_HOOKS_DIR = null;

export function noHooksDir(root) {
  if (!NO_HOOKS_DIR) {
    NO_HOOKS_DIR = join(root, ".devkit", "cache", "no-hooks");
    mkdirSync(NO_HOOKS_DIR, { recursive: true });
  }
  return NO_HOOKS_DIR;
}

function baseArgs(root) {
  return [
    "-c",
    "core.quotepath=off",
    "-c",
    "color.ui=never",
    "-c",
    `core.hooksPath=${noHooksDir(root)}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
  ];
}

// root: プロジェクトのルート（no-hooks の置き場所）。cwd: 実行する作業ツリー
export function git(root, args, { cwd = root, input, allowFail = true, env = {} } = {}) {
  const r = spawnSync("git", [...baseArgs(root), ...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
  });
  const res = {
    code: r.status ?? 1,
    out: (r.stdout ?? "").replace(/\s+$/, ""),
    raw: r.stdout ?? "",
    err: (r.stderr ?? "").trim() || r.error?.message || "",
  };
  if (!allowFail && res.code !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${res.err || res.out}`);
  return res;
}

// ランナーのコミット。利用者の git 設定に名前がなければ devkit の名前を使う
export function commitArgs(root, message) {
  const name = git(root, ["config", "user.name"]).out;
  const email = git(root, ["config", "user.email"]).out;
  const id = [];
  if (!name) id.push("-c", "user.name=devkit-runner");
  if (!email) id.push("-c", "user.email=devkit-runner@localhost");
  return [...id, "commit", "--no-verify", "-q", "-m", message];
}

export function headSha(root, cwd = root) {
  return git(root, ["rev-parse", "HEAD"], { cwd }).out;
}

export function isCommit(root, sha) {
  if (!sha || typeof sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  return git(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).code === 0;
}

export function currentBranch(root, cwd = root) {
  return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd }).out;
}

// 追跡しているファイルの未コミットの変更（.devkit/ の中で gitignore されたものは数えない）
export function dirtyFiles(root, cwd = root) {
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  return r.raw
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3));
}

export function changedFiles(root, base, head, { cwd = root } = {}) {
  const r = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", `${base}...${head}`, "--"], {
    cwd,
  });
  if (r.code !== 0) return null;
  return r.raw.split("\0").filter(Boolean);
}

// 追加・削除された行（ファイルごと）。--text で .gitattributes の -diff を無視する
export function diffLines(root, base, head, { cwd = root, paths = [] } = {}) {
  const r = git(
    root,
    ["diff", "--text", "-U0", "--no-color", "--no-ext-diff", "--no-renames", `${base}...${head}`, "--", ...paths],
    { cwd },
  );
  if (r.code !== 0) return null;
  const files = new Map();
  let file = null;
  for (const line of r.raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/\t$/, "");
      file = p === "/dev/null" ? file : p.replace(/^b\//, "");
      if (file && !files.has(file)) files.set(file, { added: [], removed: [] });
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).replace(/\t$/, "");
      if (p !== "/dev/null") {
        file = p.replace(/^a\//, "");
        if (!files.has(file)) files.set(file, { added: [], removed: [] });
      }
      continue;
    }
    if (!file || line.startsWith("@@")) continue;
    if (line.startsWith("+")) files.get(file).added.push(line.slice(1));
    else if (line.startsWith("-")) files.get(file).removed.push(line.slice(1));
  }
  return files;
}

export function showFile(root, sha, path) {
  const r = git(root, ["show", `${sha}:${path}`]);
  return r.code === 0 ? r.raw : null;
}

export function lsTree(root, sha) {
  const r = git(root, ["ls-tree", "-r", "-z", "--name-only", sha]);
  return r.code === 0 ? r.raw.split("\0").filter(Boolean) : null;
}
