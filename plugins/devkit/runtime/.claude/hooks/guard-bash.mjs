#!/usr/bin/env node
// PreToolUse(Bash) フック: 権限ルールのパターンでは区別できない危険なコマンドを止める。
//   - 人だけが実行するコマンド（承認・差し戻し・回答・再計画の案の承認・標準の例外・上限の追加・判断の記録）。
//     pnpm / npm run / node scripts/devkit/devkit.mjs / 絶対パスのどれで呼んでも、eval・sh -c・script・xargs などで包んでも止める
//   - devkit が管理する状態ファイル（.devkit/state.json・controls.json・config.json など、docs/decisions.md）への書き込み。
//     パスは cd・./・//・..・絶対パス・glob を解いてから判定する
//   - Claude Code の中から実行されたことを隠す操作（env -i・unset CLAUDECODE・setsid など）と、人のための抜け道の変数
//   - 依存パッケージの追加・削除、作業を失う git 操作、並列ワーカーからの push・PR 作成
//   - git の書き込みのオプション（--output・format-patch -o・archive -o・bundle create・clone・init・worktree add など）の
//     書き込み先も、リダイレクトと同じに判定する（-C・--git-dir・--work-tree を解いてから）。.git の中には書かない
//   - git に任意のコマンドを実行させる書き方（rebase --exec・bisect run・submodule foreach・difftool -x・--upload-pack など）
//   - git の設定の注入（-c・つなげた -c…・--config-env・GIT_CONFIG_* などの環境変数）。安全な設定（色・名前など）だけ通す
//   - 読み取り専用の役割（レビュー・再計画など）: 読むだけのコマンドに限り、コマンド置換・プロセス置換は使わせない
//   - ランナーが起動した実装担当: 書き込み先は作業ディレクトリ（DEVKIT_WORKDIR）の中だけ
// exit 2 + stderr で Claude に理由を返す。ガードは補助で、合否はランナーの機械検証が決める。
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globToRegExp, matchesAny } from "../../scripts/devkit/lib/util.mjs";
import { bashMarkerDir, bashMarkerName, findRepoRoot, isNestedWorktree, isProtectedPath, isProtectedStateFile, isSharedPath, isTestish, READ_ONLY_ROLES, WORKER_AGENTS } from "../../scripts/devkit/shared.mjs";

// ランナーが起動した AI の役割（DEVKIT_ROLE）
const ROLE = process.env.DEVKIT_ROLE ?? "";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const command = String(input.tool_input?.command ?? "");
if (!command.trim()) process.exit(0);

function block(msg) {
  process.stderr.write(`[devkit guard] ${msg}\n`);
  process.exit(2);
}

const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const repo = findRepoRoot(cwd);

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// 実装担当の作業ディレクトリ（ランナーが DEVKIT_WORKDIR で渡す。なければ今の作業ツリー）。書き込み先はこの中だけ
const WORK = ROLE === "implementer" ? real(process.env.DEVKIT_WORKDIR || repo?.root || cwd) : null;
const ROOT = WORK ?? repo?.root ?? cwd;
// 実装担当のノードの定義（ランナーが渡す。フックの環境は claude のもので、AI のコマンドからは変えられない）。
//   DEVKIT_OWNS: 変更してよいパス（なければ owns では絞らない。合否は機械検証が決める）
//   DEVKIT_ALLOW_TEST_REMOVAL: 削除してよいテストファイル（計画の allowTestRemoval。なければ、テストは削除できない）
function globList(name) {
  try {
    const v = JSON.parse(process.env[name] ?? "null");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : null;
  } catch {
    return null;
  }
}
const OWNS = globList("DEVKIT_OWNS");
const ALLOW_REMOVAL = globList("DEVKIT_ALLOW_TEST_REMOVAL") ?? [];
const isWorker = Boolean(ROLE) || WORKER_AGENTS.has(String(input.agent_type ?? "")) || (isNestedWorktree(repo) && !process.env.DEVKIT_MAIN_SESSION);

const HUMAN_MSG =
  "承認・差し戻し・回答・再計画の案の承認・標準の例外・上限の追加・判断の記録・記録の受け入れ（seal accept）・Supervisor の停止の解除（supervisor clear）は、人が行う。Claude からは実行しない。利用者に、端末で `pnpm devkit <コマンド>` を実行するか、Claude Code の入力欄で `! pnpm devkit <コマンド>` と打つよう伝える。";

// ---- 0. 全体に対する確認 ----

// .env（.env.example を除く）を参照するコマンド。引用符・./・glob（.e* など）を使った書き方も拾う
{
  const envRefs = [...command.matchAll(/(?:^|[\s"'=/\\(<>:])(\.e(?:n(?:v[\w.*?-]*)?)?[*?][\w.*?-]*|\.env(?:\.[\w.-]+)?)(?=$|[\s"';|&)<>])/g)].map((m) => m[1]);
  if (envRefs.some((f) => f !== ".env.example")) block(".env（秘密情報）を扱うコマンドは使わない。必要な設定は .env.example と src/lib/env.ts を見る。値は人に設定を依頼する。");
}

// 人のための抜け道・Claude Code の中であることを隠す操作
if (/\bDEVKIT_HUMAN_\w*/.test(command)) block("DEVKIT_HUMAN_* は人が端末で使うための設定。Claude のコマンドでは使わない。");
if (/\bDEVKIT_(NOW|TEST_\w*)\b/.test(command)) block("DEVKIT_NOW・DEVKIT_TEST_* は devkit の試験のための設定。Claude のコマンドでは使わない（時計をずらすと、待ち・上限・締切を飛ばせるため）。");
if (/\b(?:unset|export\s+-n)\s+[^;&|\n]*\bCLAUDE/.test(command) || /\benv\b[^;&|\n]*\s(?:-u\s*|--unset[= ])CLAUDE/.test(command) || /(^|[\s;&|(])CLAUDE(?:CODE|_CODE_\w+)=/.test(command))
  block("Claude Code の環境変数（CLAUDECODE など）を消したり書き換えたりしない。");
if (/\benv\s+(?:-[a-zA-Z]*i\b|--ignore-environment\b|-\s)/.test(command)) block("env -i（環境変数をすべて消す）は使わない。");
const mentionsDevkit = /\bdevkit(\.mjs)?\b/.test(command);
const humanWord = /\b(approve|reject|answer|record|accept|exception|add-cycles|clear)\b/.test(command);
if (mentionsDevkit && /(^|[;&|(]|\n)\s*(sudo\s+)?(setsid|disown|nohup|tmux|screen|at|batch|systemd-run|daemonize|start-stop-daemon|launchctl|crontab)\b/.test(command))
  block("devkit のコマンドを、端末から切り離して（setsid・nohup・tmux・at など）実行しない。");
// 中身が見えない実行（シェル・インタプリタへのパイプ、ヒアドキュメント、source）で人のコマンドを呼ばない
if (mentionsDevkit && humanWord && (/\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|xargs|python3?|node|perl|ruby|tclsh|expect)\b/.test(command) || /<<-?\s*['"]?\w+/.test(command) || /(^|[;&|(]|\n)\s*(source|\.)\s/.test(command)))
  block(HUMAN_MSG);

// ---- コマンドの分解 ----

// 1つのコマンド文字列を、引用符を考えて ; && || | & 改行 で区切る
function splitTop(text) {
  const out = [];
  let cur = "";
  let q = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < text.length) cur += text[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
      continue;
    }
    if (c === "$" && text[i + 1] === "(") depth++;
    if (c === ")" && depth > 0) depth--;
    if (depth === 0 && (c === "\n" || c === ";" || c === "&" || c === "|")) {
      if ((c === "&" || c === "|") && text[i + 1] === c) i++;
      else if ((c === "&" && (text[i + 1] === ">" || text[i - 1] === ">")) || (c === "|" && text[i - 1] === ">")) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquote(t) {
  return readWord(String(t), 0).value;
}

// $'…'（ANSI-C の引用）の中身
function ansiC(text, i) {
  let v = "";
  const ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  while (i < text.length && text[i] !== "'") {
    if (text[i] === "\\" && i + 1 < text.length) {
      const n = text[i + 1];
      let m;
      if ((m = text.slice(i + 1).match(/^x([0-9A-Fa-f]{1,2})/))) {
        v += String.fromCharCode(Number.parseInt(m[1], 16));
        i += 1 + m[0].length;
      } else if ((m = text.slice(i + 1).match(/^[0-7]{1,3}/))) {
        v += String.fromCharCode(Number.parseInt(m[0], 8));
        i += 1 + m[0].length;
      } else {
        v += ESC[n] ?? n;
        i += 2;
      }
      continue;
    }
    v += text[i++];
  }
  return { v, end: i + 1 };
}

// シェルの1語を読む（引用符・$'…'・バックスラッシュを外す。$(…)・\`…\`・\${…} は中で区切らず、そのまま残す）
function readWord(text, start) {
  let i = start;
  let v = "";
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (depth === 0 && (/\s/.test(c) || c === "<" || c === ">")) break;
    if (c === "'") {
      const e = text.indexOf("'", i + 1);
      const end = e < 0 ? text.length : e;
      v += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      const r = ansiC(text, i + 2);
      v += r.v;
      i = r.end;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          v += text[i + 1];
          i += 2;
        } else v += text[i++];
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      v += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const e = text.indexOf("`", i + 1);
      const end = e < 0 ? text.length : e;
      v += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
      depth++;
      v += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((c === "(" || c === "{") && depth > 0) depth++;
    if ((c === ")" || c === "}") && depth > 0) depth--;
    v += c;
    i++;
  }
  return { value: v, end: i };
}

// 1つのコマンド（splitTop で区切ったもの）を、語とリダイレクトに分ける
const REDIR = /^(\d*|&)(>>|>\||>&|>|<>|<<<|<<-|<<|<&|<)/;
function tokens(seg) {
  const out = { words: [], writes: [], reads: [], herestrings: [], heredoc: false };
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) break;
    const m = seg.slice(i).match(REDIR);
    if (m && (m[1] === "" || m[1] === "&" || /^\d+$/.test(m[1]))) {
      i += m[0].length;
      while (i < seg.length && /\s/.test(seg[i])) i++;
      const w = readWord(seg, i);
      i = w.end;
      const op = `${m[1]}${m[2]}`;
      // 書き込み: > >> >| &> <> と、>&ファイル（数字・- 以外）。2>&1 などの fd の付け替えは除く
      const dup = (m[2] === ">&" || m[2] === "<&") && /^(\d+|-)$/.test(w.value);
      if (/>|<>/.test(op) && !dup && !/^<(<|&|$)/.test(m[2])) out.writes.push(w.value);
      // 標準入力の元（< ファイル・<<< 文字列・<< ヒアドキュメント）。インタプリタやパッチの中身を確かめるのに使う
      if (m[2] === "<" || m[2] === "<>") out.reads.push(w.value);
      if (m[2] === "<<<") out.herestrings.push(w.value);
      if (m[2] === "<<" || m[2] === "<<-") out.heredoc = true;
      continue;
    }
    const w = readWord(seg, i);
    if (w.end === i) {
      i++;
      continue;
    }
    i = w.end;
    out.words.push(w.value);
  }
  return out;
}

function words(seg) {
  return tokens(seg).words;
}

// 前置き（env・command・exec・time・timeout・nice・stdbuf・sudo・xargs など）と、包む書き方（sh -c・eval・script -c・expect -c）を外す。
// 戻り値: { argv, inner: [包まれた中身の文字列], viaXargs, assigns: [[変数名, 値]] }
const PREFIX = new Set(["command", "exec", "time", "nice", "ionice", "nohup", "setsid", "stdbuf", "timeout", "sudo", "doas", "chronic", "unbuffer", "caffeinate", "watch", "strace", "ltrace", "builtin"]);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// 前置きのコマンドの、値を1つ取るオプション（sudo -u <名前> など。値をコマンドと取り違えない）
const PREFIX_VALUED = {
  sudo: ["-u", "-g", "-p", "-C", "-D", "-r", "-t", "-U", "-h", "--user", "--group", "--prompt", "--chdir"],
  doas: ["-u", "-C"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata"],
  stdbuf: ["-i", "-o", "-e"],
  watch: ["-n", "--interval", "-d"],
  strace: ["-o", "-e", "-p", "-s", "-u", "-E"],
  ltrace: ["-o", "-e", "-p", "-s", "-u"],
};
function unwrap(argv) {
  const inner = [];
  const assigns = [];
  let viaXargs = false;
  let shellStdin = false;
  let a = [...argv];
  const takeAssign = () => {
    const m = a[0].match(ASSIGN);
    assigns.push([m[1], m[2]]);
    a.shift();
  };
  for (let guard = 0; guard < 20 && a.length; guard++) {
    while (a.length && ASSIGN.test(a[0])) takeAssign();
    const p = a[0]?.replace(/^.*\//, "");
    if (!p) break;
    if (p === "env") {
      a.shift();
      while (a.length && (a[0].startsWith("-") || ASSIGN.test(a[0]))) {
        if (ASSIGN.test(a[0])) takeAssign();
        else a.splice(0, /^-(u|C|S)$|^--(unset|chdir|split-string)$/.test(a[0]) ? 2 : 1);
      }
      continue;
    }
    if (PREFIX.has(p)) {
      a.shift();
      const valued = PREFIX_VALUED[p] ?? [];
      while (a.length && (a[0].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(a[0]))) a.splice(0, valued.includes(a[0]) ? 2 : 1);
      continue;
    }
    // 1つの実行ファイルに多くのコマンドを持つもの（busybox cp … ／ busybox sh -c …）は、中のコマンドとして扱う
    if (p === "busybox" || p === "toybox") {
      a.shift();
      continue;
    }
    if (p === "xargs") {
      viaXargs = true;
      a.shift();
      while (a.length && a[0].startsWith("-")) a.splice(0, /^-[IdEsLnPa]$/.test(a[0]) ? 2 : 1);
      continue;
    }
    if (p === "eval") {
      inner.push(a.slice(1).join(" "));
      a = [];
      break;
    }
    if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(p)) {
      const ci = a.findIndex((x, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      if (ci > 0 && a[ci + 1] !== undefined) inner.push(a[ci + 1]);
      else {
        const script = a.slice(1).find((x) => !x.startsWith("-"));
        if (script !== undefined) inner.push(`__script__ ${script}`);
        else shellStdin = true;
      }
      a = [];
      break;
    }
    if (p === "script") {
      const ci = a.findIndex((x) => /^-[a-zA-Z]*c$/.test(x) || x === "--command");
      if (ci > 0 && a[ci + 1] !== undefined) inner.push(a[ci + 1]);
      a = [];
      break;
    }
    if (p === "expect") {
      const ci = a.findIndex((x) => x === "-c");
      if (ci > 0) inner.push(a.slice(ci + 1).join(" "));
      a = [];
      break;
    }
    if (/^(python[\d.]*|perl|ruby|node|deno|bun|php|lua|Rscript)$/.test(p)) {
      const ci = a.findIndex((x, k) => k > 0 && /^-([a-zA-Z]*[ce]|-eval|-print|p|r)$/.test(x));
      if (ci > 0 && a[ci + 1] !== undefined) inner.push(`__code__${a[ci + 1]}`);
    }
    break;
  }
  return { argv: a, inner, viaXargs, assigns, shellStdin };
}

// git の設定・実行するもの・読み書きする場所を変える環境変数。コマンドの前置き・env・export のどれで書いても止める。
// pager・editor は、よく使う無害な値（cat・true など）だけ通す。GIT_TRACE* はファイルに書けるので、0/1 などだけ通す
const ENV_PAGER = /^(GIT_PAGER|PAGER|GIT_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR)$/;
const SAFE_PAGER = /^(|cat|true|false|:|less(\s+-[A-Za-z]+)*|more)$/;
const ENV_TRACE = /^GIT_TRACE\w*$/;
const ENV_GIT_DANGER =
  /^(GIT_(CONFIG(?!_NOSYSTEM$)\w*|EXEC_PATH|SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|EXTERNAL_DIFF|PROXY_COMMAND|TEMPLATE_DIR|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|ATTR_SOURCE|REPLACE_REF_BASE)|SSH_ASKPASS|BROWSER|HOME|XDG_CONFIG_HOME)$/;
function checkEnvAssign(name, value) {
  const why = "（git の設定・フック・pager・editor などでコマンドを実行したり、別の場所に書いたりできるため）";
  if (ENV_PAGER.test(name)) {
    if (value === null || !SAFE_PAGER.test(String(value).trim())) block(`${name} にコマンドを設定しない${why}。pager を止めるなら git --no-pager か ${name}=cat。`);
    return;
  }
  if (ENV_TRACE.test(name)) {
    if (value === null || !/^(|0|1|2|true|false|yes|no|on|off)$/i.test(String(value).trim())) block(`${name} にファイルの場所を設定しない（git の記録がそのファイルに書かれるため）。${name}=1 なら標準エラーに出る。`);
    return;
  }
  if (ENV_GIT_DANGER.test(name)) block(`${name} を設定して git などを実行しない${why}。`);
}

// devkit の人だけのサブコマンドか（argv は前置きを外したもの）
const HUMAN_SUB = /^(approve|reject|answer|record)$/;
function humanSub(rest) {
  const r = rest.filter((x) => x !== "--" && !/^-(s|-silent)$/.test(x));
  const [sub, sub2] = r;
  if (!sub) return null;
  if (HUMAN_SUB.test(sub)) return sub;
  if (sub === "proposal" && /^(accept|reject)$/.test(sub2 ?? "")) return `proposal ${sub2}`;
  if (sub === "exception" && sub2 === "add") return "exception add";
  if (sub === "seal" && sub2 === "accept") return "seal accept";
  if (sub === "supervisor" && sub2 === "clear") return "supervisor clear";
  if (sub === "resume" && r.some((x) => x === "--add-cycles" || x.startsWith("--add-cycles="))) return "resume --add-cycles";
  return null;
}

function devkitInvocation(argv) {
  if (!argv.length) return null;
  const prog = argv[0].replace(/^.*\//, "");
  const args = argv.slice(1);
  if (/(^|\/)devkit\.mjs$/.test(argv[0])) return humanSub(args) ?? (args.length ? `__devkit__ ${args[0]}` : "__devkit__");
  if (["node", "bun", "deno"].includes(prog)) {
    const i = args.findIndex((x) => /devkit\.mjs$/.test(x));
    if (i >= 0) return humanSub(args.slice(i + 1)) ?? `__devkit__ ${args[i + 1] ?? ""}`;
    return null;
  }
  if (["pnpm", "npm", "yarn", "npx", "pnpx", "bunx"].includes(prog)) {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += /^(-C|--dir|--prefix|-w|--workspace|--filter|-F)$/.test(args[i]) ? 2 : 1;
    if (["run", "run-script", "exec", "x"].includes(args[i])) i++;
    while (i < args.length && args[i].startsWith("-")) i++;
    if (args[i] === "devkit") return humanSub(args.slice(i + 1)) ?? `__devkit__ ${args[i + 1] ?? ""}`;
  }
  return null;
}

// ---- パスの解決（cd を追い、./・//・..・絶対パスを解いて、リポジトリからの相対パスにする） ----

// インタプリタに渡したコード（node -e・python -c など）: 人のコマンドと、状態ファイルへの書き込みを文字列で探す
const CODE_WRITES = /write|append|rename|copy|unlink|\brm|open\s*\([^)]*["'][wax+]|truncate|symlink|>/;
function codeScan(code) {
  if (/devkit(\.mjs)?["'`]?[\s,'"`]+(?:["'`]?--["'`]?[\s,]+)?["'`]?(approve|reject|answer|record|proposal|exception|seal["'`]?[\s,]+["'`]?accept|supervisor["'`]?[\s,]+["'`]?clear)\b/.test(code) || /add-cycles/.test(code)) block(HUMAN_MSG);
  if (/(controls|state|config|run)\.json|journal\.jsonl|decisions\.md|exceptions\.json/.test(code) && /\.devkit|decisions|exceptions/.test(code) && CODE_WRITES.test(code))
    block("インタプリタのコードから devkit が管理するファイルを書き換えない。");
  if (/claude-bash/.test(code) && CODE_WRITES.test(code)) block("インタプリタのコードから、devkit が Claude のコマンドの実行中を記録する場所を書き換えない。");
  if (/\.git[\\/](config|hooks)|docs[\\/]standard|scripts[\\/](devkit|standard)/.test(code) && CODE_WRITES.test(code)) block("インタプリタのコードから .git の中・社内標準・devkit 自身を書き換えない。");
  // ランナーの実装担当: インタプリタのコードではファイルを書かない・コマンドを起動しない（書き込み先を確かめられない。Edit・Write を使う）
  if (WORK && /writeFile|appendFile|createWriteStream|open\s*\([^)]*["'][wax+]|\.write\s*\(|rename|unlink|rmSync|rmdir|copyFile|cpSync|symlink|truncate|chmod|child_process|spawn|exec|system\s*\(|popen|subprocess|`/.test(code))
    block("ランナーの実装担当は、インタプリタのコードでファイルを書いたりコマンドを起動したりしない。ファイルの変更は Edit・Write で、検証は許可されたコマンドで行う。");
}

// 小さな普通のファイルを読む（インタプリタのスクリプト・パッチの中身を確かめる）。読めなければ null
function readSmall(dir, p) {
  const abs = absOf(dir, p);
  if (abs === null) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// パッチ（git diff・unified・context・mbox）が書くファイル
function patchTargets(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^diff --git ("?)a\/(.+?)\1 ("?)b\/(.+?)\3$/))) {
      out.add(m[2]);
      out.add(m[4]);
    } else if ((m = line.match(/^(?:\+\+\+|---|\*\*\*) ("?)([^\t"]+)\1(?:\t.*)?$/))) {
      if (m[2] !== "/dev/null") out.add(m[2].trim());
    } else if ((m = line.match(/^(?:rename|copy) (?:from|to) (.+)$/))) out.add(m[1]);
    else if ((m = line.match(/^Index: (.+)$/))) out.add(m[1]);
  }
  return [...out];
}

// パッチの中身の書き込み先を、どの -p（先頭を何段外すか）で当てても保護されたものに当たらないか確かめる
function checkPatch(dir, text, what, prefix = "") {
  for (const p of patchTargets(text)) {
    const parts = p.split("/").filter(Boolean);
    for (let k = 0; k < parts.length; k++) checkWrite(dir, `${prefix}${parts.slice(k).join("/")}`, { what });
  }
}

// 標準入力の中身（< ファイル・<<< 文字列・パイプの前の cat）。分からなければ null。ヒアドキュメントはコマンド全体を返す
function stdinSources(tk, here) {
  const texts = [];
  for (const f of tk.reads) texts.push(readSmall(here, f));
  texts.push(...tk.herestrings);
  if (tk.heredoc) texts.push(command);
  if (!texts.length && /\|/.test(command)) {
    for (const seg of splitTop(command)) {
      const w = words(seg);
      if (w[0] === "cat") for (const f of w.slice(1).filter((x) => !x.startsWith("-"))) texts.push(readSmall(here, f));
    }
    if (!texts.length) return null;
  }
  return texts;
}

const INTERPRETERS = /^(python[\d.]*|perl|ruby|node|nodejs|deno|bun|php|lua|Rscript|tclsh|osascript)$/;

// 存在しない部分も含めて、リンクを解いた絶対パスにする（リンクを通した書き込みも、行き先で判定する）
function realish(p, depth = 0) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {}
  try {
    if (depth < 16 && lstatSync(abs).isSymbolicLink()) return realish(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
  } catch {}
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realish(parent, depth + 1), basename(abs));
}

const ROOT_REAL = real(ROOT);

// 同じコマンドの中で先に代入した変数（X=.devkit; echo x > $X/controls.json など）
const VARS = new Map();
function expandVars(t) {
  return String(t).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => {
    const name = a ?? b;
    return VARS.has(name) ? VARS.get(name) : all;
  });
}

function expand(dir, target) {
  let t = expandVars(target).replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  return t
    .replace(/\$\{?PWD\}?/g, dir ?? "$PWD")
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, ROOT)
    .replace(/\$\{?HOME\}?/g, process.env.HOME ?? "~")
    .replace(/\$\{?TMPDIR\}?/g, process.env.TMPDIR || "/tmp");
}

// 書き込み先の絶対パス（リンクを解く）。展開できない変数を含むときは null
function absOf(dir, target) {
  if (dir === null) return null;
  const t = expand(dir, target);
  if (t.includes("$")) return null;
  return realish(isAbsolute(t) ? t : resolve(dir, t));
}

function insideDir(base, abs) {
  return abs === base || abs.startsWith(`${base}${sep}`);
}

// リポジトリ（実装担当なら作業ディレクトリ）からの相対パス。外なら null。asDir: ルートそのものは "."
function relOf(dir, target, { asDir = false } = {}) {
  if (!target || target.startsWith("&") || target.startsWith("/dev/")) return null;
  const t = dir === null ? expandVars(target) : expand(dir, target);
  if (dir === null || t.includes("$")) {
    // 展開できない変数: 保護されたファイルの名前や場所（.devkit・.git・docs/standard など）を含むなら、保護されたものとして扱う
    const hit = PROBES.find((p) => t.endsWith(`/${p}`) || t.endsWith(p));
    if (hit) return hit;
    const base = PROBES.find((p) => t.endsWith(`/${basename(p)}`) && !/\/x\.(json|md)$|\/pre-commit$|\/config$/.test(p));
    if (base) return base;
    if (/(^|\/)(\.devkit|\.git)(\/|$)|(^|\/)(docs\/(standard|decisions\.md|exceptions\.json)|scripts\/(devkit|standard))(\/|$)/.test(t)) return ".devkit/state.json";
    return null;
  }
  // glob はリンクを解かずに、書き方のまま判定する
  const abs = /[*?[{]/.test(t) ? resolve(dir, t) : realish(isAbsolute(t) ? t : resolve(dir, t));
  const base = /[*?[{]/.test(t) ? ROOT : ROOT_REAL;
  const rel = relative(base, abs).replaceAll("\\", "/");
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!rel) return asDir ? "." : null;
  return rel;
}

// glob の書き方（.devkit/c*.json など）は、保護されたファイルに当たりうるかで判定する
const PROBES = [".devkit/state.json", ".devkit/controls.json", ".devkit/config.json", ".devkit/journal.jsonl", ".devkit/events.jsonl", ".devkit/run.json", ".devkit/version.json", ".devkit/evidence/x.json", ".devkit/briefings/x.md", ".devkit/cache/supervisor/state.json", "docs/decisions.md", "docs/exceptions.json", ".git/config", ".git/hooks/pre-commit"];
function protectedTarget(rel) {
  if (!rel) return false;
  if (/[*?[{]/.test(rel)) {
    let re;
    try {
      re = globToRegExp(rel);
    } catch {
      return true;
    }
    if (PROBES.some((p) => re.test(p))) return true;
    if (ROLE && ["docs/spec/x.md", "docs/standard/x.md", "scripts/devkit/x.mjs", "scripts/standard/x.mjs", ".claude/settings.json", "package.json"].some((p) => re.test(p))) return true;
    return false;
  }
  if (isProtectedStateFile(rel)) return true;
  if (/^(docs\/standard|scripts\/devkit|scripts\/standard)(\/|$)/.test(rel)) return true;
  if (/^\.devkit\/?$/.test(rel) || rel === "docs" || rel === ".") return true;
  // .git の中（設定・フック・refs）は git のコマンドだけが変える
  if (/^\.git(\/|$)/.test(rel)) return true;
  return Boolean(ROLE) && (isProtectedPath(rel) || isSharedPath(rel));
}

// ディレクトリを作って中に書く先（clone・worktree add・format-patch -o など）。
// 保護されたもの、.devkit・.git の下、保護されたファイルを含む場所（ルート・docs・scripts など）には作らない
const DIR_PROBES = [...PROBES, "docs/spec/x.md", "docs/standard/x.md", "docs/profile.json", "scripts/devkit/x.mjs", "scripts/standard/x.mjs", ".claude/settings.json"];
function protectedDir(rel) {
  if (!rel) return false;
  const r = rel.replace(/\/+$/, "") || ".";
  if (protectedTarget(r)) return true;
  if (/^\.devkit(\/|$)/.test(r)) return true;
  return DIR_PROBES.some((p) => p.startsWith(`${r}/`));
}

const SCRATCH = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// 書き込み先の確かめ（リダイレクト・ファイルを書き換えるコマンド・git の書き込みのオプションが共用する）
const MARKERS = realish(bashMarkerDir());
function checkWrite(dir, target, { isDir = false, what = "書き込み", removes = false } = {}) {
  if (target === undefined || target === null || target === "" || target === "-") return;
  const t = String(target);
  if (SCRATCH.test(t)) return;
  // 書き込み先をコマンド置換で作らない（どこに書くかを確かめられない。mktemp だけはよい）
  if (/\$\(|`/.test(t) && !(/^(\$\(\s*mktemp\b[^()`$]*\)|`\s*mktemp\b[^`$]*`)$/.test(t) && !WORK))
    block(`${what}の先（${t}）にコマンド置換を使わない（どこに書くかを確かめられない）。場所をそのまま書く。`);
  const rel = relOf(dir, t, { asDir: isDir });
  if (isDir ? protectedDir(rel) : protectedTarget(rel))
    block(`${rel ?? t} への${what}はしない（devkit が管理するファイル・.git の中・作業では変更できないファイル${isDir ? "、またはそれを含む場所" : ""}）。`);
  // Claude の Bash が実行中であることの目印（人のコマンドを ! から受け付けるときに使う）は、Claude のコマンドでは書き換えない
  {
    const abs = absOf(dir, t);
    if (abs !== null && (insideDir(MARKERS, abs) || (removes && insideDir(abs, MARKERS)))) block(`${t} への${what}はしない（devkit が、Claude のコマンドの実行中を記録する場所）。`);
    if (abs === null && /claude-bash/.test(t)) block(`${t} への${what}はしない（devkit が、Claude のコマンドの実行中を記録する場所）。`);
  }
  if (WORK) {
    const abs = absOf(dir, t);
    if (abs === null || !insideDir(WORK, abs))
      block(`${t} への${what}はしない。ランナーの実装担当が書けるのは作業ディレクトリ（${WORK}）の中だけ（リンクの先や変数で外に出る書き方も含む）。`);
  }
}

const WRITE_CMDS = new Set(["cp", "mv", "install", "ln", "tee", "truncate", "rm", "rmdir", "touch", "dd", "rsync", "tar", "unzip", "patch", "chmod", "chown", "shred", "sed", "perl", "awk", "gawk", "ed", "ex", "vi", "vim", "nano", "emacs"]);
const DEST_ONLY = new Set(["cp", "install", "ln", "rsync"]);

// ---- 2. 読み取り専用の役割 ----
if (READ_ONLY_ROLES.has(ROLE)) {
  if (/\$\(|`|<\(|>\(|\$\{/.test(command)) block(`${ROLE} は読み取り専用。コマンド置換・プロセス置換・変数の展開は使わない（git の読み取りとファイルの表示だけ）。`);
  if (/(^|[^<>&0-9])>{1,2}|&>/.test(command)) block(`${ROLE} は読み取り専用。リダイレクトでファイルを書かない。`);
  const ok = (seg) =>
    /^(git\s+(status|diff|log|show|rev-parse|merge-base|ls-files|ls-tree|blame|grep)\b(?!.*\s(--output(=|\s)|-o\s|--open-files-in-pager|-O\S|--ext-diff|--exec))|cat|head|tail|wc|ls|grep|jq|rg(?!.*\s--pre\b)|pnpm\s+-s\s+devkit\s+(status|check|next|logs)\b)/.test(seg.trim());
  const segs = splitTop(command);
  if (!segs.every(ok)) block(`${ROLE} は読み取り専用。git の読み取り（diff・log・show など）とファイルの表示だけを使う。`);
}

// ---- 3. 1つずつのコマンド ----

function check(text, dir, depth) {
  if (depth > 6) block("入れ子が深すぎるコマンドは実行しない。");
  let here = dir;
  for (const seg of splitTop(text)) {
    // サブシェルの括弧を外す
    const s0 = seg.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    if (!s0) continue;
    const tk = tokens(s0);
    // リダイレクト（> >> >| N> &> >&ファイル <>）の書き込み先
    for (const target of tk.writes) checkWrite(here, target, { what: "リダイレクトでの書き込み" });
    // コマンド置換の中身も確かめる
    for (const m of s0.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g)) check(m[1] ?? m[2] ?? "", here, depth + 1);
    const { argv, inner, viaXargs, assigns, shellStdin } = unwrap(tk.words);
    const inlineCode = inner.some((t) => t.startsWith("__code__")) || inner.some((t) => !t.startsWith("__script__"));
    // 前置きの代入（NAME=値 コマンド ／ env NAME=値 コマンド）。代入だけの文は、以降の変数の値として覚える
    for (const [name, value] of assigns) checkEnvAssign(name, value);
    if (!argv.length) for (const [name, value] of assigns) VARS.set(name, expandVars(value));
    for (const t of inner) {
      if (t.startsWith("__script__")) {
        // シェルのスクリプトのファイル: 中身に人のコマンド・保護されたファイルへの書き込みがないか
        const text = readSmall(here, t.slice("__script__ ".length));
        if (text !== null) codeScan(text);
        continue;
      }
      if (t.startsWith("__code__")) {
        codeScan(t.slice(8));
        continue;
      }
      check(t, here, depth + 1);
    }
    // シェルが標準入力からコマンドを読む（sh < x ／ cat x | sh ／ sh <<EOF）: 中身を確かめる
    if (shellStdin) {
      const texts = stdinSources(tk, here);
      if (texts === null) {
        if (WORK) block("ランナーの実装担当は、中身の分からない標準入力のコマンドをシェルに渡さない。");
        codeScan(command);
      } else for (const t of texts) if (t !== null) codeScan(t);
    }
    const prog = String(argv[0] ?? "").replace(/^.*\//, "");
    const args = argv.slice(1);

    // インタプリタ（python・node など）とシェルのコードは、-c・-e で渡したものだけでなく、
    // スクリプトのファイル・< ファイル・<<< ・ヒアドキュメント・パイプの前の cat から渡したものも確かめる
    if (INTERPRETERS.test(prog) && !inlineCode) {
      const script = args.find((x) => !x.startsWith("-"));
      const fromStdin = !script || script === "-" || (prog.startsWith("python") && args.includes("-"));
      if (script && script !== "-") {
        const text = readSmall(here, script);
        if (text !== null) codeScan(text);
      }
      if (fromStdin) {
        const texts = stdinSources(tk, here);
        if (texts === null) {
          if (WORK) block("ランナーの実装担当は、中身の分からない標準入力のコードをインタプリタ・シェルに渡さない。");
          codeScan(command);
        } else for (const t of texts) if (t !== null) codeScan(t);
      }
    }
    // awk のプログラム（print > "ファイル" で書ける）
    if (["awk", "gawk", "mawk", "nawk"].includes(prog)) {
      const fi = args.indexOf("-f");
      if (fi >= 0) {
        const text = readSmall(here, args[fi + 1]);
        if (text !== null) codeScan(text);
      } else {
        const prg = positionals(args, ["-v", "-F", "-i"])[0];
        if (prg) codeScan(prg);
      }
    }
    if (!argv.length) continue;

    // export・declare -x など: 代入と、すでにある変数を環境に出すこと
    if (["export", "declare", "typeset", "readonly", "local"].includes(prog)) {
      for (const a of args) {
        if (a.startsWith("-")) continue;
        const m = a.match(ASSIGN);
        if (m) {
          checkEnvAssign(m[1], m[2]);
          VARS.set(m[1], expandVars(m[2]));
        }
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a) && (ENV_GIT_DANGER.test(a) || ENV_PAGER.test(a) || ENV_TRACE.test(a))) checkEnvAssign(a, null);
      }
      continue;
    }

    // cd: 以降の相対パスの基準を変える（変数などで分からなくなったら null）
    if (prog === "cd" || prog === "pushd") {
      const d = args.find((x) => !x.startsWith("-") || x === "-");
      if (!d) here = process.env.HOME ?? here;
      else if (d === "-" || d.includes("$") || /[*?[]/.test(d)) here = null;
      else {
        const t = d.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        here = isAbsolute(t) ? resolve(t) : here === null ? null : resolve(here, t);
      }
      continue;
    }

    // 人だけが実行するコマンド
    const inv = devkitInvocation(argv);
    if (inv && !inv.startsWith("__devkit__")) block(HUMAN_MSG);
    if (viaXargs && inv) block(`${HUMAN_MSG}（xargs から devkit を呼ばない）`);
    if (/\$\(|`/.test(argv[0]) && /\bdevkit\b/.test(s0) && /\b(approve|reject|answer|record|proposal|exception|add-cycles)\b/.test(s0)) block(HUMAN_MSG);
    // ランナーが起動した AI は devkit の状態を変えない（結果は構造化出力で返す）
    if (ROLE && inv && /^__devkit__ (start|pause|resume|run|approve|reject|answer|proposal|archive|log|exception|record|seal|briefing|supervisor)\b/.test(inv))
      block("ランナーが起動した AI は devkit のコマンドで状態を変えない。結果は構造化出力で報告する。");

    // ファイルを書き換えるコマンドの対象
    if (WRITE_CMDS.has(prog)) {
      const inPlace = ["sed", "perl"].includes(prog) ? args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) : true;
      let targets = args.filter((a) => !a.startsWith("-"));
      if (prog === "dd") targets = args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
      if (prog === "tar") targets = args.some((a) => /^-?[a-zA-Z]*x/.test(a) || a === "--extract") ? [".", ...args.filter((a, k) => args[k - 1] === "-C" || a.startsWith("--directory="))].map((a) => a.replace(/^--directory=/, "")) : [];
      if (DEST_ONLY.has(prog)) {
        const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
        targets = t >= 0 ? [args[t + 1]] : targets.slice(-1);
      }
      if (["sed", "awk", "gawk"].includes(prog) && !inPlace) targets = [];
      if (["sed", "perl"].includes(prog)) targets = targets.slice(prog === "sed" && !args.some((a) => a === "-e" || a === "-f") ? 1 : 0);
      if (inPlace) for (const a of targets) checkWrite(here, a, { what: `${prog} での書き込み`, removes: ["rm", "rmdir", "mv", "shred"].includes(prog) });
      // リンクの先: 保護されたファイル・場所へのリンクを作らない（リンクを通して書けるため）
      if (prog === "ln") {
        const srcs = args.filter((a) => !a.startsWith("-")).slice(0, -1);
        for (const src of srcs) {
          const rel = relOf(here, src, { asDir: true });
          if (protectedTarget(rel) || protectedDir(rel)) block(`${rel} へのリンクは作らない（devkit が管理するファイル・場所、.git の中）。`);
        }
      }
      // テストファイルの書き換え・削除。削除だけは、計画の allowTestRemoval にあるファイルなら通す（雛形の見本を消すノード）
      const removable = (a) => prog === "rm" && !/[*?[{]/.test(a) && matchesAny(relOf(here, a) ?? "", ALLOW_REMOVAL);
      if (ROLE === "implementer" && ["sed", "perl", "rm", "mv", "truncate", "patch"].includes(prog) && targets.some((a) => /(\.test\.|\.spec\.|^e2e\/|^tests\/)/.test(relOf(here, a) ?? "") && !removable(a)))
        block(`${prog} でテストファイルを書き換え・削除しない。テストの変更は Edit で行う（弱める変更はガードと機械検証が止める）。計画の allowTestRemoval にあるテストファイルの削除は \`git rm <パス>\` で行う。`);
    }
    if (ROLE && (prog === "patch" || (prog === "git" && ["apply", "am"].includes(args.find((a) => !a.startsWith("-")) ?? ""))))
      block("ランナーが起動した AI は patch・git apply を使わない。変更は Edit / Write で行う。");

    // 依存パッケージ
    if (prog === "pnpm") {
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) i += ["-C", "--dir", "--filter", "-F"].includes(args[i]) ? 2 : 1;
      const sub = args[i];
      const pkgs = args.slice(i + 1).filter((x) => !x.startsWith("-"));
      const changesDeps = ["add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "patch", "patch-commit"].includes(sub);
      const installsPkg = ["install", "i"].includes(sub) && pkgs.length > 0;
      const shadcn = sub === "dlx" && /^shadcn(@|$)/.test(args[i + 1] ?? "");
      if (isWorker && (changesDeps || installsPkg || shadcn)) block("並列ワーカーは依存パッケージを変更しない。必要なパッケージを報告の needs に書いて終える（例: 「pnpm add zod-form-data が必要」）。");
      if (installsPkg) block("`pnpm install <名前>` は依存の追加になる。依存の追加は `pnpm add <名前>`（確認が出る）で行い、devkit の計画中なら graph の dependencies にも書く。");
    }
    if (["npm", "yarn", "bun"].includes(prog) && /^(install|i|add|ci|uninstall|remove|rm|update|up|upgrade|link)$/.test(args[0] ?? ""))
      block("このリポジトリのパッケージ管理は pnpm。依存の追加は `pnpm add <名前>`（確認が出る）で行う。");
    if (isWorker && ["npx", "bunx", "pnpx"].includes(prog) && /^shadcn(@|$)/.test(args[0] ?? "")) block("並列ワーカーは shadcn の部品を追加しない（依存パッケージも増えるため）。必要な部品を報告の needs に書いて終える。");

    // find: -exec などで実行するコマンド、-fprint などの書き込み先、-delete で消す場所
    if (prog === "find") {
      const starts = [];
      let k = 0;
      while (k < args.length && !/^[-(!]/.test(args[k])) starts.push(args[k++]);
      for (; k < args.length; k++) {
        const a = args[k];
        if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
          const sub = [];
          for (k++; k < args.length && args[k] !== ";" && args[k] !== "+"; k++) sub.push(args[k]);
          check(sub.map((x) => `'${String(x).replaceAll("'", "'\\''")}'`).join(" "), here, depth + 1);
        } else if (/^-(fprint|fprint0|fls)$/.test(a)) checkWrite(here, args[++k], { what: "find の書き込み" });
        else if (a === "-fprintf") checkWrite(here, args[++k], { what: "find の書き込み" });
        else if (a === "-delete") for (const st of starts.length ? starts : ["."]) checkWrite(here, st, { what: "find -delete での削除", removes: true });
      }
    }

    // patch: パッチの中身の書き込み先（patch -p1 < x.patch ／ patch -i x.patch）
    if (prog === "patch") {
      const src = optionValues(args, ["-i", "--input"])[0] ?? positionals(args, ["-p", "-d", "--directory", "-i", "--input", "-o", "--output", "-r", "--reject-file", "-B", "--prefix", "-D", "--ifdef", "-F", "--fuzz", "-z", "--suffix"])[1];
      const texts = src !== undefined ? [readSmall(here, src)] : stdinSources(tk, here);
      if (texts === null) block("patch に、中身の分からない標準入力からパッチを渡さない（パッチのファイルを指定する）。");
      const dirOpt = optionValues(args, ["-d", "--directory"])[0];
      for (const t of texts) if (t !== null) checkPatch(dirOpt ? resolve(here ?? ".", dirOpt) : here, t, "patch での書き込み");
      for (const o of optionValues(args, ["-o", "--output"])) checkWrite(here, o, { what: "patch の出力" });
    }

    // git
    if (prog === "git") checkGit(args, s0, here, tk);

    // ワーカーからの PR 操作
    if (isWorker && prog === "gh" && args[0] === "pr" && /^(create|merge|close|edit|review)$/.test(args[1] ?? "")) block("並列ワーカーは PR を操作しない。結果は報告に書く。");
  }
}

// git の -c・--config-env・GIT_CONFIG_* で変えてよい設定（表示・名前など、コマンドの実行や書き込み先に関わらないもの）。これ以外は止める
const SAFE_GIT_KEY =
  /^(color\.[\w.-]+|advice\.[\w-]+|user\.(name|email)|core\.(quotepath|abbrev|autocrlf|safecrlf|eol|filemode|ignorecase)|diff\.(renames|algorithm|noprefix|mnemonicprefix|relative|context|interhunkcontext|statgraphwidth|colormoved|indentheuristic)|log\.(date|decorate|follow|abbrevcommit|showroot|graphcolors)|merge\.conflictstyle|pull\.(rebase|ff)|rebase\.(autosquash|autostash|updaterefs|stat|abbreviatecommands|missingcommitscheck)|init\.defaultbranch|commit\.(gpgsign|verbose|cleanup|status)|tag\.gpgsign|status\.[\w-]+|blame\.(date|coloring|markunblamablelines|markignoredlines)|grep\.(linenumber|patterntype|extendedregexp|column|fullname)|column\.[\w-]+|i18n\.[\w-]+|format\.(pretty|numbered|signoff)|rerere\.enabled|protocol\.version|fetch\.prune|push\.default)$/i;

function checkGitKey(kv, how) {
  const key = String(kv ?? "").split("=")[0].trim();
  if (!key || !SAFE_GIT_KEY.test(key))
    block(`git の ${how} で ${key || "設定"} を変えない（フック・pager・editor・filter・alias・include・credential などで、コマンドを実行したり別の場所に書いたりできるため）。変えてよいのは色・名前など表示の設定だけ。`);
}

// オプションを除いた引数（valued: 値を1つ取るオプション）
function positionals(list, valued = []) {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    const a = list[k];
    if (a === "--") {
      out.push(...list.slice(k + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      if (valued.includes(a)) k++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// オプションの値（--name=値 ／ --name 値）を集める
function optionValues(list, names) {
  const vals = [];
  for (let k = 0; k < list.length; k++) {
    const a = list[k];
    if (a === "--") break;
    for (const n of names) {
      if (a === n) vals.push(list[k + 1]);
      else if (n.startsWith("--") && a.startsWith(`${n}=`)) vals.push(a.slice(n.length + 1));
    }
  }
  return vals;
}

// clone・submodule add の、場所を省いたときの既定（リポジトリの名前）
function humanish(repo) {
  const r = String(repo ?? "").replace(/[\\/]+$/, "").replace(/\.git$/, "").replace(/[\\/]+$/, "");
  return basename(r.replace(/^.*:/, "")) || null;
}

// short オプションのまとまり（-ko など）に ch が入っているか。入っていれば、その後ろ（つなげた値）を返す
function shortWith(a, ch, { not = "" } = {}) {
  if (!/^-[A-Za-z0-9]/.test(a) || a.startsWith("--")) return null;
  if (not && not.includes(a[1])) return null;
  const at = a.indexOf(ch, 1);
  return at < 0 ? null : a.slice(at + 1);
}

// 実装担当の git rm: 消えるファイルを git に聞いて（ディレクトリ・glob を解く）、1つずつ確かめる。
//   - 作業ディレクトリの中で、保護されたファイル・共有ファイルではない
//   - ノードの owns の中（ランナーが渡したとき）
//   - テストのファイルは、計画の allowTestRemoval にあるものだけ（機械検証も同じ一覧で、実際に削除された場合だけ許す）
function checkRemoval(base, args) {
  const say = (why) => block(`git rm: ${why}。`);
  if (base === null) say("場所が分からない（変数など）ので、消すファイルを確かめられない。作業ディレクトリからの相対パスで書く");
  if (args.some((a) => /^--pathspec-from-file(=|$)/.test(a))) say("--pathspec-from-file は使わない（消すファイルをそのまま書く）");
  const specs = positionals(args, []);
  if (!specs.length) return;
  if (specs.some((p) => p.startsWith(":") || /\$|`/.test(p))) say("pathspec の特別な書き方（:(…)・:!）や変数は使わない（消すファイル・フォルダをそのまま書く）");
  for (const p of specs) checkWrite(base, p, { what: "git rm での削除" });
  const r = spawnSync("git", ["ls-files", "-z", "--full-name", "--", ...specs], { cwd: base, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) say("消すファイルを確かめられなかった（git ls-files が失敗した）");
  for (const f of r.stdout.split("\0").filter(Boolean)) {
    if (protectedTarget(f)) say(`${f} は作業（ノード）では変更できないファイル（仕様・標準・共有ファイル・テストの設定と準備）。必要なら報告の needs に書く`);
    if (OWNS && !matchesAny(f, OWNS)) say(`${f} はこのノードの owns（${OWNS.join(", ")}）の外。必要なら報告の needs に書く`);
    if (isTestish(f) && !matchesAny(f, ALLOW_REMOVAL))
      say(`${f} はテストのファイルで、計画の allowTestRemoval にない（${ALLOW_REMOVAL.length ? `削除してよいのは ${ALLOW_REMOVAL.join(", ")}` : "このノードに、削除してよいテストはない"}）。テストは削除せず、仕様と食い違うなら報告する`);
  }
}

const GIT_EXEC_MSG =
  "git に任意のコマンドを実行させる書き方（rebase --exec・bisect run・submodule foreach・difftool -x・filter-branch・--upload-pack・--template など）は使わない。必要なコマンドは直接実行する（bisect は git bisect good / bad と検証コマンドを1つずつ実行する）。";

function checkGit(argsAll, seg, here, tk = { reads: [], herestrings: [], heredoc: false }) {
  // 1) git 自身のオプション（-C・-c・--config-env・--git-dir・--work-tree・--exec-path など）
  let i = 0;
  let base = here;
  const location = (opt, p) => {
    if (p === undefined) return;
    if (WORK) {
      const abs = absOf(base, p);
      if (abs === null || !insideDir(WORK, abs)) block(`git ${opt} ${p}: ランナーの実装担当は、作業ディレクトリ（${WORK}）の外の git を扱わない。`);
    }
    // 自分のリポジトリ（--git-dir=.git ／ --work-tree=.）はよい。devkit が管理する場所・.git の中・保護されたものを含む場所は使わない
    const rel = relOf(base, p, { asDir: true });
    const own = (opt === "--git-dir" && rel === ".git") || (opt === "--work-tree" && rel === ".");
    if (!own && protectedDir(rel)) block(`git ${opt} ${p}: devkit が管理する場所・.git の中を、git の作業ツリーや git ディレクトリにしない。`);
  };
  while (i < argsAll.length && argsAll[i].startsWith("-")) {
    const a = argsAll[i];
    if (a === "-C") {
      const d = argsAll[i + 1];
      if (d !== undefined) {
        const t = base === null ? null : expand(base, d);
        base = t === null || t.includes("$") ? null : isAbsolute(t) ? resolve(t) : resolve(base, t);
        if (WORK && base !== null && !insideDir(WORK, realish(base))) block(`git -C ${d}: ランナーの実装担当は、作業ディレクトリ（${WORK}）の外の git を扱わない。`);
      }
      i += 2;
      continue;
    }
    if (a === "-c" || a === "--config-env") {
      checkGitKey(argsAll[i + 1], a);
      i += 2;
      continue;
    }
    if (a.startsWith("--config-env=")) {
      checkGitKey(a.slice("--config-env=".length), "--config-env");
      i++;
      continue;
    }
    if (/^-c./.test(a)) {
      checkGitKey(a.slice(2), "-c（つなげた書き方）");
      i++;
      continue;
    }
    if (/^--exec-path=/.test(a)) block("git --exec-path=<場所> で、git の部品を別の場所から実行しない。");
    if (/^--(git-dir|work-tree)$/.test(a)) {
      location(a, argsAll[i + 1]);
      i += 2;
      continue;
    }
    if (/^--(git-dir|work-tree)=/.test(a)) {
      location(a.split("=")[0], a.slice(a.indexOf("=") + 1));
      i++;
      continue;
    }
    if (/^--(namespace|super-prefix|attr-source|list-cmds)$/.test(a)) {
      i += 2;
      continue;
    }
    i++;
  }
  const sub = argsAll[i];
  const args = argsAll.slice(i + 1);
  const has = (...xs) => args.some((a) => xs.includes(a));
  const shortFlag = (ch) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
  const lose = (what) => block(`${what} は未コミットの作業やブランチを失う操作なので実行しない。必要なら理由を添えて利用者に依頼する。`);
  const opts = (() => {
    const k = args.indexOf("--");
    return k < 0 ? args : args.slice(0, k);
  })();
  const write = (p, isDir, what) => {
    if (base === null && p != null && p !== "" && p !== "-") block(`git -C の場所が分からない（変数など）ので、git ${sub} の${what}を確かめられない。場所を書いて実行する。`);
    checkWrite(base, p, { isDir, what: `git ${sub} の${what}` });
  };

  if (has("--no-verify")) block("--no-verify でフックを飛ばさない。失敗しているチェックを直す。");
  if (sub === "update-index" && args.some((a) => /^--(no-)?(skip-worktree|assume-unchanged)/.test(a))) block("git update-index --skip-worktree / --assume-unchanged で変更を隠さない。");

  // 2) git に任意のコマンドを実行させる書き方
  const exec =
    (sub === "rebase" && opts.some((a) => /^--exec(=|$)/.test(a) || shortWith(a, "x", { not: "XCSs" }) !== null)) ||
    (sub === "bisect" && args.includes("run")) ||
    (sub === "submodule" && args.includes("foreach")) ||
    (sub === "difftool" && opts.some((a) => /^--extcmd(=|$)/.test(a) || shortWith(a, "x", { not: "t" }) !== null)) ||
    sub === "filter-branch" ||
    sub === "send-email" ||
    sub === "instaweb" ||
    (sub === "grep" && opts.some((a) => /^--open-files-in-pager(=|$)/.test(a) || shortWith(a, "O") !== null)) ||
    opts.some((a) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(a)) ||
    (["clone", "init"].includes(sub) && opts.some((a) => /^--template(=|$)/.test(a))) ||
    (["clone", "ls-remote"].includes(sub) && opts.some((a) => shortWith(a, "u", { not: "obcj" }) !== null));
  if (exec) block(GIT_EXEC_MSG);

  // 3) 設定の書き込み（git config <key> <value> など）と、clone の -c / --config
  if (sub === "config") {
    const readMode = opts.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l|--show-origin|--show-scope|--name-only|--null|-z)$/.test(a)) || ["get", "list"].includes(args[0]);
    if (opts.some((a) => /^(-e|--edit)$/.test(a)) || args[0] === "edit") block("git config --edit（エディタで設定を開く）は使わない。");
    const pos = positionals(args, ["-f", "--file", "--blob", "--type", "--default", "--comment"]);
    const verbs = ["set", "unset", "rename-section", "remove-section", "get", "list"];
    const keys = verbs.includes(pos[0]) ? pos.slice(1, 2) : pos.slice(0, 1);
    const writes = !readMode && (["set", "unset", "rename-section", "remove-section"].includes(pos[0]) || opts.some((a) => /^--(add|replace-all|unset|unset-all|rename-section|remove-section)$/.test(a)) || pos.length >= 2);
    if (writes) {
      for (const k of keys) checkGitKey(k, "config");
      for (const f of optionValues(args, ["-f", "--file"])) write(f, false, "設定ファイル");
    }
  }
  if (sub === "clone") for (const v of optionValues(args, ["-c", "--config"])) checkGitKey(v, "clone --config");

  // 4) 書き込み先を指定するオプションと引数（リダイレクトと同じ判定。-C を解いてから）
  for (let k = 0; k < opts.length; k++) {
    const a = opts[k];
    const m = a.match(/^--(out(?:p(?:u(?:t)?)?)?|output-d(?:i(?:r(?:e(?:c(?:t(?:o(?:r(?:y)?)?)?)?)?)?)?)?)(?:=(.*))?$/s);
    if (m) {
      write(m[2] !== undefined ? m[2] : opts[++k], m[1].startsWith("output-d"), "出力先");
      continue;
    }
    if (["format-patch", "archive", "index-pack"].includes(sub)) {
      const rest = shortWith(a, "o");
      if (rest !== null) write(rest || opts[++k], sub === "format-patch", "出力先");
    }
  }
  if (sub === "bundle" && args[0] === "create") write(positionals(args.slice(1), ["--version"])[0], false, "出力先");
  if (sub === "clone") {
    const [repoArg, dirArg] = positionals(args, ["-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--reference", "--reference-if-able", "--separate-git-dir", "--depth", "--shallow-since", "--shallow-exclude", "-c", "--config", "--server-option", "-j", "--jobs", "--filter", "--bundle-uri", "--template", "--ref-format"]);
    write(dirArg ?? humanish(repoArg), true, "置き場所");
    for (const d of optionValues(args, ["--separate-git-dir"])) write(d, true, "置き場所");
  }
  if (sub === "init") {
    write(positionals(args, ["-b", "--initial-branch", "--object-format", "--ref-format", "--separate-git-dir", "--template"])[0], true, "置き場所");
    for (const d of optionValues(args, ["--separate-git-dir"])) write(d, true, "置き場所");
  }
  if (sub === "worktree" && ["add", "move"].includes(args[0])) {
    const p = positionals(args.slice(1), ["-b", "-B", "--reason"]);
    write(args[0] === "add" ? p[0] : p[1], true, "置き場所");
  }
  if (sub === "submodule" && args.includes("add")) {
    const p = positionals(args.slice(args.indexOf("add") + 1), ["-b", "--branch", "--name", "--reference", "--depth"]);
    write(p[1] ?? humanish(p[0]), true, "置き場所");
  }
  if (sub === "checkout-index") {
    const prefix = optionValues(args, ["--prefix"])[0] ?? "";
    if (opts.some((a) => /^(-a|--all|--stdin)$/.test(a))) write(prefix || ".", true, "書き込み先");
    for (const p of positionals(args, [])) write(`${prefix}${p}`, false, "書き込み先");
  }
  if (sub === "merge-file" && !opts.some((a) => /^(-p|--stdout)$/.test(a))) write(positionals(args, ["-L", "--marker-size", "--diff-algorithm"])[0], false, "書き込み先");
  if (sub === "fast-import") for (const f of optionValues(args, ["--export-marks", "--export-pack-edges"])) write(f, false, "出力先");

  // git apply・git am: パッチの中身の書き込み先（--check などの確かめるだけのものは除く）
  if (["apply", "am"].includes(sub) && !(sub === "apply" && opts.some((a) => /^--(check|stat|numstat|summary)$/.test(a)) && !opts.includes("--apply"))) {
    const files = positionals(args, ["--directory", "--exclude", "--include", "--build-fake-ancestor", "-p", "-C", "--whitespace", "--patch-format", "--resolvemsg", "-S", "--gpg-sign", "--quoted-cr", "--empty"]).filter((x) => x !== "-");
    const texts = files.length ? files.map((f) => readSmall(base, f)) : stdinSources(tk, base);
    if (texts === null) block(`git ${sub} に、中身の分からない標準入力からパッチを渡さない（パッチのファイルを指定する）。`);
    const prefix = (optionValues(args, ["--directory"])[0] ?? "").replace(/\/*$/, (x) => (x || "") && "/");
    for (const t of texts) if (t !== null) checkPatch(base, t, `git ${sub} での書き込み`, prefix ? `${prefix.replace(/\/+$/, "")}/` : "");
    for (const f of optionValues(args, ["--build-fake-ancestor"])) write(f, false, "出力先");
  }
  if (ROLE === "implementer" && ["switch", "checkout", "reset", "rebase", "merge", "worktree", "config", "remote", "fetch", "pull", "push", "tag", "update-ref", "symbolic-ref", "filter-branch", "replace", "apply", "am", "clone", "init", "submodule", "bisect", "checkout-index", "read-tree", "update-index"].includes(sub))
    block(`ランナーの作業ディレクトリでは git ${sub} を使わない（ブランチ・履歴・設定はランナーが管理する）。ファイルを変更するところまでにする。`);
  if (ROLE === "implementer" && sub === "rm") checkRemoval(base, args);
  if (["checkout", "restore", "rm", "mv", "apply", "stash"].includes(sub)) {
    for (const a of positionals(args, ["-s", "--source", "-m", "--message", "--pathspec-from-file"])) {
      const rel = relOf(base, a);
      if (rel && (isProtectedStateFile(rel) || /^\.git(\/|$)/.test(rel))) block(`git ${sub} で ${rel}（devkit が管理するファイル・.git の中）を書き換えない。`);
    }
  }
  if (sub === "read-tree" && opts.some((a) => /^(-u|--reset|--prefix)/.test(a))) block("git read-tree -u（作業ツリーへの書き込み）は使わない。");
  if (sub === "reset" && has("--hard", "--merge")) lose(`git reset ${args.join(" ")}`);
  if (sub === "checkout" && (has("--", ".", "--force") || shortFlag("f"))) lose(`git checkout ${args.join(" ")}`);
  if (sub === "restore" && (!has("--staged", "-S") || has("--worktree", "-W"))) lose(`git restore ${args.join(" ")}`);
  if (sub === "clean" && (has("--force") || shortFlag("f"))) lose(`git clean ${args.join(" ")}`);
  if (sub === "stash" && ["drop", "clear"].includes(args[0])) lose(`git stash ${args[0]}`);
  if (sub === "switch" && (has("--discard-changes", "--force") || shortFlag("f"))) lose(`git switch ${args.join(" ")}`);
  if (sub === "branch" && (shortFlag("D") || (has("-d", "--delete") && (has("--force") || shortFlag("f"))))) lose(`git branch ${args.join(" ")}`);
  if (sub === "worktree" && args[0] === "remove" && (has("--force") || shortFlag("f"))) lose(`git worktree remove ${args.join(" ")}`);
  if (sub === "push") {
    if (isWorker) block("並列ワーカーは push しない。push と PR はメインセッションが利用者の確認を得て行う。");
    if (has("--force", "--mirror", "--delete", "--prune") || shortFlag("f") || shortFlag("d") || args.some((a) => /^--force-with-lease/.test(a) || /^[+:]/.test(a)))
      block("強制 push・ブランチ削除の push はしない。人が行う。");
    if (args.some((a) => /(^|:)(refs\/heads\/)?(main|master)$/.test(a))) block("main への push はしない。統合ブランチを push して PR にし、マージは人が行う。");
  }
  if (isWorker && ["commit"].includes(sub) && /--amend/.test(seg)) block("並列ワーカーは --amend で履歴を書き換えない。");
}

check(command, cwd, 0);

// 通したコマンドは、実行中の目印を残す（メインのセッションとそのサブエージェント。ランナーの AI は、人のコマンドを別の方法で断る）。
// 人のコマンド（承認など）は、Claude Code の入力欄の ! からなら受け付けるが、この目印がある間は断る
// （Claude の Bash からの実行と見分けるため）。終わったら bash-done.mjs が消す。消されなかった目印は、期限で無効になる
if (!ROLE) {
  try {
    const dir = bashMarkerDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      try {
        if (JSON.parse(readFileSync(join(dir, f), "utf8")).until < now) rmSync(join(dir, f), { force: true });
      } catch {
        rmSync(join(dir, f), { force: true });
      }
    }
    const bg = Boolean(input.tool_input?.run_in_background);
    const timeout = Math.min(Math.max(Number(input.tool_input?.timeout) || 120_000, 1_000), 600_000);
    const until = now + (bg ? 600_000 : timeout + 5_000);
    writeFileSync(join(dir, bashMarkerName(input.session_id, input.tool_use_id)), JSON.stringify({ at: now, until, background: bg, cwd, command: command.slice(0, 200) }));
  } catch {}
}
process.exit(0);
