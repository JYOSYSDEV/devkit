#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit) フック: goal を「ずるく」満たす編集と、危険な編集を止める。
// 判定は、置き換える断片ではなく、編集を当てはめた後のファイル全体で行う。
// exit 2 + stderr で Claude に理由を返す（Claude はやり方を変えて続行できる）。ガードは補助で、合否はランナーの機械検証が決める。
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  findRepoRoot,
  isNestedWorktree,
  isProtectedPath,
  isProtectedStateFile,
  isSharedPath,
  isTestPath,
  READ_ONLY_ROLES,
  repoRelative,
  WEAKEN_PATTERNS,
  WORKER_AGENTS,
  weakeningOf,
} from "../../scripts/devkit/shared.mjs";

// ランナーが起動した AI の役割（DEVKIT_ROLE）。レビュー・再計画の担当は読み取り専用
const ROLE = process.env.DEVKIT_ROLE ?? "";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const ti = input.tool_input ?? {};
const rawPath = String(ti.file_path ?? ti.notebook_path ?? "");
if (!rawPath) process.exit(0);
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
// ~ はホームとして解く（ツールがホームに展開しても、ガードの判定と食い違わないように）
const expanded = rawPath === "~" || rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(1)) : rawPath;
const file = resolve(cwd, expanded).replaceAll("\\", "/");

function block(msg) {
  process.stderr.write(`[devkit guard] ${msg}\n`);
  process.exit(2);
}

function readCurrent() {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

// 編集を当てはめた後の内容（当てはめられない編集は、ツール自身が失敗するので、ここでは今の内容のままにする）
function applyEdit(text, oldS, newS, all) {
  if (typeof oldS !== "string" || typeof newS !== "string" || !oldS) return text;
  if (!text.includes(oldS)) return text;
  return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
}

const before = readCurrent();
let after = before;
if (typeof ti.content === "string") after = ti.content;
else if (Array.isArray(ti.edits)) for (const e of ti.edits) after = applyEdit(after, e?.old_string, e?.new_string, Boolean(e?.replace_all));
else if (typeof ti.old_string === "string") after = applyEdit(after, ti.old_string, ti.new_string, Boolean(ti.replace_all));
else if (typeof ti.new_source === "string") after = ti.new_source;

const { rel, repo } = repoRelative(file);
const base = file.split("/").pop() ?? "";

// 0. 読み取り専用の役割（レビュー・最終レビュー・再計画・仕様の読み合わせ）
if (READ_ONLY_ROLES.has(ROLE)) block(`${ROLE} は読み取り専用。ファイルは変更せず、指摘や案は構造化出力で返す。`);

// 0b. ランナーが起動した実装担当は、作業ディレクトリ（DEVKIT_WORKDIR）の中のファイルだけを書く。
//     Bash のサンドボックスは Edit・Write には効かないので、ここで止める。書き方（..・絶対パス・~）、
//     途中のリンク（シンボリックリンク）、ハードリンク、.git の中で外に出るものも止める
if (ROLE === "implementer") checkInsideWork();

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function insideDir(base, p) {
  return p === base || p.startsWith(`${base}${sep}`);
}

function checkInsideWork() {
  const given = resolve(process.env.DEVKIT_WORKDIR || findRepoRoot(cwd)?.root || cwd);
  const work = real(given);
  const say = (why) => block(`${why}。ランナーの実装担当が Edit・Write で書けるのは、作業ディレクトリ（${work}）の中のファイルだけ（必要なら報告の needs に書く）。`);
  const abs = resolve(file);
  const base = [given, work].find((b) => insideDir(b, abs));
  if (!base) say(`${rawPath} は作業ディレクトリの外`);
  const parts = relative(base, abs).split(sep).filter(Boolean);
  if (!parts.length) say(`${rawPath} は作業ディレクトリそのもの`);
  if (parts.includes(".git")) say(`${rawPath} は .git の中（git の設定・フック）`);
  // 途中と最後の部分にリンクがないか（リンクの先は作業ディレクトリの外かもしれない）
  let cur = base;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // ここから先はまだない（新しく作る）
    }
    if (st.isSymbolicLink()) say(`${rawPath} はリンク（${relative(base, cur)}）を通した書き込み`);
    if (cur === abs && st.isFile() && st.nlink > 1) say(`${rawPath} はハードリンクのファイル（ほかの場所と中身を共有している）`);
  }
  // 念のため、いちばん深い既存の場所を実際に解いても中にあるか
  let probe = abs;
  while (!existsSync(probe) && probe !== resolve(probe, "..")) probe = resolve(probe, "..");
  if (!insideDir(work, real(probe))) say(`${rawPath} の行き先は作業ディレクトリの外`);
}

// 1. シークレット
if (/^\.env(\.|$)/.test(base) && base !== ".env.example") {
  block(`${base} は編集しない。必要な環境変数は .env.example と src/lib/env.ts に追記し、値は人間に設定を依頼する。`);
}

// 1b. .git の中（設定・フック・refs）は、誰も Edit・Write で変えない（git のコマンドで変える）
if (/^\.git(\/|$)/.test(rel) || /(^|\/)\.git\/(hooks|config|info)(\/|$)/.test(file)) {
  block(".git の中（設定・フック）は編集しない。git の操作は git のコマンドで行う。");
}

// 2. devkit だけが書き換える状態ファイル（誰からの編集も止める）
if (isProtectedStateFile(rel)) {
  block(
    `${rel} は devkit が管理するファイルなので直接編集しない。状態は pnpm -s devkit のコマンドで変える。承認・回答・上限の追加・判断の記録は、人が端末で pnpm devkit approve / answer / resume --add-cycles / record を実行する。`,
  );
}

// 3. テストの弱体化（skip / only / todo・別名の追加、テストケースや expect の減少）。テストの準備のファイルも同じ
const isTestish = isTestPath(rel) || /(^|\/)(vitest|playwright)\.setup\.|^tests\/setup|^e2e\/(fixtures|global-setup|global-teardown)/.test(rel);
if (isTestish) {
  const problems = weakeningOf(before, after);
  if (problems.length)
    block(
      `テストを弱める変更は禁止（${problems.join("・")}）。失敗するなら実装を直す。テストが仕様と食い違うなら変更せず報告する（ランナーの作業なら構造化出力の needs か request、対話なら利用者に相談）。`,
    );
}

// 3b. ファイル単位で型チェック・lint を外す指定（テスト以外のコード）
if (!isTestish && /\.[cm]?[jt]sx?$/.test(file)) {
  const OFF = WEAKEN_PATTERNS.at(-1)[0];
  const n = (s) => (String(s).match(OFF) ?? []).length;
  if (n(after) > n(before)) block("ファイル単位で型チェック・lint を外す指定（@ts-nocheck・biome-ignore-all など）は追加しない。原因を直す。");
}

// 3c. 社内標準と devkit 自身は案件の中で書き換えない（更新は /devkit:update で版ごと入れ替える）
if (/^(docs\/standard|scripts\/devkit|scripts\/standard|docs\/devkit)\//.test(rel) && !process.env.DEVKIT_UPDATING) {
  block(`${rel} は社内標準・devkit の一部なので案件の中では変更しない。標準の例外が必要なら標準オーナーに /devkit:devkit-standard-exception を依頼する。`);
}

// 3d. ランナーが起動した実装担当は、仕様・人の判断の記録・テストの設定など保護されたパスと共有ファイルを変えない
if (ROLE === "implementer" && (isProtectedPath(rel) || isSharedPath(rel))) {
  block(`${rel} は作業（ノード）では変更できない（仕様・標準・共有ファイル・テストの設定と準備）。必要なら報告の needs に書くか、判断依頼（request）を返す。`);
}

// 4. 並列ワーカーからの共有ファイル編集
//    ワーカー = implementer / reviewer サブエージェント（フック入力の agent_type）か、プロジェクト内の git worktree での編集。
//    人が `claude --worktree` で作業するときは DEVKIT_MAIN_SESSION=1 で起動すると対象外になる。
const inWorktree = isNestedWorktree(repo) && !process.env.DEVKIT_MAIN_SESSION;
const isWorker = WORKER_AGENTS.has(String(input.agent_type ?? "")) || inWorktree;
if (isWorker && isSharedPath(rel)) {
  block(`${rel} は全ノード共有のファイルなので、並列ワーカーは変更しない。必要な変更内容を報告の needs に書いて終える。`);
}

process.exit(0);
