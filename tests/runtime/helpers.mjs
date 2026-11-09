// テスト用の小さな案件を一時ディレクトリに作る。実行部品（scripts/devkit）は本物、claude・検証・標準チェッカーは偽物。
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RUNTIME = join(here, "..", "..", "plugins", "devkit", "runtime");
const FIX = join(here, "fixtures");

export function sh(cwd, cmd, args, env = {}) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

export function git(cwd, ...args) {
  return sh(cwd, "git", args).trim();
}

const SPEC = `# テスト用の仕様書

## 7. 受け入れ基準

- **AC-1** 基盤の関数が値を返す
- **AC-2** 機能 B が動く
- **AC-3** 機能 C が動く
`;

const GOAL = (ac) =>
  `${ac} が実装され、以下をすべて満たす: (1) \`pnpm verify\` が exit 0。(2) テスト名に ${ac} を含むテストが pass する。既存テストの削除・skip・期待値の緩和はしない。owns 外のファイルは変更しない。または 20 ターンで停止。`;

export function graphFor(overrides = {}) {
  return {
    version: 2,
    mission: "テスト用のミッション",
    spec: "docs/spec/app.md",
    branch: "devkit/app",
    verify: "node tools/fake-verify.mjs",
    verifyFull: "node tools/fake-verify.mjs --full",
    dependencies: { prod: [], dev: [] },
    limits: { maxParallel: 2, maxRounds: 2, maxAttempts: 2, maxReplans: 2, maxCycles: 20, taskTimeoutMinutes: 5, verifyTimeoutMinutes: 2 },
    milestones: [
      { id: "M1", title: "基盤", approvers: ["technical"], foundation: true },
      { id: "M2", title: "機能と受入", approvers: ["business", "technical"], release: true },
    ],
    nodes: [
      { id: "N1", milestone: "M1", title: "基盤", deps: [], owns: ["src/a/**", "tests/a.test.js"], acceptance: ["AC-1"], goal: GOAL("AC-1") },
      { id: "N2", milestone: "M2", title: "機能B", deps: ["N1"], owns: ["src/b/**", "tests/b.test.js"], acceptance: ["AC-2"], goal: GOAL("AC-2") },
      { id: "N3", milestone: "M2", title: "機能C", deps: ["N1"], owns: ["src/c/**", "tests/c.test.js"], acceptance: ["AC-3"], goal: GOAL("AC-3") },
    ],
    ...overrides,
  };
}

// 実装者が書くファイル（そのノードの AC のテストを含む）
export function implFiles(id, ac, extra = {}) {
  const dir = { N1: "a", N2: "b", N3: "c" }[id] ?? id.toLowerCase();
  return {
    [`src/${dir}/index.js`]: `export const ${dir} = 1;\n`,
    [`tests/${dir}.test.js`]: `test("${ac}: ${id} の振る舞い", () => { expect(1).toBe(1) })\n`,
    ...extra,
  };
}

export function defaultScenario() {
  return {
    "implementer:N1": [{ files: implFiles("N1", "AC-1") }],
    "implementer:N2": [{ files: implFiles("N2", "AC-2") }],
    "implementer:N3": [{ files: implFiles("N3", "AC-3") }],
  };
}

export const FAKE_DOCKER = join(FIX, "fake-docker.mjs");

export function makeProject({ graph = graphFor(), scenario = defaultScenario(), runbookFilled = true, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "devkit-test-"));
  cpSync(join(RUNTIME, "scripts", "devkit"), join(dir, "scripts", "devkit"), { recursive: true });
  mkdirSync(join(dir, "scripts", "standard"), { recursive: true });
  cpSync(join(FIX, "fake-checker.mjs"), join(dir, "scripts", "standard", "check.mjs"));
  mkdirSync(join(dir, "tools"), { recursive: true });
  cpSync(join(FIX, "fake-verify.mjs"), join(dir, "tools", "fake-verify.mjs"));
  mkdirSync(join(dir, "docs", "spec"), { recursive: true });
  writeFileSync(join(dir, "docs", "spec", "app.md"), SPEC);
  writeFileSync(
    join(dir, "docs", "profile.json"),
    JSON.stringify({ project: "test", owners: { business: [{ name: "Alice", email: "alice@example.com" }], technical: [{ name: "Tom", email: "tom@example.com" }] }, tier: "lite", users: "", personalData: { stored: false, items: [] }, auth: "dev", externalHosts: [], released: false, releasedMigration: "" }, null, 2),
  );
  writeFileSync(join(dir, "docs", "decisions.md"), "# 判断の記録\n\n| 日時 | 役割 | 判断者 | 対象 | 判断 | 対象のコミット | 内容 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
  writeFileSync(join(dir, "docs", "runbook.md"), runbookFilled ? "# 運用\n\n## 1. 起動と停止\n\nnode server.js\n" : "# 運用\n\n## 1. 起動と停止\n\n（記入）\n");
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "base.test.js"), 'test("既存のテスト", () => { expect(1).toBe(1) })\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }, null, 2));
  writeFileSync(
    join(dir, ".gitignore"),
    ["node_modules/", "test-reports/", ".devkit/worktrees/", ".devkit/run.json", ".devkit/run.lock", ".devkit/logs/", ".devkit/cache/", ".devkit/gates/", ".devkit/status.html", ".devkit/controls.json.lock", ""].join("\n"),
  );
  mkdirSync(join(dir, ".devkit"), { recursive: true });
  writeFileSync(join(dir, ".devkit", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
  writeFileSync(join(dir, ".devkit", "mission.md"), "# ミッション\n\nテスト\n");
  writeFileSync(join(dir, ".devkit", "learnings.md"), "# 学んだこと\n\n- （まだありません）\n");
  const scenarioFile = join(dir, "..", `${dir.split(/[\\/]/).pop()}-scenario.json`);
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(
    join(dir, ".devkit", "config.json"),
    JSON.stringify(
      {
        claudeBin: join(FIX, "fake-claude.mjs"),
        agentPrefix: "",
        installCommand: "node -e 0",
        permissionMode: "dontAsk",
        aiSandbox: "off",
        workDir: `${dir}-work`,
        isolation: { mode: "container", engine: FAKE_DOCKER, image: "fake/verify:1", cacheDir: `${dir}-cache` },
        ...config,
      },
      null,
      2,
    ),
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Tom");
  git(dir, "config", "user.email", "tom@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "switch", "-q", "-c", graph.branch);
  return { dir, scenarioFile };
}

export function devkit(dir, args, { scenarioFile, human = false, env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(dir, "scripts", "devkit", "devkit.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...cleanEnv(),
      DEVKIT_FAKE_SCENARIO: scenarioFile ?? "",
      FAKE_DOCKER_LOG: scenarioFile ? `${scenarioFile}.docker.log` : "",
      ...(human ? { DEVKIT_HUMAN_TTYLESS: "1", DEVKIT_HUMAN_TEST: "1" } : {}),
      ...env,
    },
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// テストを Claude Code の中から実行しても、偽の人のコマンドが動くように、Claude Code と devkit の環境変数を外す
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_") && k !== "CLAUDE_PROJECT_DIR" && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_AGENT_SDK_VERSION"));
}

export function dockerLog(scenarioFile) {
  try {
    return readFileSync(`${scenarioFile}.docker.log`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function as(dir, who) {
  const emails = { alice: ["Alice", "alice@example.com"], tom: ["Tom", "tom@example.com"], eve: ["Eve", "eve@example.com"] };
  git(dir, "config", "user.name", emails[who][0]);
  git(dir, "config", "user.email", emails[who][1]);
}

export function state(dir) {
  return JSON.parse(readFileSync(join(dir, ".devkit", "state.json"), "utf8"));
}

export function approvePlan(dir, scenarioFile) {
  as(dir, "alice");
  const a = devkit(dir, ["approve", "plan", "--role", "業務"], { scenarioFile, human: true });
  as(dir, "tom");
  const b = devkit(dir, ["approve", "plan", "--role", "技術"], { scenarioFile, human: true });
  return [a, b];
}

export function calls(scenarioFile) {
  try {
    return readFileSync(`${scenarioFile}.calls.log`, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}
