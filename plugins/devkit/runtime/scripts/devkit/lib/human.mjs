// 人の操作（承認・差し戻し・回答・上限の追加・記録）を受け付けるための確認と、判断の記録。
//
// 確かめること（どれか1つでも当てはまれば断る）:
//   - ランナーが起動した AI か（DEVKIT_RUNNER / DEVKIT_ROLE）
//   - Claude Code の中から実行されたか（CLAUDECODE などの環境変数、親のプロセスに claude がいる）。
//     中からの実行は、入力欄の ! からのものだけを受け付ける（Claude の Bash が実行中でないこと。bangProblem）
//   - 端末から実行されたか（標準入力が端末。Windows の Git Bash などでは DEVKIT_HUMAN_TTYLESS=1）
//   - 画面に出した確認の番号を、人が打ち込んだか
// 同じ利用者の権限で動くプログラムを完全に見分けることはできない。承認の記録は、CODEOWNERS とブランチ保護で
// 人のレビューを通すことと組み合わせて使う（docs/rollout.md の 7）。
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { bashMarkerDir, findRepoRoot, ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import { commitArgs, git } from "./git.mjs";
import { journalWrite } from "./seal.mjs";
import { fail, localTime, nowIso, readJson, readText } from "./util.mjs";

const CLAUDE_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SESSION_ID"];

// 親をたどって、Claude Code のプロセスがいないか（Linux は /proc、macOS などは ps）。
// 見るのは実行ファイル（と、node などで動かしているスクリプト）だけ。引数の文章は見ない
// （--note "原因は Claude の利用上限…" のように、メモに Claude と書いただけで断らないように）
const CLAUDE_BIN = /(^|[\\/])claude(\.exe)?$/i;
const CLAUDE_PATH = /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js|[\\/]claude[\\/]versions[\\/]/i;
const RUNTIMES = /(^|[\\/])(node|nodejs|bun|deno)(\.exe)?$/i;

export function isClaudeProcess({ comm = "", argv = [] } = {}) {
  const exe = String(argv[0] ?? "");
  if (CLAUDE_BIN.test(String(comm).trim()) || CLAUDE_BIN.test(exe) || CLAUDE_PATH.test(exe)) return true;
  if (RUNTIMES.test(exe) || RUNTIMES.test(String(comm).trim())) {
    const script = argv.slice(1).find((x) => !String(x).startsWith("-"));
    if (script && (CLAUDE_BIN.test(script) || CLAUDE_PATH.test(script))) return true;
  }
  return false;
}

export function claudeAncestor(startPid = process.ppid) {
  let pid = startPid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const info = procInfo(pid);
    if (!info) return null;
    if (isClaudeProcess(info)) return `${info.comm}（pid ${pid}）`;
    pid = info.ppid;
  }
  return null;
}

function procInfo(pid) {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const ppid = Number(status.match(/^PPid:\s*(\d+)/m)?.[1] ?? 0);
      const comm = status.match(/^Name:\s*(.+)$/m)?.[1]?.trim() ?? "";
      let argv = [];
      try {
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      } catch {}
      return { ppid, comm, argv };
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  // ps は引数を空白でつなげて返す。実行ファイルと、その次の語（node で動かしているスクリプト）までを見る
  const a = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return { ppid: Number(m[1]), comm: m[2], argv: (a.stdout ?? "").trim().split(/\s+/).slice(0, 3) };
}

// Claude Code の入力欄の ! からの実行として受け付けられない理由（受け付けられるなら null）。
// ! で実行したコマンドも Claude Code の子プロセスなので、環境変数と親のプロセスでは Claude の Bash と見分けられない。
// 見分けるのは、Claude の Bash の前に必ず動くフック（guard-bash）が残す「実行中」の目印:
//   - 案件の .claude/settings.json に guard-bash が登録されていて、フックが無効にされていない
//   - いま実行中の Claude の Bash がない（目印がない）
// 人のコマンドそのものを Claude が Bash で実行しようとした場合は、guard-bash が実行の前に止める
export function bangProblem(root = process.env.DEVKIT_ROOT || findRepoRoot(process.cwd())?.root || process.cwd()) {
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  let home = "";
  try {
    home = userInfo().homedir;
  } catch {}
  const project = read(join(root, ".claude", "settings.json"));
  const registered = (project?.hooks?.PreToolUse ?? []).some(
    (e) => /(^|\|)Bash(\||$)/.test(String(e?.matcher ?? "")) && (e?.hooks ?? []).some((h) => /guard-bash\.mjs/.test(`${h?.command ?? ""} ${(h?.args ?? []).join(" ")}`)),
  );
  if (!registered) return "案件の .claude/settings.json に devkit のガード（guard-bash）が登録されていません";
  const off = [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json"), home ? join(home, ".claude", "settings.json") : null].filter(Boolean).find((f) => read(f)?.disableAllHooks === true);
  if (off) return `フックが無効にされています（${off} の disableAllHooks）`;
  const dir = bashMarkerDir();
  const now = Date.now();
  let live = [];
  try {
    live = readdirSync(dir)
      .map((f) => read(join(dir, f)))
      .filter((m) => m && Number(m.until) > now);
  } catch {}
  if (live.length) {
    const wait = Math.ceil((Math.max(...live.map((m) => Number(m.until))) - now) / 1000);
    return `Claude が Bash のコマンドを実行中です（${live.some((m) => m.background) ? "バックグラウンドのコマンドを含む。" : ""}長くてあと約 ${wait} 秒）。Claude の手が止まってから、もう一度 ! で実行してください`;
  }
  return null;
}

export function claudeMarkers() {
  for (const k of CLAUDE_ENV) if (process.env[k]) return `環境変数 ${k}`;
  // テストだけが使う抜け道（Claude のコマンドではガードが止める）
  if (process.env.DEVKIT_HUMAN_TEST === "1") return null;
  const a = claudeAncestor();
  return a ? `親のプロセス ${a}` : null;
}

// 画面に出した番号を打ち込んでもらう
function confirmTyped(what, detail = "") {
  if (process.env.DEVKIT_HUMAN_TEST === "1") return;
  const code = String(Math.floor(1000 + Math.random() * 9000));
  let fd = null;
  let own = false;
  try {
    if (process.platform !== "win32" && existsSync("/dev/tty")) {
      fd = openSync("/dev/tty", "r+");
      own = true;
    }
  } catch {
    fd = null;
  }
  const inFd = fd ?? 0;
  const prompt = `\n${detail ? `${detail}\n` : ""}${what} を実行します。確認のため、次の番号を入力して Enter: ${code}\n> `;
  try {
    if (fd !== null) writeSync(fd, prompt);
    else process.stderr.write(prompt);
    const buf = Buffer.alloc(64);
    let line = "";
    for (;;) {
      let n = 0;
      try {
        n = readSync(inFd, buf, 0, buf.length, null);
      } catch (e) {
        if (e.code === "EAGAIN") continue;
        break;
      }
      if (n <= 0) break;
      line += buf.subarray(0, n).toString("utf8");
      if (line.includes("\n") || line.length > 32) break;
    }
    if (line.trim() !== code) fail("確認の番号が一致しないので、実行しませんでした", 5);
  } finally {
    if (own) closeSync(fd);
  }
}

// 人が端末で実行しているか。合わなければ理由を示して終える。detail は確認の番号の前に見せる説明（何に対する操作か）
export function requireHuman(what, { detail = "" } = {}) {
  if (process.env.DEVKIT_RUNNER === "1" || process.env.DEVKIT_ROLE)
    fail(`${what} は人が端末で実行するコマンドです。ランナーが起動した AI からは実行できません。`, 5);
  const claude = claudeMarkers();
  if (claude) {
    // Claude Code の中: 入力欄の ! からの実行だけを受け付ける（Claude の Bash からの実行は断る）。番号の確認はしない（! では打ち込めない）
    const why = bangProblem();
    if (why)
      fail(
        `${what} は人が実行するコマンドです。Claude Code の中から実行されましたが（${claude}）、入力欄の ! からの実行と確かめられませんでした: ${why}。Claude からは実行できません。Claude Code の入力欄で \`! pnpm devkit ${what}\` と打つか、別の端末で実行してください。`,
        5,
      );
    process.stderr.write(`[devkit] Claude Code の入力欄（!）からの実行として受け付けます: ${what}\n`);
    return;
  }
  if (!process.stdin.isTTY && process.env.DEVKIT_HUMAN_TTYLESS !== "1")
    fail(`${what} は人が端末で実行するコマンドです。Claude からは実行しません。利用者に、端末で \`pnpm devkit ${what}\` を実行するよう伝えてください。`, 5);
  confirmTyped(`pnpm devkit ${what}`, detail);
}

export function identity(ctx, by) {
  const name = (typeof by === "string" && by.trim()) || git(ctx.root, ["config", "user.name"]).out || safeUser();
  const email = git(ctx.root, ["config", "user.email"]).out || "";
  return { name, email };
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// 承認する人が、その役割の担当者として docs/profile.json に載っているか。代理は --delegate-of と --note で明示する。
// 担当者が書かれていない（空）ときは、誰が承認してよいか分からないので断る。
export function checkOwner(ctx, role, who, { delegateOf = null, note = "" } = {}) {
  const profile = readJson(ctx.profile, null);
  const owners = (profile?.owners?.[role] ?? []).filter((o) => o && (o.email || o.name));
  if (!owners.length)
    fail(`docs/profile.json の owners.${role}（${ROLE_PERSON[role]}）が空なので、承認できません。担当者の名前と git のメールを書いてコミットしてから実行してください。`);
  if (!who.email) fail("git の user.email が設定されていません（承認した人を docs/profile.json の担当者と照合します）。git config user.email を設定してください。");
  const same = (o) => (o.email && o.email.toLowerCase() === who.email.toLowerCase()) || (!o.email && o.name && o.name === who.name);
  const owner = owners.find(same);
  if (owner) {
    // 記録には、担当者として登録された名前を使う（git の user.name と違っていても、照合したのはメール）
    if (owner.name) who.name = owner.name;
    return { ok: true };
  }
  if (delegateOf) {
    if (!String(note).trim()) fail("代理で判断するときは --note に理由を書いてください（判断の記録に残します）");
    const principal = owners.find((o) => o.name === delegateOf || o.email === delegateOf);
    if (!principal) fail(`--delegate-of「${delegateOf}」は docs/profile.json の owners.${role} にいません`);
    return { ok: true, delegateOf: principal.name || principal.email };
  }
  fail(
    `${who.name}（${who.email}）は ${ROLE_PERSON[role]}として docs/profile.json の owners.${role} に載っていません。` +
      `本人が実行するか、代理なら --delegate-of <本人の名前> --note "<理由>" を付けてください。`,
  );
}

const HEADER = "| 日時 | 役割 | 判断者 | 対象 | 判断 | 対象のコミット | 内容 |";

function cell(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replaceAll("|", "／")
    .trim();
}

// docs/decisions.md に1行追記する（書く前に journal に残すので、ランナーの封印が人の記録と分かる）
export function recordDecision(ctx, { role, who, target, decision, sha = "", content = "", delegateOf = null, command = "record" }) {
  let text = readText(ctx.decisions);
  if (!text.includes(HEADER)) text = `${text.trimEnd()}\n\n# 判断の記録\n\n${HEADER}\n| --- | --- | --- | --- | --- | --- | --- |\n`;
  const byWho = delegateOf ? `${who.name}（${delegateOf} の代理）` : who.name;
  const line = `| ${localTime(nowIso())} | ${role ? ROLE_LABEL[role] : "-"} | ${cell(byWho)} | ${cell(target)} | ${cell(decision)} | ${cell(sha ? sha.slice(0, 10) : "")} | ${cell(content)} |`;
  journalWrite(ctx, "docs/decisions.md", `${text.trimEnd()}\n${line}\n`, command);
  return line;
}

export function commitPaths(ctx, paths, message) {
  const existing = paths.filter((p) => existsSync(`${ctx.root}/${p}`));
  if (!existing.length) return false;
  git(ctx.root, ["add", "--", ...existing]);
  const staged = git(ctx.root, ["diff", "--cached", "--name-only", "--", ...existing]).out;
  if (!staged) return false;
  const r = git(ctx.root, [...commitArgs(ctx.root, message), "--", ...existing]);
  if (r.code !== 0) fail(`コミットに失敗しました: ${r.err || r.out}`);
  return true;
}
