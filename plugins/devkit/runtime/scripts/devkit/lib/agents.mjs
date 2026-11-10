// ランナーから AI（Claude Code の非対話セッション）を起動する。
// 1回の呼び出し = 1つの `claude -p` プロセス。役割ごとにエージェント・使える道具・制限時間・予算を固定する。
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ---- 構造化出力のスキーマ（--json-schema） ----

const REQUEST = {
  type: "object",
  required: ["type", "condition", "what", "why", "options", "recommendation"],
  properties: {
    type: { type: "string", enum: ["business", "technical"] },
    condition: { type: "string", description: "当てはまる止まる条件（ESC-01〜05）" },
    what: { type: "string" },
    why: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
};

export const SCHEMAS = {
  implementer: {
    type: "object",
    required: ["status", "summary", "evidence"],
    properties: {
      status: { type: "string", enum: ["implemented", "blocked", "needs_human"] },
      summary: { type: "string", description: "何をしたか（業務の言葉で2〜4行）" },
      evidence: { type: "string", description: "最後に実行した検証コマンドと結果の要点" },
      needs: { type: "string", description: "owns の外や共有ファイルの変更など、自分ではできないこと" },
      request: REQUEST,
    },
  },
  reviewer: {
    type: "object",
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { type: "string", enum: ["pass", "changes_requested", "impossible"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["severity", "problem"],
          properties: {
            severity: { type: "string", enum: ["critical", "important", "minor"] },
            file: { type: "string" },
            line: { type: "integer" },
            problem: { type: "string" },
            why: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
    },
  },
  replanner: {
    type: "object",
    required: ["kind", "summary"],
    properties: {
      kind: { type: "string", enum: ["replan", "needs_human"] },
      summary: { type: "string", description: "原因の見立てと、何をどう変えるか" },
      nodes: { type: "array", description: "追加・変更するノード（graph.json のノードと同じ形。id が同じものは置き換え）", items: { type: "object" } },
      remove: { type: "array", items: { type: "string" }, description: "計画から外すノードの id" },
      decisions: { type: "array", items: { type: "string" }, description: "人に聞かずに自分で決めたこと（間違っていた場合の影響つき）" },
      request: REQUEST,
    },
  },
};
SCHEMAS["final-reviewer"] = SCHEMAS.reviewer;

// ---- 役割ごとに使える道具 ----

const READ = ["Read", "Glob", "Grep"];
const GIT_READ = ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git rev-parse*)", "Bash(git merge-base*)"];

export const TOOLS = {
  implementer: [
    ...READ,
    "Edit",
    "Write",
    "MultiEdit",
    "TodoWrite",
    "Skill",
    ...GIT_READ,
    "Bash(git add *)",
    "Bash(git commit *)",
    // ファイルの削除（雛形の見本を消すノードなど）。消してよいのは owns の中で、テストは計画の allowTestRemoval にあるものだけ（guard-bash と機械検証が確かめる）
    "Bash(git rm *)",
    "Bash(pnpm verify*)",
    "Bash(pnpm lint*)",
    "Bash(pnpm format*)",
    "Bash(pnpm typecheck*)",
    "Bash(pnpm test*)",
    "Bash(pnpm build*)",
    "Bash(pnpm db:generate*)",
    "Bash(pnpm standard:check*)",
    "Bash(pnpm exec vitest *)",
    "Bash(pnpm exec biome *)",
    "Bash(pnpm exec tsc *)",
    "Bash(pnpm exec playwright *)",
    "Bash(ls *)",
  ],
  reviewer: [...READ, ...GIT_READ, "Skill"],
  "final-reviewer": [...READ, ...GIT_READ, "Skill"],
  replanner: [...READ, ...GIT_READ, "Skill", "Bash(pnpm -s devkit status*)", "Bash(pnpm -s devkit check*)"],
};

const DISALLOW_WRITE = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// 環境の問題（作業の失敗ではない）を示す文言。claude 自身の出力（標準エラーと、is_error の結果）だけで照合し、
// AI が書いた最終の文章では照合しない（利用上限の機能を作る作業で「quota」と書くことがあるため）
export const ENV_ERROR = [
  /has not been trusted/i,
  /not logged in|please run \/login|\/login to/i,
  /invalid api key|authentication[_ ]error|401 unauthorized|oauth token (has )?expired/i,
  /credit balance is too low|usage limit reached|rate limit reached|exceeded your (current )?quota|overloaded_error/i,
  /hooks? (are|is) disabled/i,
  /sandbox is required|sandbox (is )?(not available|unavailable)|bubblewrap|bwrap: /i,
  /agent ['"`]?[\w:-]+['"`]? (was )?not found|unknown agent/i,
];

// 環境の問題か: 結果が出なかった、または claude 自身がエラーで終わり（is_error）、その中身が環境の問題を示す
export function classifyEnvError({ result, stderr, timedOut, spawnError = null }) {
  if (timedOut) return null;
  if (spawnError) return `claude を起動できない: ${spawnError}`;
  if (result === null) return withHelp(firstLine(stderr) || "claude が結果を返さずに終了した", stderr);
  if (!result.is_error) return null;
  const errText = `${stderr ?? ""}\n${result.result ?? ""}`;
  if (ENV_ERROR.some((re) => re.test(errText)) || (result.num_turns ?? 0) === 0) return withHelp(firstLine(errText) || "claude が作業を開始できなかった", errText);
  return null;
}

const AGENT_NOT_FOUND = /agent ['"`]?[\w:-]+['"`]? (was )?not found|unknown agent/i;
export const AGENT_HELP =
  "ランナーは、リポジトリの外の作業ディレクトリで、利用者の設定だけを読んで AI を起動します（プロジェクトの .claude/settings.json は読まない）。" +
  "devkit プラグインを利用者の設定で有効にする（Claude Code で /plugin → devkit を user の範囲で有効にする）か、" +
  '人が .devkit/config.json に {"pluginDir":"<devkit プラグインのフォルダの絶対パス>"} を書いてコミットします';

// 担当（エージェント）が見つからないときは、直し方を添える
function withHelp(line, text) {
  return AGENT_NOT_FOUND.test(String(text ?? "")) ? `${line}（${AGENT_HELP}）` : line;
}

function firstLine(text) {
  return (String(text ?? "").trim().split("\n").find((l) => l.trim()) ?? "").slice(0, 300);
}

// ランナーが起動する AI に渡す設定（--settings）。ガードは本体のリポジトリのもの（作業ディレクトリの写しではない）を使い、
// サンドボックスを有効にする。プロジェクトの設定ファイル（作業ディレクトリの写し）は読まない（--setting-sources）。
// 実装担当の Edit・Write には Bash のサンドボックスが効かない。書き込み先はガード（guard-edits: 作業ディレクトリの中だけ）が止め、
// 権限のルールでも、本体のリポジトリと、Claude Code・シェル・git・SSH の設定には書かせない
export function implementerWriteDeny(ctx) {
  const deny = ["Edit(~/.claude/**)", "Edit(~/.ssh/**)", "Edit(~/.gitconfig)", "Edit(~/.config/git/**)", "Edit(~/.bashrc)", "Edit(~/.bash_profile)", "Edit(~/.zshrc)", "Edit(~/.zprofile)", "Edit(~/.profile)"];
  if (ctx.root.startsWith("/")) deny.unshift(`Edit(/${ctx.root.replace(/\/+$/, "")}/**)`);
  return deny;
}

export function runnerSettings({ ctx, config, role }) {
  const hook = (file) => ({ type: "command", command: "node", args: [join(ctx.root, ".claude", "hooks", file)], timeout: 15 });
  const settings = {
    permissions: {
      deny: [
        "Read(./.env)",
        "Read(./.env.local)",
        "Read(./.env.*.local)",
        "Read(./.env.development*)",
        "Read(./.env.production*)",
        "Read(./.env.staging*)",
        "Read(./.env.test*)",
        "WebFetch",
        "WebSearch",
        ...(role === "implementer" ? implementerWriteDeny(ctx) : []),
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [hook("guard-bash.mjs")] },
        { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [hook("guard-edits.mjs")] },
        { matcher: "Read|Grep|Glob", hooks: [hook("guard-read.mjs")] },
      ],
      ...(role === "implementer" ? { PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ ...hook("format-file.mjs"), timeout: 30 }] }] } : {}),
    },
  };
  if (config.aiSandbox === "required") {
    settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      // 本体のリポジトリには書かせない（サンドボックスが書き込みを許す一時ディレクトリの下に案件がある場合も）
      filesystem: {
        denyWrite: [ctx.root],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.docker", "~/.netrc", "~/.npmrc", "~/.git-credentials", "~/.claude/.credentials.json"],
      },
      network: { allowedDomains: [], strictAllowlist: true },
    };
  }
  return settings;
}

// ---- 担当（エージェント）の定義の場所 ----
// ランナーは作業ディレクトリ（リポジトリの外）で、--setting-sources user（既定）で claude を起動する。
// devkit プラグインがプロジェクトの設定でだけ有効だと、devkit:implementer などが見つからない。そこで、
//   1) .devkit/config.json の pluginDir（相対パスは案件のルートから）
//   2) 利用者の設定（~/.claude/settings.json の enabledPlugins）で devkit が有効 → そのまま
//   3) インストール済みの devkit プラグイン（~/.claude/plugins/installed_plugins.json）の場所 → --plugin-dir で渡す
// の順に決める。戻り値: { ok, pluginDir, how, problem }
const AGENT_ROLES = ["implementer", "reviewer", "final-reviewer", "replanner"];
let AGENTS_CACHE = new Map();

export function resetAgentsCache() {
  AGENTS_CACHE = new Map();
}

function claudeHome() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  return d && isAbsolute(d) ? d : join(homedir(), ".claude");
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function hasAgents(dir) {
  return AGENT_ROLES.every((r) => existsSync(join(dir, "agents", `${r}.md`)));
}

// インストール済みの devkit プラグインの場所（この案件に入れたものを先に、次に版の新しい順）
function installedPluginDir(ctx) {
  const doc = readJsonSafe(join(claudeHome(), "plugins", "installed_plugins.json"));
  const plugins = doc?.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const entries = [];
  for (const [key, list] of Object.entries(plugins)) {
    if (!/^devkit@/.test(key)) continue;
    for (const e of Array.isArray(list) ? list : [list]) if (e && typeof e.installPath === "string" && isAbsolute(e.installPath)) entries.push(e);
  }
  const root = ctx?.root ? resolve(ctx.root) : null;
  const rank = (e) => (root && e.projectPath && resolve(String(e.projectPath)) === root ? 0 : 1);
  entries.sort((a, b) => rank(a) - rank(b) || String(b.version ?? "").localeCompare(String(a.version ?? ""), "en", { numeric: true }));
  return entries.map((e) => e.installPath).find(hasAgents) ?? null;
}

export function resolveAgents(ctx, config) {
  const key = JSON.stringify([ctx?.root ?? "", config.pluginDir ?? null, config.agentPrefix ?? null, config.settingSources ?? null, claudeHome()]);
  if (AGENTS_CACHE.has(key)) return AGENTS_CACHE.get(key);
  const res = (() => {
    if (config.pluginDir) {
      const dir = resolve(ctx?.root ?? process.cwd(), String(config.pluginDir));
      if (!hasAgents(dir)) return { ok: false, pluginDir: dir, how: "config", problem: `.devkit/config.json の pluginDir（${dir}）に devkit の担当の定義（agents/implementer.md など）がありません。devkit プラグインのフォルダ（.claude-plugin/ と agents/ がある場所）を指定してください` };
      return { ok: true, pluginDir: dir, how: "config" };
    }
    // 担当の名前を変えている案件（agentPrefix）は、どこに定義があるかをここでは確かめられない
    if ((config.agentPrefix ?? "devkit:") !== "devkit:") return { ok: true, pluginDir: null, how: "custom" };
    const sources = String(config.settingSources ?? "user").split(",").map((x) => x.trim());
    // 作業ディレクトリは案件の clone なので、project を読む設定なら、案件の .claude/settings.json が効く
    // 管理者の設定（managed settings）は、--setting-sources に関係なく効く
    const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode\\managed-settings.json" : "/etc/claude-code/managed-settings.json";
    const files = [managed, sources.includes("user") ? join(claudeHome(), "settings.json") : null, sources.includes("project") && ctx?.root ? join(ctx.root, ".claude", "settings.json") : null].filter(Boolean);
    // extraArgs でプラグインを渡している案件は、そのまま使う
    if ((config.extraArgs ?? []).some((a) => /^--plugin-(dir|url)(=|$)/.test(String(a)))) return { ok: true, pluginDir: null, how: "extraArgs" };
    const enabled = files.some((f) => Object.entries(readJsonSafe(f)?.enabledPlugins ?? {}).some(([k, v]) => /^devkit@/.test(k) && v && !(Array.isArray(v) && !v.length)));
    if (enabled) return { ok: true, pluginDir: null, how: "settings" };
    const dir = installedPluginDir(ctx);
    if (dir) return { ok: true, pluginDir: dir, how: "installed" };
    return { ok: false, pluginDir: null, how: "none", problem: `ランナーが起動する AI から、devkit の担当（${agentName(config, "implementer")} など）が見つかりません。${AGENT_HELP}` };
  })();
  AGENTS_CACHE.set(key, res);
  return res;
}

export function agentsProblem(ctx, config) {
  return resolveAgents(ctx, config).problem ?? null;
}

export function agentName(config, role) {
  const base = role === "final-reviewer" ? "final-reviewer" : role;
  return `${config.agentPrefix ?? "devkit:"}${base}`;
}

// claude -p を起動して、構造化出力を返す
export function runAgent({ ctx, config, role, cwd, prompt, logFile, timeoutMs, budgetUsd = null, env = {}, onEvent = () => {} }) {
  const schema = SCHEMAS[role];
  const args = [
    "-p",
    prompt,
    "--agent",
    agentName(config, role),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    config.permissionMode === "auto" ? "auto" : "dontAsk",
    "--allowedTools",
    ...TOOLS[role],
  ];
  if (role !== "implementer") args.push("--disallowedTools", ...DISALLOW_WRITE);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (budgetUsd) args.push("--max-budget-usd", String(budgetUsd));
  if (config.models?.[role]) args.push("--model", config.models[role]);
  const pluginDir = resolveAgents(ctx, config).pluginDir;
  if (pluginDir) args.push("--plugin-dir", pluginDir);
  if (ctx) args.push("--settings", JSON.stringify(runnerSettings({ ctx, config, role })));
  args.push("--setting-sources", config.settingSources ?? "user");
  args.push(...(config.extraArgs ?? []));

  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: "w" });
  return new Promise((resolvePromise) => {
    const child = spawn(config.claudeBin, args, {
      cwd,
      env: {
        ...process.env,
        DEVKIT_RUNNER: "1",
        DEVKIT_ROLE: role,
        // ガードが「書いてよい場所」として使う（実装担当は、この作業ディレクトリの中だけを Edit・Write・Bash で書ける）
        DEVKIT_WORKDIR: cwd,
        // claude -p はターンの後もバックグラウンドの作業を待つ。既定の 10 分で打ち切られないように、制限時間に合わせる
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(timeoutMs),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(config.claudeBin),
      detached: process.platform !== "win32",
    });
    let buf = "";
    let result = null;
    let stderr = "";
    let timedOut = false;
    let lastText = "";
    let done = false;
    // 時間切れ: プロセスグループごと SIGINT → SIGTERM → SIGKILL。出力が閉じなくても戻る
    const kill = (sig) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGINT");
      setTimeout(() => kill("SIGTERM"), 20_000).unref();
      setTimeout(() => kill("SIGKILL"), 30_000).unref();
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(124);
      }, 40_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "result") result = ev;
        if (ev.type === "assistant") {
          for (const c of ev.message?.content ?? []) if (c.type === "text") lastText = c.text;
        }
        onEvent(ev);
      }
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      log.write(`{"type":"stderr","text":${JSON.stringify(c.toString())}}\n`);
    });
    function finish(code, error = null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log.end();
      const turns = result?.num_turns ?? 0;
      const envReason = classifyEnvError({ result, stderr, timedOut, spawnError: error });
      resolvePromise({
        code,
        timedOut,
        envError: Boolean(envReason),
        envReason,
        turns,
        costUsd: result?.total_cost_usd ?? 0,
        subtype: result?.subtype ?? null,
        isError: Boolean(result?.is_error),
        output: result?.is_error ? null : extractStructured(result, lastText),
        text: result?.result ?? lastText,
      });
    }
    child.on("error", (e) => finish(127, e.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function extractStructured(result, lastText) {
  if (result?.structured_output && typeof result.structured_output === "object") return result.structured_output;
  for (const t of [result?.result, lastText]) {
    if (typeof t !== "string") continue;
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    for (const cand of [fenced?.[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
      if (!cand) continue;
      try {
        const v = JSON.parse(cand);
        if (v && typeof v === "object") return v;
      } catch {}
    }
  }
  return null;
}

// ---- 指示文（エージェントの定義に手順があり、ここでは今回の作業の中身だけを渡す） ----

export function implementerPrompt({ g, node, round, base, branch, feedback, note, resume, learnings }) {
  return [
    `devkit のノード ${node.id}「${node.title}」を実装してください（試行 ${round.attempt}、ラウンド ${round.round}/${g.limits.maxRounds}）。`,
    "",
    `- 作業ディレクトリ: ここ（ランナーがリポジトリの外に用意した、この作業だけの clone。ブランチ ${branch}、起点 ${base.slice(0, 10)}）`,
    "- この作業ディレクトリの外には書き込めません（Edit・Write はガードが、Bash はサンドボックスが止めます。リンクを通した書き込み・.git の中も不可。ネットワークも使えません）。",
    `- 仕様書: ${node.spec || g.spec}`,
    `- このノードの受入基準・業務ルール: ${node.acceptance.join(", ") || "（なし）"}`,
    `- 変更してよいパス（owns）: ${node.owns.join(", ")}`,
    node.allowTestRemoval?.length ? `- 削除してよいテストファイル（allowTestRemoval）: ${node.allowTestRemoval.join(", ")}` : "",
    "- ファイルを削除するときは \`git rm <パス>\`（フォルダごとなら \`git rm -r <パス>\`）を使います。rm・mv は使えません。テストのファイルは、上の「削除してよいテストファイル」にあるものだけ削除できます（中身を空にするのではなく、ファイルごと削除する）。",
    resume ? "- 前回の試行が中断した続きです。git log と git status で、どこまで進んでいたかを確かめてから始めてください。" : "",
    "",
    "goal（これを満たして終える）:",
    node.goal,
    note ? `\n人・再計画からの前提（必ず従う）:\n${note}` : "",
    feedback ? `\n前のラウンドの検証・レビューで出た指摘（確かめてから直す）:\n${feedback}` : "",
    learnings ? `\nこのプロジェクトで学んだこと（.devkit/learnings.md）:\n${learnings}` : "",
    "",
    "変更はコミットしなくてかまいません（ランナーがこのディレクトリのファイルをそのまま取り込みます）。終わったら構造化出力で報告してください。",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function reviewerPrompt({ g, node, base, tip, integrity, implSummary, testSummary = "" }) {
  return [
    `devkit のノード ${node.id}「${node.title}」の差分を、実装者とは独立にレビューしてください。`,
    "",
    `- この作業ディレクトリは、レビュー対象のコミット ${tip.slice(0, 10)} をランナーがクリーンに取り出したものです（読み取り専用）`,
    `- 差分の範囲: git diff ${base.slice(0, 10)}...${tip.slice(0, 10)}`,
    `- 仕様書: ${node.spec || g.spec}`,
    `- このノードの受入基準・業務ルール: ${node.acceptance.join(", ") || "（なし）"}`,
    `- 変更してよいパス（owns）: ${node.owns.join(", ")}`,
    "",
    "goal:",
    node.goal,
    "",
    "ランナーの機械検証の結果（合格済み。検証はコンテナの中で行い、このディレクトリにはテストの結果を置いていない）:",
    integrity,
    testSummary ? `\n実行されたテスト（抜粋）:\n${testSummary}` : "",
    "",
    `実装者の報告（参考。信用せず差分で確かめる）: ${implSummary || "（なし）"}`,
  ].join("\n");
}

export function finalReviewerPrompt({ g, base, head, minors }) {
  return [
    "devkit のミッション全体の最終レビューをしてください。",
    "",
    `- この作業ディレクトリは統合ブランチの ${head.slice(0, 10)} をクリーンに取り出したものです（読み取り専用）`,
    `- 差分の範囲: git diff ${base.slice(0, 10)}...${head.slice(0, 10)}`,
    `- 仕様書: ${g.spec}`,
    `- ミッション: ${g.mission}`,
    minors ? `\nノードごとのレビューで積み残した Minor の指摘:\n${minors}` : "",
  ].join("\n");
}

export function replannerPrompt({ g, items, failures }) {
  return [
    "devkit の計画で、止まった作業があります。原因を確かめ、承認済みの範囲で直せる計画の変更を提案してください。",
    "",
    "止まったもの:",
    ...items.map((x) => `- ${x.scope === "node" ? "ノード" : "マイルストーン"} ${x.id}: ${x.reason}`),
    "",
    "直近の失敗の詳細:",
    failures,
    "",
    "この作業ディレクトリは、統合ブランチの今のコミットを取り出したものです（読み取り専用）。",
    "計画は .devkit/graph.json、状態は `pnpm -s devkit status --json`（または .devkit/state.json）、仕様書は " + g.spec + " です。",
    "受入基準の集合・マイルストーン・制限・依存パッケージは変えられません（変える必要があれば kind: needs_human）。",
    "提案したノードは、ランナーが検査（pnpm devkit check と同じ）と分類を行ってから計画に入れます。",
  ].join("\n");
}
