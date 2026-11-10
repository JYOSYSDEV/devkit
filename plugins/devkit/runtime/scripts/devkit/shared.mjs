// devkit.mjs・ランナー・フック（.claude/hooks/*.mjs）が共有する定義。依存パッケージなし。
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ノードの owns にできず、並列ワーカーが変更してはいけない共有ファイル。
// 一覧は `pnpm -s devkit shared` で表示できる。文書にはこの一覧を写さず、コマンドを案内する。
export const SHARED_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^\.claude(\/|$)/,
  /^\.devkit(\/|$)/,
  /^\.github(\/|$)/,
  /^compose\.ya?ml$/,
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^biome\.jsonc?$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^next\.config\.[mc]?[jt]s$/,
  /^drizzle\.config\.[mc]?[jt]s$/,
  /^postcss\.config\.[mc]?[jt]s$/,
  /^\.nvmrc$/,
];

export const SHARED_LABELS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "CLAUDE.md",
  "AGENTS.md",
  ".claude/",
  ".devkit/",
  ".github/",
  "compose.yaml",
  "Dockerfile",
  ".dockerignore",
  "biome.json",
  "tsconfig.json",
  "next.config.*",
  "drizzle.config.*",
  "postcss.config.*",
  ".nvmrc",
];

// 作業（ノード）がどの owns を持っていても変更してはいけないパス。
// 仕様・標準・人の判断の記録・devkit 自身と、検証の結果を変えられる設定ファイル。
// ランナーの機械検証（integrity）が、owns とは別にこの一覧で不合格にする。
export const PROTECTED_PATTERNS = [
  /^docs\/spec(\/|$)/,
  /^docs\/standard(\/|$)/,
  /^docs\/devkit(\/|$)/,
  /^docs\/profile\.json$/,
  /^docs\/exceptions\.json$/,
  /^docs\/decisions\.md$/,
  /^scripts\/devkit(\/|$)/,
  /^scripts\/standard(\/|$)/,
  /^vitest\.config\.[mc]?[jt]s$/,
  /^vitest\.workspace\.[mc]?[jt]s$/,
  /^playwright\.config\.[mc]?[jt]s$/,
  /(^|\/)vitest\.setup\.[mc]?[jt]sx?$/,
  /^tests\/setup(\.|\/|$)/,
  /^e2e\/(fixtures|global-setup|global-teardown)(\.|\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pnpmfile\.c?js$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitmodules$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)\.env(?!\.example$)(\.[\w.-]+)?$/,
];

// devkit だけが書き換える状態ファイル。Claude の Edit / Write / Bash からの変更はフックが止める。
// config.json（隔離・サンドボックス・起動する claude の設定）は人が手で変える。
// graph.json・mission.md は kickoff で Claude が作るので対象外（承認の後の変更は計画のハッシュで分かる）。
export const PROTECTED_STATE_FILES = [
  /^\.devkit\/state\.json$/,
  /^\.devkit\/controls\.json$/,
  /^\.devkit\/run\.json$/,
  /^\.devkit\/run\.lock$/,
  /^\.devkit\/version\.json$/,
  /^\.devkit\/evidence(\/|$)/,
  /^\.devkit\/config\.json$/,
  /^\.devkit\/journal\.jsonl$/,
  /^\.devkit\/events\.jsonl$/,
  /^\.devkit\/briefings(\/|$)/,
  /^\.devkit\/decisions(\/|$)/,
  /^\.devkit\/cache\/supervisor(\/|$)/,
  /^\.devkit\/cache\/journal-anchor\.json$/,
  /^docs\/decisions\.md$/,
  /^docs\/exceptions\.json$/,
];

// 人だけが変える状態（計画の承認・ゲートの記録・承認・回答・サイクル上限）を持つファイル
export const CONTROLS_FILE = "controls.json";

// 人の役割。業務 = 業務担当者、技術 = 標準オーナー
export const ROLES = ["business", "technical"];
export const ROLE_LABEL = { business: "業務", technical: "技術" };
export const ROLE_PERSON = { business: "業務担当者", technical: "標準オーナー" };

export function normalizeRole(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["business", "業務", "b"].includes(v)) return "business";
  if (["technical", "技術", "tech", "t"].includes(v)) return "technical";
  return null;
}

// ランナーが起動する AI の役割（DEVKIT_ROLE）。フックはこの値で、役割ごとの制限をかける。
//   implementer: リポジトリの外の担当の作業ディレクトリで実装する（取り込みとコミットはランナーが行う）
//   reviewer / final-reviewer / plan-reviewer / spec-reader: 読み取り専用
//   replanner: 読み取り専用。再計画の案を構造化出力で返す
export const READ_ONLY_ROLES = new Set(["reviewer", "final-reviewer", "plan-reviewer", "spec-reader", "replanner"]);

// 並列ワーカーとして扱うサブエージェントの種類（フック入力の agent_type。プラグインでは devkit: が付く）
export const WORKER_AGENTS = new Set(["implementer", "reviewer", "devkit:implementer", "devkit:reviewer"]);

export function isSharedPath(rel) {
  const norm = rel.replace(/^\.\//, "");
  return SHARED_PATTERNS.some((re) => re.test(norm));
}

export function isProtectedPath(rel) {
  const norm = rel.replace(/^\.\//, "");
  return PROTECTED_PATTERNS.some((re) => re.test(norm));
}

export function isProtectedStateFile(rel) {
  const norm = rel.replace(/^\.\//, "");
  return PROTECTED_STATE_FILES.some((re) => re.test(norm));
}

// テストのファイルか（単体: tests/ と src/ の *.test.*、E2E: e2e/）。*.spec.* も、実行されない置き場所への逃げ道として拾う
export function isTestPath(rel) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /^e2e\//.test(rel) || /^tests\//.test(rel);
}

// start から上にたどって .git を探す。.git がファイルなら git worktree（ワーカー用の隔離作業ツリーなど）。
// 戻り値: { root, linked } または null
export function findRepoRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let linked = false;
      try {
        linked = statSync(dotGit).isFile();
      } catch {}
      return { root: dir, linked };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// プロジェクトの中に置かれた git worktree か（ランナーの .devkit/worktrees/ や Claude Code の .claude/worktrees/）。
// プロジェクトの外に人が作った worktree（../my-app-feature など）はワーカー扱いしない。
export function isNestedWorktree(repo) {
  return Boolean(repo?.linked) && Boolean(findRepoRoot(dirname(repo.root)));
}

// ファイルの絶対パスを、そのファイルが属する作業ツリーのルートからの相対パスにする
export function repoRelative(file) {
  const abs = resolve(file).replaceAll("\\", "/");
  const repo = findRepoRoot(dirname(abs));
  if (!repo) return { rel: abs, repo: null };
  const root = repo.root.replaceAll("\\", "/").replace(/\/+$/, "");
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  return { rel, repo };
}

// テストを弱める変更（追加された指定と、テストケース・expect の減少）。ランナーの機械検証と guard-edits が共用する
export const WEAKEN_PATTERNS = [
  [
    /\b(?:it|test|describe|suite|bench|context)(?:\s*(?:\.\s*\w+|\[\s*["'`]\w+["'`]\s*\]))*\s*(?:\.\s*|\[\s*["'`])(?:skip|only|todo|fixme|fails|fail|skipIf|runIf)\b/g,
    "テストを無効化・限定・反転する指定（skip / only / todo / fixme / fails / skipIf / runIf）",
  ],
  [/\b[xf](?:it|describe|test)\s*\(/g, "テストを無効化・限定する xit / xdescribe / fit / fdescribe"],
  [/(?:const|let|var)\s+[\w$]+\s*=\s*(?:it|test|describe)\s*(?:[;,)]|$)/gm, "テスト関数の別名（別名から skip などを呼べる）"],
  [/@ts-nocheck|biome-ignore-all|eslint-disable(?!-next-line|-line)/g, "ファイル単位で型チェック・lint を外す指定"],
];
export const EXPECT_RE = /\bexpect(?:\s*\.\s*(?:soft|poll))?\s*\(/g;
export const CASE_RE = /\b(?:it|test)\s*(?:\.\s*(?:each|concurrent|sequential)\b[^(]*)?\(/g;

const countOf = (text, re) => (String(text ?? "").match(re) ?? []).length;

// before → after で弱めているか。理由の一覧を返す（なければ空）
export function weakeningOf(before, after) {
  const problems = [];
  for (const [re, what] of WEAKEN_PATTERNS) if (countOf(after, re) > countOf(before, re)) problems.push(`${what}を追加した`);
  const c0 = countOf(before, CASE_RE);
  const c1 = countOf(after, CASE_RE);
  const e0 = countOf(before, EXPECT_RE);
  const e1 = countOf(after, EXPECT_RE);
  if (c1 < c0) problems.push(`テストケースが ${c0} から ${c1} に減った`);
  if (e1 < e0) problems.push(`expect が ${e0} から ${e1} に減った`);
  return problems;
}
