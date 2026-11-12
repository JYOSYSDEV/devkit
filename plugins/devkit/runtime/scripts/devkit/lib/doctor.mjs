// 起動前の検査（pnpm devkit doctor）。ランナーの起動時の検査は、止まる理由を1つずつしか示さない。
// ここでは、ランナーが最初の作業を始めるまでに人の手続きで止まりうることを、止めずにまとめて確かめる。
// 何も書き換えない（読むだけ。コンテナのエンジンと、あれば案件の Biome を実行する）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { agentName, resolveAgents } from "./agents.mjs";
import { currentBranch, dirtyFiles } from "./git.mjs";
import { engineInfo, engineName, engineProblem, isolationConfig } from "./isolation.mjs";
import { configProblems, loadControls, loadGraph, loadState, planApproved, validate } from "./model.mjs";
import { sandboxProblem } from "./sandbox.mjs";
import { committedUnexplained, journalProblem, uncommittedUnexplained } from "./seal.mjs";
import { matchesAny, readJson, tail } from "./util.mjs";

// 人が手で書くファイル。docs/ の2つは Biome の対象で、整形の違い（末尾の改行など）でも pnpm verify が落ちる
export const HUMAN_EDITED = [
  { rel: "docs/exceptions.json", biome: true },
  { rel: "docs/profile.json", biome: true },
  { rel: ".devkit/config.json", biome: false },
];

const SEAL_ACCEPT = 'pnpm devkit seal accept --role 技術 --note "<確かめたこと>"';

// 人が手で書くファイルの形（JSON として読めるか・改行）と、あれば案件の Biome での検査
export function humanFileProblems(ctx) {
  const problems = [];
  const forBiome = [];
  // 整形の検査は、案件が Biome を使っているときだけ（既存のシステムに入れた案件などは、形を決めつけない）
  const usesBiome = ["biome.json", "biome.jsonc"].some((f) => existsSync(join(ctx.root, f)));
  for (const { rel, biome } of HUMAN_EDITED) {
    const p = join(ctx.root, rel);
    if (!existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch (e) {
      problems.push(`${rel}: 読めません（${e.message}）`);
      continue;
    }
    try {
      JSON.parse(text);
    } catch (e) {
      problems.push(`${rel}: JSON として読めません（${e.message}）`);
      continue;
    }
    if (!biome || !usesBiome) continue;
    if (text.includes("\r")) problems.push(`${rel}: 改行が CRLF です（LF にする）`);
    else if (!text.endsWith("\n")) problems.push(`${rel}: 末尾に改行がありません（pnpm verify の整形の検査で落ちる）`);
    else if (/\n\n$/.test(text) || /^\s*\n/.test(text)) problems.push(`${rel}: 先頭か末尾に余分な空行があります（pnpm verify の整形の検査で落ちる）`);
    else forBiome.push(rel);
  }
  const bin = join(ctx.root, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
  if (forBiome.length && existsSync(bin)) {
    const r = spawnSync(bin, ["check", "--no-errors-on-unmatched", "--colors=off", ...forBiome], { cwd: ctx.root, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
    if (r.status !== 0 && !r.error) problems.push(`${forBiome.join("・")}: Biome の検査（lint・整形）に通りません。\`pnpm exec biome check --write ${forBiome.join(" ")}\` で直せます\n${tail(`${r.stdout}\n${r.stderr}`.trim(), 12)}`);
  }
  return problems;
}

// 実行ファイルがあるか（実行はしない）
function onPath(bin) {
  const b = String(bin ?? "");
  if (!b) return false;
  if (/[\\/]/.test(b)) return existsSync(b);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return String(process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((d) => exts.some((x) => existsSync(join(d, `${b}${x}`))));
}

// 検査の結果: [{ id, level: ok | problem | warn | info, title, detail, fix }]
export function diagnose(ctx, config) {
  const items = [];
  const add = (id, level, title, detail = "", fix = "") => items.push({ id, level, title, detail, fix });
  const guard = (id, title, fn) => {
    try {
      fn();
    } catch (e) {
      add(id, "warn", title, `確かめられませんでした: ${e.message}`);
    }
  };

  // 1) 設定
  const cp = configProblems(config);
  if (cp.length) add("config", "problem", "設定（.devkit/config.json）", cp.join("\n"), "人が .devkit/config.json を直してコミットする");
  else add("config", "ok", "設定（.devkit/config.json）", existsSync(ctx.config) ? "" : "ファイルなし（既定の設定で動く）");

  // 2) 検証用のコンテナ
  guard("engine", "検証用のコンテナ", () => {
    if (cp.some((x) => x.startsWith("isolation."))) return;
    const iso = isolationConfig(config);
    if (iso.mode !== "container") return add("engine", "warn", "検証用のコンテナ", "isolation.mode が none（隔離なしで検証する）");
    const ep = engineProblem(config);
    if (ep) return add("engine", "problem", "検証用のコンテナ", ep);
    const info = engineInfo(iso);
    add("engine", "ok", "検証用のコンテナ", `${engineName(iso)} ${info.version}${info.rootless ? "（rootless）" : ""}${iso.engineAuto ? "（自動で選んだ）" : ""}`);
  });

  // 3) AI のサンドボックス
  guard("sandbox", "AI のサンドボックス", () => {
    const sb = sandboxProblem(config);
    if (sb) add("sandbox", "problem", "AI のサンドボックス", sb);
    else add("sandbox", config.aiSandbox === "required" ? "ok" : "warn", "AI のサンドボックス", config.aiSandbox === "required" ? "" : "aiSandbox が off（AI のコマンドが作業ディレクトリの外にも書ける）");
  });

  // 4) claude と、ランナーが起動する AI の担当
  guard("agents", "AI の担当（エージェント）", () => {
    if (!onPath(config.claudeBin)) return add("agents", "problem", "AI の担当（エージェント）", `claude（${config.claudeBin}）が見つかりません`, "Claude Code を入れるか、.devkit/config.json の claudeBin を直す");
    const a = resolveAgents(ctx, config);
    if (!a.ok) return add("agents", "problem", "AI の担当（エージェント）", a.problem);
    const how = {
      config: `.devkit/config.json の pluginDir（${a.pluginDir}）`,
      settings: "設定で devkit プラグインが有効",
      installed: `インストール済みの devkit プラグイン（${a.pluginDir}）を --plugin-dir で渡す`,
      extraArgs: "extraArgs でプラグインを渡している",
      custom: `担当の名前を変えている（${agentName(config, "implementer")} など。定義の場所は確かめていない）`,
    }[a.how];
    add("agents", "ok", "AI の担当（エージェント）", how);
  });

  // 5) 計画と状態
  let g = null;
  guard("plan", "計画", () => {
    g = loadGraph(ctx, { required: false });
    if (!g) return add("plan", "info", "計画", "まだありません（kickoff で作る）");
    const c = loadControls(ctx);
    const { errors } = validate(ctx, g, { controls: c });
    if (errors.length) return add("plan", "problem", "計画", errors.join("\n"), "pnpm devkit check で確かめて直す");
    const pa = planApproved(ctx, c);
    if (!pa.ok)
      return add(
        "plan",
        "problem",
        "計画",
        pa.changedAfterApproval ? "計画（graph.json・仕様書・mission.md）が承認の後に変わっています" : `計画が承認されていません（${pa.pending.join("・")}）`,
        `人が端末（または Claude Code の入力欄の !）で ${(pa.changedAfterApproval ? ["business", "technical"] : pa.pending).map((r) => `pnpm devkit approve plan --role ${r}`).join(" と ")}`,
      );
    const s = loadState(ctx, g);
    const branch = currentBranch(ctx.root);
    if (s.outer === "idle") add("plan", "info", "計画", "承認済み。まだ開始していません", "pnpm devkit start");
    else if (!["running", "done"].includes(s.outer)) add("plan", "problem", "計画", `状態が ${s.outer} です（${s.reason}）`, "理由を確かめてから pnpm devkit resume");
    else if (branch !== g.branch) add("plan", "problem", "計画", `統合ブランチ ${g.branch} にいません（今は ${branch || "detached"}）`, `git switch ${g.branch}`);
    else add("plan", "ok", "計画", `承認済み・${s.outer === "done" ? "完了" : "実行できる"}（ブランチ ${g.branch}）`);
    // 削除してよいテスト（allowTestRemoval）は、そのノードの owns の中にあること（外だと、実装担当は削除できない）
    const outside = g.nodes.flatMap((n) => n.allowTestRemoval.filter((p) => !/[*?{]/.test(p) && !matchesAny(p, n.owns)).map((p) => `${n.id}: ${p}`));
    if (outside.length) add("removal", "problem", "テストの削除の許可（allowTestRemoval）", `owns の外のファイルは、実装担当が削除できません: ${outside.join(", ")}`, "計画で、そのノードの owns に入れる");
  });

  // 6) 未コミットの変更と、記録の照合
  guard("worktree", "未コミットの変更", () => {
    const prev = readJson(ctx.runFile, null);
    const dirty = dirtyFiles(ctx.root).filter((f) => !f.startsWith(".devkit/") && f !== "docs/decisions.md");
    const unexplained = uncommittedUnexplained(ctx, prev);
    const all = [...new Set([...dirty, ...unexplained])];
    if (all.length) add("worktree", "problem", "未コミットの変更", `${all.slice(0, 12).join(", ")}${all.length > 12 ? " ほか" : ""}`, "git diff で内容を確かめ、正しければ人がコミットする（.devkit/config.json を手で作った・変えたときも、コミットが要る）");
    else add("worktree", "ok", "未コミットの変更", "なし");
    const jp = journalProblem(ctx);
    const committed = committedUnexplained(ctx, prev);
    if (jp || committed.length)
      add(
        "seal",
        "problem",
        "記録の照合",
        [jp, committed.length ? `devkit のコマンドとランナーが書いたものではない内容の記録: ${committed.join(", ")}` : ""].filter(Boolean).join("\n"),
        `git log -p で誰が何を変えたかを確かめ、正しい内容なら（コミットしてから）標準オーナーが端末で ${SEAL_ACCEPT}。docs/exceptions.json は、手で書かずに pnpm devkit exception add で登録すると、この手続きは要らない`,
      );
    else add("seal", "ok", "記録の照合", "記録はすべて devkit のコマンドとランナーが書いたもの");
  });

  // 7) 人が手で書くファイルの形（コンテナの検証まで進んでから落ちないように、先に確かめる）
  guard("files", "人が編集するファイルの形", () => {
    const fp = humanFileProblems(ctx);
    if (fp.length)
      add("files", "problem", "人が編集するファイルの形", fp.join("\n"), `直してコミットする。docs/exceptions.json を直したら、そのあとで標準オーナーが ${SEAL_ACCEPT}`);
    else add("files", "ok", "人が編集するファイルの形", HUMAN_EDITED.map((x) => x.rel).join("・"));
  });

  return items;
}

const MARK = { ok: "OK  ", problem: "NG  ", warn: "注意", info: "－  " };

export function doctorText(items) {
  const lines = [];
  for (const x of items) {
    const [first, ...more] = String(x.detail ?? "").split("\n");
    lines.push(`  ${MARK[x.level] ?? x.level} ${x.title}${first ? `: ${first}` : ""}`);
    for (const m of more) lines.push(`         ${m}`);
    if (x.fix && x.level !== "ok") lines.push(`       → ${x.fix}`);
  }
  return lines.join("\n");
}
