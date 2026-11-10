// 人の判断（承認・差し戻し・回答・再計画の案・標準の例外）を受け付けて記録する関数。
//
// 端末のコマンド（devkit.mjs）と、パスキーで署名された決定（lib/envelope.mjs。ローカルのコンソールとハブ）が、
// 同じ関数を通る。違うのは「人である証明」（presence）だけ:
//   - tty:     今までの方式。端末で、画面に出した番号を打ち込む（lib/human.mjs の requireHuman）。判断者は git の設定から
//   - passkey: 本人のパスキーの署名を検証済み（lib/envelope.mjs）。判断者は決定の本体から。代理は受け付けない
// どちらも、役割・対象の版・担当者の照合と、controls.json・journal・docs/decisions.md への書き込みは同じ。
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { normalizeRole, ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import { checkOwner, commitPaths, identity, recordDecision, requireHuman } from "./human.mjs";
import {
  applyHumanDecisions,
  classifyPlanChange,
  gateKey,
  loadConfig,
  loadControls,
  loadGraph,
  loadState,
  nodeKey,
  normalizeGraph,
  PLAN_APPROVERS,
  pendingRoles,
  planHash,
  proposalNeededRoles,
  proposalRoles,
  requestId,
  requestRole,
  requiredRoles,
  saveState,
  updateControls,
  validate,
} from "./model.mjs";
import { writeStatusHtml } from "./report.mjs";
import { journalWrite } from "./seal.mjs";
import { appendProgress, runnerAlive } from "./status.mjs";
import { fail, localStamp, nowIso, readJson } from "./util.mjs";
import { checkout, removeCheckout, runChecker } from "./verify.mjs";

// ---------- 人である証明 ----------

export const ttyPresence = { kind: "tty", tag: "", confirm: requireHuman, who: (ctx, by) => identity(ctx, by) };

// 署名を検証した決定（envelope.mjs が作る）。source は「コンソール」か「ハブ」
export function passkeyPresence({ id, source, who }) {
  return { kind: "passkey", tag: `${source}（パスキー）・${id}`, id, confirm() {}, who: () => ({ name: who.name, email: who.email }) };
}

const stdio = { out: (text) => console.log(text) };

// journal のコマンド名と判断の記録に、証明の種類を残す（端末は今までどおり）
export function journalLabel(p, command) {
  return p.kind === "tty" ? command : `${command} [${p.kind} ${p.id}]`;
}

export function recordWith(ctx, p, fields) {
  const content = p.tag ? [fields.content, `［${p.tag}］`].filter(Boolean).join(" ") : fields.content;
  return recordDecision(ctx, { ...fields, content, command: journalLabel(p, fields.command ?? "record") });
}

export function checkOwnerWith(ctx, p, r, who, o) {
  if (p.kind !== "tty" && o.delegateOf) fail("パスキーで署名した決定では、代理（--delegate-of）は受け付けません（代理は端末で）");
  return checkOwner(ctx, r, who, o);
}

function role(opts) {
  const r = normalizeRole(opts.role);
  if (!r) fail('--role は「業務」か「技術」（business / technical）を指定してください');
  return r;
}

function note(opts, required = false) {
  const n = typeof opts.note === "string" ? opts.note.trim() : "";
  if (required && !n) fail('--note "…" を指定してください（判断の記録に残します）');
  return n;
}

// ランナーが止まっていれば、人の決定をその場で状態に反映してコミットする（動いていればランナーが次の手で反映する）
export function applyNowIfIdle(ctx, io, message, journalCmd) {
  if (runnerAlive(ctx).alive) {
    io.out("ランナーが実行中なので、次の手で反映されます。");
    return;
  }
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  const notes = updateControls(ctx, (c) => applyHumanDecisions(g, s, c), { journal: journalCmd });
  saveState(ctx, s, { journal: journalCmd });
  for (const n of notes) appendProgress(ctx, n);
  try {
    writeStatusHtml(ctx);
  } catch {}
  commitPaths(ctx, [".devkit/state.json", ".devkit/controls.json", ".devkit/progress.md", ".devkit/requests", ".devkit/graph.json", ".devkit/journal.jsonl", ".devkit/decisions", "docs/decisions.md"], message);
  if (s.outer === "running") io.out("続きは `pnpm devkit run`（夜間に回すなら `pnpm devkit run --until 07:00 --detach`）");
}

// ---------- 判断 ----------

export function approve(ctx, { pos = [], opts = {} }, p = ttyPresence, io = stdio) {
  const [target] = pos;
  if (!target) fail("使い方: approve plan --role <業務|技術> ／ approve <マイルストーン> --role … ／ approve <ノード> --before --role …");
  p.confirm(`approve ${target}`);
  const r = role(opts);
  const who = p.who(ctx, opts.by);
  const owner = checkOwnerWith(ctx, p, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
  if (owner.warning) io.out(`注意: ${owner.warning}`);
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);

  if (target === "plan") {
    const c = loadControls(ctx);
    const { errors } = validate(ctx, g, { controls: c });
    if (errors.length) fail(`計画に問題があるので承認できません（pnpm devkit check）:\n${errors.slice(0, 10).map((e) => `  - ${e}`).join("\n")}`);
    const hash = planHash(ctx);
    const res = updateControls(
      ctx,
      (cc) => {
        cc.plan.approvals[r] = { hash, by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null };
        const all = PLAN_APPROVERS.every((x) => cc.plan.approvals[x]?.hash === hash);
        if (all) {
          cc.plan.approvedHash = hash;
          cc.plan.history.push({ type: "human-approval", hash, at: nowIso(), by: PLAN_APPROVERS.map((x) => cc.plan.approvals[x].by) });
        }
        return all;
      },
      { journal: journalLabel(p, "approve plan") },
    );
    recordWith(ctx, p, { role: r, who, target: `計画（${g.mission}）`, decision: "承認", sha: hash, content: note(opts), delegateOf: owner.delegateOf, command: "approve plan" });
    commitPaths(ctx, [".devkit/graph.json", ".devkit/mission.md", g.spec.split("#")[0], ".devkit/controls.json", ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 計画の${ROLE_LABEL[r]}承認`);
    io.out(res ? "計画の承認がそろいました。Claude に「開始して」と伝えるか、pnpm devkit start → pnpm devkit run" : `${ROLE_PERSON[r]}として承認しました。残り: ${PLAN_APPROVERS.filter((x) => x !== r).map((x) => ROLE_PERSON[x]).join("・")}の承認`);
    return;
  }

  if (opts.before) {
    const n = g.nodes.find((x) => x.id === target);
    if (!n) fail(`ノード ${target} がありません`);
    const c = loadControls(ctx);
    const roles = requiredRoles(c, gateKey("before", n.id), n.before);
    if (!roles.includes(r)) fail(`${target} の着手前に${ROLE_PERSON[r]}の承認は要りません（必要: ${roles.map((x) => ROLE_PERSON[x]).join("・") || "なし"}）`);
    updateControls(
      ctx,
      (cc) => {
        cc.approvals[gateKey("before", n.id)] ??= {};
        // ノードの定義に紐づける（再計画で定義が変わったら、承認は取り直しになる）
        cc.approvals[gateKey("before", n.id)][r] = { sha: nodeKey(n), by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null };
      },
      { journal: journalLabel(p, "approve --before") },
    );
    recordWith(ctx, p, { role: r, who, target: `${n.id}「${n.title}」の着手`, decision: "承認", content: note(opts), delegateOf: owner.delegateOf, command: "approve --before" });
    applyNowIfIdle(ctx, io, `devkit: ${n.id} 着手前の${ROLE_LABEL[r]}承認`, journalLabel(p, "approve --before"));
    io.out(`${n.id} の着手を承認しました`);
    return;
  }

  const m = g.milestones.find((x) => x.id === target);
  if (!m) fail(`マイルストーン ${target} がありません（ノードの着手前の承認なら --before）`);
  const ms = s.milestones[m.id];
  if (ms.status !== "awaiting_approval") fail(`${target} は承認待ちではありません（${ms.status}）`);
  const c = loadControls(ctx);
  const roles = requiredRoles(c, m.id, ms.required ?? []);
  if (!roles.includes(r)) fail(`${target} に${ROLE_PERSON[r]}の承認は要りません（必要: ${roles.map((x) => ROLE_PERSON[x]).join("・")}）`);
  if (!pendingRoles(c, m.id, [r], { sha: ms.head }).length) fail(`${target} は${ROLE_PERSON[r]}が承認済みです`);
  let forced = false;
  if (m.release && r === "technical") {
    // リリース前検査は、承認の対象の版（検証したコミット）で行う
    const co = checkout(ctx, loadConfig(ctx), "approve", ms.head);
    const rel = runChecker(ctx, co, { release: true });
    removeCheckout(ctx, co);
    if (rel.violations.length) {
      for (const v of rel.violations) io.out(`✗ [${v.rule}] ${v.file ? `${v.file} — ` : ""}${v.message}`);
      if (!opts.force) fail("リリース前検査が通っていません。直してから承認してください（やむを得ない場合は --force と --note で理由を残す）");
      note(opts, true);
      forced = true;
    }
  }
  if (!ms.head) fail(`${target} には検証したコミットの記録がないので承認できません（ランナーの全体検証からやり直す）`);
  updateControls(
    ctx,
    (cc) => {
      cc.approvals[m.id] ??= {};
      cc.approvals[m.id][r] = { sha: ms.head, by: who.name, email: who.email, at: nowIso(), note: note(opts), delegateOf: owner.delegateOf ?? null, ...(forced ? { forced: true } : {}) };
    },
    { journal: journalLabel(p, "approve") },
  );
  recordWith(ctx, p, { role: r, who, target: `${m.id}「${m.title}」`, decision: forced ? "承認（リリース前検査が未達のまま）" : "承認", sha: ms.head, content: note(opts), delegateOf: owner.delegateOf, command: "approve" });
  applyNowIfIdle(ctx, io, `devkit: ${m.id} の${ROLE_LABEL[r]}承認`, journalLabel(p, "approve"));
  const left = pendingRoles(loadControls(ctx), m.id, roles, { sha: ms.head });
  io.out(left.length ? `${ROLE_PERSON[r]}として承認しました。残り: ${left.map((x) => ROLE_PERSON[x]).join("・")}` : `${m.id} の承認がそろいました`);
}

export function reject(ctx, { pos = [], opts = {} }, p = ttyPresence, io = stdio) {
  const [target] = pos;
  const r = role(opts);
  const text = note(opts, true);
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  const m = g.milestones.find((x) => x.id === target);
  if (!m) fail(`マイルストーン ${target} がありません`);
  const ms = s.milestones[m.id];
  if (ms.status !== "awaiting_approval") fail(`${target} は承認待ちではありません（${ms.status}）`);
  // 差し戻せるのは、そのマイルストーンの承認者の役割だけ（承認と同じ）
  const roles = requiredRoles(loadControls(ctx), m.id, ms.required ?? []);
  if (!roles.includes(r))
    fail(`${target} の承認者は${roles.map((x) => ROLE_PERSON[x]).join("・") || "いません"}です。${ROLE_PERSON[r]}は ${target} を差し戻せません（意見は承認者に伝えてください）`);
  p.confirm(`reject ${target}`, { detail: `${m.id}「${m.title}」（検証したコミット ${String(ms.head ?? "").slice(0, 10) || "なし"}）を${ROLE_PERSON[r]}として差し戻します` });
  const who = p.who(ctx, opts.by);
  const owner = checkOwnerWith(ctx, p, r, who, { delegateOf: opts["delegate-of"], note: text });
  updateControls(
    ctx,
    (cc) => {
      cc.rejections ??= {};
      cc.rejections[m.id] = { role: r, note: text, by: who.name, email: who.email, at: nowIso(), sha: ms.head, applied: false };
    },
    { journal: journalLabel(p, "reject") },
  );
  recordWith(ctx, p, { role: r, who, target: `${m.id}「${m.title}」`, decision: "差し戻し", sha: ms.head, content: text, delegateOf: owner.delegateOf, command: "reject" });
  applyNowIfIdle(ctx, io, `devkit: ${m.id} を${ROLE_LABEL[r]}が差し戻し`, journalLabel(p, "reject"));
  io.out(`${m.id} を差し戻しました。ランナーが指摘を再計画に渡して直します（pnpm devkit run）`);
}

export function answer(ctx, { pos = [], opts = {} }, p = ttyPresence, io = stdio) {
  const [id] = pos;
  const r = role(opts);
  const text = note(opts, true);
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  const ns = s.nodes[id];
  if (!ns?.request || ns.status !== "blocked") fail(`${id ?? "<ノード>"} には回答待ちの判断依頼がありません`);
  // 回答は、今の判断依頼（ID）に、依頼の種別の役割が答えるものだけを受け付ける
  const rid = requestId(id, ns.request);
  const want = requestRole(ns.request);
  const asked = typeof opts.request === "string" ? opts.request.trim() : "";
  if (opts.request !== undefined && !asked) fail("--request には判断依頼の ID（.devkit/requests/<ノード>.md の先頭）を指定してください");
  if (asked && asked !== rid) fail(`${id} で回答待ちの判断依頼は ${rid} です（${asked} は回答済みか、別の依頼）。.devkit/requests/${id}.md を確かめてください`);
  if (r !== want)
    fail(
      `${id} の判断依頼 ${rid}（${ns.request.condition}）は${ROLE_PERSON[want]}が回答します。${ROLE_PERSON[r]}の回答は受け付けません` +
        `（${ROLE_PERSON[want]}が pnpm devkit answer ${id} --role ${ROLE_LABEL[want]} --request ${rid} --note "…" を実行します）`,
    );
  p.confirm(`answer ${id}`, { detail: `判断依頼 ${rid}（${ns.request.condition}、${ROLE_PERSON[want]}が回答）: ${String(ns.request.what ?? "").slice(0, 300)}` });
  const who = p.who(ctx, opts.by);
  const owner = checkOwnerWith(ctx, p, r, who, { delegateOf: opts["delegate-of"], note: text });
  updateControls(
    ctx,
    (cc) => {
      cc.answers[id] ??= [];
      cc.answers[id].push({ request: rid, role: r, note: text, by: who.name, email: who.email, at: nowIso(), delegateOf: owner.delegateOf ?? null, applied: false });
    },
    { journal: journalLabel(p, "answer") },
  );
  recordWith(ctx, p, { role: r, who, target: `${id} の判断依頼 ${rid}（${ns.request.condition}）`, decision: "回答", content: text, delegateOf: owner.delegateOf, command: "answer" });
  const reqFile = join(ctx.requests, `${id}.md`);
  if (existsSync(reqFile)) renameSync(reqFile, join(ctx.requests, `${id}-answered-${localStamp()}.md`));
  applyNowIfIdle(ctx, io, `devkit: ${id} の判断依頼に回答`, journalLabel(p, "answer"));
  io.out(`${id} に回答しました`);
}

export function proposal(ctx, { pos = [], opts = {} }, p = ttyPresence, io = stdio) {
  const [sub, id] = pos;
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  if (!sub || sub === "list") {
    for (const p of s.proposals ?? []) io.out(`${p.id}\t${p.status}\t${(p.reasons ?? []).join(" / ")}`);
    return;
  }
  const file = join(ctx.proposals, `${id}.json`);
  const doc = readJson(file, null);
  if (!doc) fail(`再計画の案 ${id} がありません`);
  if (sub === "show") return io.out(JSON.stringify(doc, null, 2));
  if (!["accept", "reject"].includes(sub)) fail("使い方: proposal list | show <ID> | accept <ID> --role 技術 [--note] | reject <ID> --role 技術 --note …");
  const entry = (s.proposals ?? []).find((p) => p.id === id);
  if (!entry || entry.status !== "needs_human") fail(`再計画の案 ${id} は人の確認待ちではありません（${entry?.status ?? "記録なし"}）`);
  const r = role(opts);
  // 確認する役割: ランナーが案を作ったときの役割と、案の計画から求め直した役割の両方（減らさない）
  const next = doc.proposal?.graph ?? null;
  const nextG = next ? normalizeGraph(structuredClone(next)) : null;
  const cls = nextG ? classifyPlanChange(g, nextG, s) : null;
  const needed = proposalNeededRoles(entry.roles ?? [], doc.roles ?? [], cls ? proposalRoles(cls.reasons) : []);
  if (!needed.includes(r))
    fail(`再計画の案 ${id} を確認するのは${needed.map((x) => ROLE_PERSON[x]).join("・")}です。${ROLE_PERSON[r]}は${sub === "accept" ? "承認" : "却下"}できません`);
  if (sub === "reject") note(opts, true);
  if (sub === "accept") {
    if (!next) fail(`案 ${id} には適用できる計画がありません（人が graph.json を直して pnpm devkit approve plan）`);
    const { errors } = validate(ctx, nextG, { controls: loadControls(ctx) });
    if (errors.length) fail(`案 ${id} の計画は検査に通りません:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  p.confirm(`proposal ${sub} ${id}`, { detail: `再計画の案 ${id}（${(entry.reasons ?? []).slice(0, 3).join(" / ")}）を${ROLE_PERSON[r]}として${sub === "accept" ? "承認" : "却下"}します` });
  const who = p.who(ctx, opts.by);
  const owner = checkOwnerWith(ctx, p, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
  if (sub === "reject") {
    const text = note(opts, true);
    updateControls(
      ctx,
      (cc) => {
        cc.proposals ??= {};
        cc.proposals[id] = { ...(cc.proposals[id] ?? {}), status: "rejected", role: r, needed, by: who.name, email: who.email, at: nowIso(), note: text, delegateOf: owner.delegateOf ?? null };
      },
      { journal: journalLabel(p, "proposal reject") },
    );
    recordWith(ctx, p, { role: r, who, target: `再計画の案 ${id}`, decision: "却下", content: text, delegateOf: owner.delegateOf, command: "proposal reject" });
    applyNowIfIdle(ctx, io, `devkit: 再計画の案 ${id} を却下`, journalLabel(p, "proposal reject"));
    return io.out("却下しました。計画を人が直す場合は、直したあと pnpm devkit approve plan を両方の役割で実行します");
  }
  const hash = planHash(ctx, next);
  const oldIds = new Set(g.nodes.map((n) => n.id));
  const changed = nextG.nodes.filter((n) => !oldIds.has(n.id) || JSON.stringify(n) !== JSON.stringify(g.nodes.find((x) => x.id === n.id))).map((n) => n.id);
  const removed = [...oldIds].filter((x) => !nextG.nodes.some((n) => n.id === x));
  // 役割ごとの承認を記録し、そろったら（同じロックの中で）計画に入れる
  const applied = updateControls(
    ctx,
    (cc) => {
      cc.proposals ??= {};
      const cur = cc.proposals[id] ?? { status: "pending", accepts: {} };
      cur.accepts = { ...(cur.accepts ?? {}), [r]: { by: who.name, email: who.email, at: nowIso(), note: note(opts), hash, delegateOf: owner.delegateOf ?? null } };
      cur.needed = needed;
      const all = needed.every((x) => cur.accepts[x]?.hash === hash);
      if (all) {
        journalWrite(ctx, ".devkit/graph.json", `${JSON.stringify(next, null, 2)}\n`, journalLabel(p, "proposal accept"));
        Object.assign(cur, { status: "accepted", at: nowIso(), changed, removed });
        cc.plan.approvedHash = hash;
        cc.plan.history.push({ type: "human-accepted-proposal", id, hash, at: nowIso(), by: needed.map((x) => cur.accepts[x].by), reasons: cls.reasons });
      }
      cc.proposals[id] = cur;
      return all;
    },
    { journal: journalLabel(p, "proposal accept") },
  );
  recordWith(ctx, p, { role: r, who, target: `再計画の案 ${id}`, decision: "承認", sha: hash, content: `${note(opts)}（人の確認が要った理由: ${cls.reasons.join("、")}）`, delegateOf: owner.delegateOf, command: "proposal accept" });
  if (!applied) {
    commitPaths(ctx, [".devkit/controls.json", ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 再計画の案 ${id} を${ROLE_LABEL[r]}が承認`);
    const cur = loadControls(ctx).proposals?.[id]?.accepts ?? {};
    const left = needed.filter((x) => cur[x]?.hash !== hash);
    return io.out(`${ROLE_PERSON[r]}として承認しました。残り: ${left.map((x) => ROLE_PERSON[x]).join("・")}の承認（pnpm devkit proposal accept ${id} --role ${left[0]}）`);
  }
  applyNowIfIdle(ctx, io, `devkit: 再計画の案 ${id} を承認`, journalLabel(p, "proposal accept"));
  io.out(`案 ${id} を計画に入れました`);
}

// 社内標準の例外の登録（標準オーナーが端末で）。docs/exceptions.json は Claude からは編集できない
export function exception(ctx, { pos = [], opts = {} }, p = ttyPresence, io = stdio) {
  const [sub] = pos;
  if (sub === "list" || !sub) {
    const doc = readJson(join(ctx.root, "docs", "exceptions.json"), { exceptions: [] });
    for (const e of doc.exceptions ?? []) io.out(`${e.id}\t${(e.rules ?? []).join(",")}\t${e.subject}\t見直し ${e.reviewBy}\t${e.reason}`);
    return;
  }
  if (sub !== "add") fail("使い方: exception list | exception add --rules TECH-01 --subject dependency:<名前> --reason … --adr docs/adr/… --review-by YYYY-MM-DD --role 技術");
  p.confirm("exception add");
  const r = role(opts);
  if (r !== "technical") fail("標準の例外は標準オーナー（--role 技術）が登録します");
  const who = p.who(ctx, opts.by);
  const owner = checkOwnerWith(ctx, p, r, who, { delegateOf: opts["delegate-of"], note: note(opts) });
  const rules = String(opts.rules ?? "").split(/[,\s]+/).filter(Boolean);
  const subject = String(opts.subject ?? "").trim();
  const reason = String(opts.reason ?? "").trim();
  const adr = String(opts.adr ?? "").trim();
  const reviewBy = String(opts["review-by"] ?? "").trim();
  if (!rules.length || !subject || !reason || !adr || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) fail("--rules・--subject・--reason・--adr・--review-by（YYYY-MM-DD）はすべて必要です");
  if (!existsSync(join(ctx.root, adr))) fail(`ADR ${adr} がありません（先に書く）`);
  const file = join(ctx.root, "docs", "exceptions.json");
  const doc = readJson(file, { exceptions: [] });
  doc.exceptions ??= [];
  const id = `EXC-${String(doc.exceptions.length + 1).padStart(3, "0")}`;
  const today = new Date().toLocaleDateString("sv-SE");
  doc.exceptions.push({ id, rules, subject, reason, adr, approvedBy: who.name, approvedAt: today, reviewBy });
  journalWrite(ctx, "docs/exceptions.json", `${JSON.stringify(doc, null, 2)}\n`, journalLabel(p, "exception add"));
  recordWith(ctx, p, { role: r, who, target: `標準の例外 ${id}（${rules.join(",")} / ${subject}）`, decision: "例外の承認", content: `${reason}（見直し ${reviewBy}、${adr}）`, delegateOf: owner.delegateOf, command: "exception add" });
  commitPaths(ctx, ["docs/exceptions.json", adr, "docs/decisions.md", ".devkit/journal.jsonl"], `devkit: 標準の例外 ${id} を承認`);
  io.out(`${id} を登録しました。pnpm standard:check で違反が消えたことを確かめてください`);
}
