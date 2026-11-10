// 人の操作（承認・差し戻し・回答・上限の追加・記録）を受け付けるための確認と、判断の記録。
//
// 確かめること（どれか1つでも当てはまれば断る）:
//   - ランナーが起動した AI か（DEVKIT_RUNNER / DEVKIT_ROLE）
//   - Claude Code の中から実行されたか（CLAUDECODE などの環境変数、親のプロセスに claude がいる）
//   - 端末から実行されたか（標準入力が端末。Windows の Git Bash などでは DEVKIT_HUMAN_TTYLESS=1）
//   - 画面に出した確認の番号を、人が打ち込んだか
// 同じ利用者の権限で動くプログラムを完全に見分けることはできない。承認の記録は、CODEOWNERS とブランチ保護で
// 人のレビューを通すことと組み合わせて使う（docs/rollout.md の 7）。
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import { commitArgs, git } from "./git.mjs";
import { journalWrite } from "./seal.mjs";
import { fail, localTime, nowIso, readJson, readText } from "./util.mjs";

const CLAUDE_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SESSION_ID"];

// 親をたどって、Claude Code のプロセスがいないか（Linux は /proc、macOS などは ps）
export function claudeAncestor(startPid = process.ppid) {
  let pid = startPid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const info = procInfo(pid);
    if (!info) return null;
    const text = `${info.comm} ${info.args}`;
    if (/(^|[\s/\\])claude(\.exe)?(\s|$)/i.test(text) || /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js/i.test(text)) return `${info.comm}（pid ${pid}）`;
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
      let args = "";
      try {
        args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      } catch {}
      return { ppid, comm, args };
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  const a = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return { ppid: Number(m[1]), comm: m[2], args: (a.stdout ?? "").trim() };
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
  if (claude)
    fail(
      `${what} は人が端末で実行するコマンドです。Claude Code の中からは実行できません（${claude}。入力欄の ! で実行しても同じです）。Claude Code を動かしているのとは別の端末で \`pnpm devkit ${what}\` を実行してください。`,
      5,
    );
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
