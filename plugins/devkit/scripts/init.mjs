#!/usr/bin/env node
// devkit を案件に入れる・版を上げる（プラグインのスキル devkit-init / devkit-update から呼ぶ）。依存パッケージなし。
//
//   新規:   node init.mjs new --title "備品貸出" [--slug equipment-lending] [--dir .]
//           雛形のアプリと実行部品を入れ、git init する（pnpm install はスキルの手順で行う）
//   導入:   node init.mjs adopt --title "既存システム" [--dir .]
//           既存のアプリのコードには触れず、実行部品・標準・設定だけを入れる
//   更新:   node init.mjs update [--dir .] [--dry-run]
//           実行部品と社内標準を、このプラグインの版に入れ替える。案件で手を入れたファイルは上書きせず .devkit-new を置く
//   版:     node init.mjs version [--dir .] [--json]
//           プラグインと案件の実行部品の版を比べる（スキルが作業の前に確かめる）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(here, "..");
const RUNTIME = join(PLUGIN, "runtime");
const TEMPLATE = join(PLUGIN, "templates", "app");
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;

const [mode, ...rest] = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = rest[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const dir = resolve(String(opt("dir", ".")));
const json = Boolean(opt("json", false));
const dryRun = Boolean(opt("dry-run", false));

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const majorMinor = (v) => String(v ?? "").split(".").slice(0, 2).join(".");

function walk(base, sub = "", acc = []) {
  const p = join(base, sub);
  if (!existsSync(p)) return acc;
  for (const name of readdirSync(p)) {
    if (["node_modules", ".next", "test-reports", "test-results", ".DS_Store"].includes(name)) continue;
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(base, rel)).isDirectory()) walk(base, rel, acc);
    else acc.push(rel);
  }
  return acc;
}

// 案件に置く実行部品（.devkit/learnings.md は案件の学びなので、初回だけ置いて更新しない）
const SEED_ONLY = new Set([".devkit/learnings.md"]);
const runtimeFiles = () => walk(RUNTIME);

function runnerAlive(target) {
  try {
    const lock = JSON.parse(readFileSync(join(target, ".devkit", "run.lock"), "utf8"));
    process.kill(lock.pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function versionFile(target) {
  return join(target, ".devkit", "version.json");
}

function readVersion(target) {
  try {
    return JSON.parse(readFileSync(versionFile(target), "utf8"));
  } catch {
    return null;
  }
}

function writeVersion(target, files) {
  const rec = { version: PLUGIN_VERSION, standard: readFileSync(join(RUNTIME, "docs", "standard", "VERSION"), "utf8").trim(), installedAt: new Date().toISOString(), files };
  mkdirSync(join(target, ".devkit"), { recursive: true });
  writeFileSync(versionFile(target), `${JSON.stringify(rec, null, 2)}\n`);
}

function copyRuntime(target, { settingsTo = ".claude/settings.json" } = {}) {
  const files = {};
  for (const rel of runtimeFiles()) {
    const dst = rel === ".claude/settings.json" ? settingsTo : rel;
    const to = join(target, dst);
    if (SEED_ONLY.has(rel) && existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(RUNTIME, rel), to);
    files[dst] = sha(to);
  }
  return files;
}

function fill(target, title, slug) {
  for (const rel of walk(target)) {
    if (!/\.(json|md|tsx?|mjs|ya?ml|css|html)$/.test(rel) || rel.startsWith(".git/") || rel === "pnpm-lock.yaml") continue;
    const p = join(target, rel);
    const text = readFileSync(p, "utf8");
    if (!text.includes("__PROJECT_")) continue;
    // JSON と TS の文字列に入るので、引用符・改行・波かっこは使えない文字に置き換える
    const safeTitle = title.replace(/["'`\\{}<>\r\n]/g, " ").trim();
    writeFileSync(p, text.replaceAll("__PROJECT_SLUG__", slug).replaceAll("__PROJECT_TITLE__", safeTitle));
  }
}

function git(args, cwd = dir) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function ensureGitignore(target) {
  const p = join(target, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const need = [".devkit/worktrees/", ".devkit/run.json", ".devkit/run.lock", ".devkit/logs/", ".devkit/cache/", ".devkit/gates/", ".devkit/status.html", ".devkit/controls.json.lock", ".devkit/**/*.tmp-*", "test-reports/", ".claude/settings.local.json", ".claude/worktrees/"].filter(
    (l) => !cur.split(/\r?\n/).includes(l),
  );
  if (need.length) writeFileSync(p, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}\n# devkit\n${need.join("\n")}\n`);
}

const ALLOWED_EXISTING = new Set([".git", ".claude", ".vscode", ".idea", "README.md", ".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes", "LICENSE"]);

const modes = {
  new() {
    const title = opt("title");
    if (typeof title !== "string" || !title.trim()) fail('--title "プロジェクト名" を指定してください');
    const slugArg = opt("slug");
    const slug = typeof slugArg === "string" ? slugArg : (dir.split(/[\\/]/).pop() ?? "app").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail("--slug は英小文字・数字・ハイフン（例: equipment-lending）");
    mkdirSync(dir, { recursive: true });
    const existing = readdirSync(dir).filter((f) => !ALLOWED_EXISTING.has(f));
    if (existing.length) fail(`空でないフォルダには新規作成できません（${existing.slice(0, 5).join(", ")}）。既存のアプリに入れるなら adopt を使います`);
    const gi = existsSync(join(dir, ".gitignore")) ? readFileSync(join(dir, ".gitignore"), "utf8") : null;
    cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.next|test-reports|test-results)([\\/]|$)/.test(src) });
    if (gi !== null) writeFileSync(join(dir, ".gitignore"), `${gi.trimEnd()}\n\n${readFileSync(join(TEMPLATE, ".gitignore"), "utf8")}`);
    const files = copyRuntime(dir);
    fill(dir, title, slug);
    // パッケージ名と画面のタイトル（コードには JSON の文字列として入れる）
    const pkgFile = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    pkg.name = slug;
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    const layout = join(dir, "src", "app", "layout.tsx");
    if (existsSync(layout)) writeFileSync(layout, readFileSync(layout, "utf8").replace('title: "devkit app"', `title: ${JSON.stringify(title.trim())}`));
    ensureGitignore(dir);
    writeVersion(dir, files);
    if (!existsSync(join(dir, ".git"))) {
      const r = git(["init", "-b", "main"]);
      if (r.status !== 0) git(["init"]);
    }
    console.log(`✓ devkit ${PLUGIN_VERSION} で作りました: ${dir}`);
    console.log("  次: pnpm install → pnpm exec playwright install chromium → pnpm verify → git add -A && git commit -m \"devkit: 雛形から作成\"");
  },

  adopt() {
    const title = opt("title");
    if (typeof title !== "string" || !title.trim()) fail('--title "システム名" を指定してください');
    if (!existsSync(dir)) fail(`${dir} がありません`);
    const hasSettings = existsSync(join(dir, ".claude", "settings.json"));
    const files = copyRuntime(dir, { settingsTo: hasSettings ? ".claude/settings.devkit.json" : ".claude/settings.json" });
    for (const seed of ["docs/profile.json", "docs/exceptions.json", "docs/decisions.md", "docs/runbook.md", "docs/spec/_template.md", "docs/adr/_template.md"]) {
      const to = join(dir, seed);
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(TEMPLATE, seed), to);
    }
    fill(join(dir, "docs"), title, "app");
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
      pkg.scripts ??= {};
      pkg.scripts.devkit ??= "node scripts/devkit/devkit.mjs";
      pkg.scripts["standard:check"] ??= "node scripts/standard/check.mjs";
      pkg.scripts["standard:release"] ??= "node scripts/standard/check.mjs --release";
      writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    ensureGitignore(dir);
    writeVersion(dir, files);
    console.log(`✓ devkit ${PLUGIN_VERSION} を導入しました（アプリのコードは変更していません）: ${dir}`);
    if (hasSettings) console.log("  ※ .claude/settings.json が既にあるため、devkit の設定は .claude/settings.devkit.json に置きました。permissions と hooks を手で統合してください");
    console.log("  ※ 既存の技術が社内標準と違うと、pnpm standard:check が違反を出します。例外として登録するか（devkit-standard-exception）、移行のマイルストーンを計画に入れます");
    console.log("  ※ graph.json の verify / verifyFull に、このプロジェクトの検証コマンドを書きます（テストの結果を test-reports/ に JSON で出す設定が必要）");
  },

  update() {
    const rec = readVersion(dir);
    if (!rec) fail(".devkit/version.json がありません（devkit で作った案件ではない、または古い版）。adopt で入れ直してください");
    if (runnerAlive(dir)) fail("ランナーが実行中です。止まってから更新してください");
    const installed = rec.files ?? {};
    const next = {};
    const report = { replaced: [], added: [], kept: [], removed: [] };
    const settingsRel = existsSync(join(dir, ".claude", "settings.devkit.json")) ? ".claude/settings.devkit.json" : ".claude/settings.json";
    for (const rel of runtimeFiles()) {
      const dst = rel === ".claude/settings.json" ? settingsRel : rel;
      const to = join(dir, dst);
      const src = join(RUNTIME, rel);
      if (SEED_ONLY.has(rel)) {
        if (existsSync(to)) continue;
      }
      if (!existsSync(to)) {
        if (!dryRun) {
          mkdirSync(dirname(to), { recursive: true });
          cpSync(src, to);
        }
        report.added.push(dst);
        next[dst] = sha(src);
        continue;
      }
      const local = sha(to);
      if (local === sha(src)) {
        next[dst] = local;
        continue;
      }
      if (installed[dst] && installed[dst] === local) {
        if (!dryRun) cpSync(src, to);
        report.replaced.push(dst);
        next[dst] = sha(src);
      } else {
        if (!dryRun) cpSync(src, `${to}.devkit-new`);
        report.kept.push(dst);
        next[dst] = local;
      }
    }
    for (const [dst, h] of Object.entries(installed)) {
      if (next[dst] || !existsSync(join(dir, dst))) continue;
      if (sha(join(dir, dst)) === h) {
        if (!dryRun) rmSync(join(dir, dst));
        report.removed.push(dst);
      }
    }
    if (!dryRun) writeVersion(dir, next);
    console.log(`${dryRun ? "（試しに）" : ""}devkit ${rec.version} → ${PLUGIN_VERSION}`);
    for (const [k, label] of [["replaced", "入れ替え"], ["added", "追加"], ["removed", "削除"], ["kept", "案件で手を入れていたため残した（新しい版は .devkit-new）"]])
      if (report[k].length) console.log(`  ${label}: ${report[k].join(", ")}`);
    if (!dryRun) console.log("  次: pnpm standard:check と pnpm verify で確かめ、git add -A && git commit -m \"devkit: 実行部品を更新\"");
  },

  version() {
    const rec = readVersion(dir);
    const info = { plugin: PLUGIN_VERSION, project: rec?.version ?? null, match: Boolean(rec) && majorMinor(rec.version) === majorMinor(PLUGIN_VERSION) };
    if (json) console.log(JSON.stringify(info));
    else console.log(info.match ? `一致（${info.project}）` : `不一致: プラグイン ${info.plugin} ／ 案件 ${info.project ?? "なし"}。/devkit:devkit-update で更新します`);
    process.exitCode = info.match ? 0 : 3;
  },
};

if (!modes[mode]) fail("使い方: init.mjs new|adopt|update|version [--dir .] …");
modes[mode]();
