// パスキーで署名された決定（封筒）を確かめて、端末のコマンドと同じ関数で反映する（ADR-0007・ADR-0008）。
//
// 封筒 = { body: 決定の本体, webauthn: 本人のパスキーのアサーション }。作るのは、
//   - 標準オーナー: ハブの画面（origin・rpId は docs/standard/hub.json、公開鍵は docs/standard/owners.json）
//   - 業務担当者:   ローカルのコンソール（origin は http://localhost:<console.port>、公開鍵は docs/profile.json）
// 公開鍵と画面の情報は、案件の中の封印されたファイルからだけ読む（封筒やハブから受け取らない）。
//
// 確かめること（1つでも合わなければ反映しない）:
//   形式・案件・期限・同じ決定をまだ反映していないこと・本人のパスキーの署名・対象の版（紐づけ）。
//   役割と担当者（docs/profile.json の owners）は、端末のコマンドと同じ関数の中で確かめる。
import { join } from "node:path";
import { normalizeRole, ROLE_PERSON } from "../shared.mjs";
import { applyChanges } from "./changes.mjs";
import { now as clockNow } from "./clock.mjs";
import * as decisions from "./decisions.mjs";
import { commitPaths } from "./human.mjs";
import { loadConfig, loadControls, loadGraph, loadState, nodeKey, planHash, updateControls } from "./model.mjs";
import { journalWrite } from "./seal.mjs";
import { runnerAlive } from "./status.mjs";
import { DevkitError, fail, readJson, sha256 } from "./util.mjs";
import { assertionProblem, canonical } from "./webauthn.mjs";

export const DECISION_KINDS = ["approve-plan", "approve-milestone", "approve-before", "reject-milestone", "answer", "proposal-accept", "proposal-reject", "change"];
export const DECISIONS_DIR = ".devkit/decisions";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LIFETIME_MS = 31 * 24 * 3600_000;
const SKEW_MS = 5 * 60_000;

// その役割の署名を確かめるための、画面の情報と登録された人（案件の中の封印されたファイルから）
export function trustFor(ctx, role) {
  if (role === "technical") {
    const hub = readJson(join(ctx.root, "docs", "standard", "hub.json"), null) ?? {};
    const people = readJson(join(ctx.root, "docs", "standard", "owners.json"), null)?.owners ?? [];
    return { source: "ハブ", origin: hub.origin || "", rpId: hub.rpId || "", people };
  }
  const port = loadConfig(ctx).console?.port;
  const people = readJson(ctx.profile, null)?.owners?.business ?? [];
  return { source: "コンソール", origin: Number.isInteger(port) ? `http://localhost:${port}` : "", rpId: "localhost", people };
}

// 封筒を確かめる。合えば { body, who, source }、合わなければ理由を投げる（状態は変えない）
export function checkEnvelope(ctx, env, { now = clockNow() } = {}) {
  const body = env?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("決定の本体（body）がありません");
  if (body.v !== 1) fail(`知らない版の決定です（v: ${body.v}）`);
  if (typeof body.id !== "string" || !ID.test(body.id)) fail("決定の ID の形が正しくありません");
  if (!DECISION_KINDS.includes(body.kind)) fail(`知らない種類の決定です（${String(body.kind).slice(0, 40)}）`);
  const role = normalizeRole(body.role);
  if (!role || role !== body.role) fail("決定の役割は business か technical");
  const project = readJson(ctx.profile, null)?.project;
  if (!project || body.project !== project) fail(`この案件（${project ?? "不明"}）への決定ではありません（${String(body.project).slice(0, 60)}）`);
  const at = Date.parse(body.at);
  const exp = Date.parse(body.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(exp)) fail("決定の日時（at・expiresAt）が正しくありません");
  if (at > now.getTime() + SKEW_MS) fail("決定の日時が未来です");
  if (exp <= now.getTime()) fail("決定の期限が切れています（判断し直してください）");
  if (exp - at > MAX_LIFETIME_MS) fail("決定の期限が長すぎます（31日まで）");
  if (loadControls(ctx).decisions?.[body.id]) fail(`決定 ${body.id} は反映済みです（同じ決定は1回だけ）`);
  const email = typeof body.by?.email === "string" ? body.by.email.toLowerCase() : "";
  if (!email) fail("決定した人（by.email）がありません");
  const trust = trustFor(ctx, role);
  const person = trust.people.find((o) => o?.email && o.email.toLowerCase() === email);
  if (!person) fail(`${body.by.email} は、${ROLE_PERSON[role]}として署名できる人に登録されていません（${role === "technical" ? "docs/standard/owners.json" : "docs/profile.json の owners.business"}）`);
  const credential = (person.passkeys ?? []).find((k) => k?.id === env.webauthn?.credentialId);
  if (!credential) fail(`${body.by.email} の登録されたパスキーの署名ではありません`);
  const problem = assertionProblem({ body, webauthn: env.webauthn, credential, origin: trust.origin, rpId: trust.rpId });
  if (problem) fail(`署名を確かめられません: ${problem}`);
  return { body, role, source: trust.source, who: { name: person.name || body.by.name || body.by.email, email: person.email } };
}

// 対象の版（紐づけ）が今の状態と同じか。古い版への決定は反映しない
function bindingProblem(ctx, body) {
  const b = body.binding ?? {};
  const g = loadGraph(ctx);
  const s = loadState(ctx, g);
  switch (body.kind) {
    case "approve-plan":
      return b.planHash === planHash(ctx) ? null : "計画が、決定の後に変わっています（計画のハッシュが合わない）";
    case "approve-milestone":
    case "reject-milestone": {
      const head = s.milestones[body.target]?.head;
      return head && b.sha === head ? null : `${body.target} の検証したコミットが、決定のときと違います`;
    }
    case "approve-before": {
      const n = g.nodes.find((x) => x.id === body.target);
      return n && b.nodeKey === nodeKey(n) ? null : `${body.target} の定義が、決定のときと違います`;
    }
    case "answer":
      return typeof b.request === "string" && b.request ? null : "判断依頼の ID（binding.request）がありません";
    case "proposal-accept": {
      const doc = readJson(join(ctx.proposals, `${body.target}.json`), null);
      const next = doc?.proposal?.graph;
      return next && b.planHash === planHash(ctx, next) ? null : `再計画の案 ${body.target} の内容が、決定のときと違います`;
    }
    case "proposal-reject":
      return null;
    case "change":
      return typeof body.changes?.hash === "string" && Array.isArray(body.changes?.ops) ? null : "変更案（changes.ops・changes.hash）がありません";
    default:
      return "知らない種類の決定";
  }
}

// 封筒を確かめて反映する。反映したら、封筒を .devkit/decisions/<ID>.json に残す（後から git だけで署名を確かめられる）
export function applyEnvelope(ctx, env, { io = { out: (t) => console.log(t) }, now = clockNow() } = {}) {
  if (process.env.DEVKIT_ROLE || process.env.DEVKIT_RUNNER === "1") fail("ランナーが起動した AI は、決定を反映できません");
  const { body, role, source, who } = checkEnvelope(ctx, env, { now });
  if (typeof body.target !== "string" && body.kind !== "change") fail("決定の対象（target）がありません");
  const problem = bindingProblem(ctx, body);
  if (problem) fail(`${problem}（反映しませんでした）`);
  const p = decisions.passkeyPresence({ id: body.id, source, who });
  const note = typeof body.note === "string" ? body.note : "";
  const opts = { role, note };
  switch (body.kind) {
    case "approve-plan":
      decisions.approve(ctx, { pos: ["plan"], opts }, p, io);
      break;
    case "approve-milestone":
      decisions.approve(ctx, { pos: [body.target], opts }, p, io);
      break;
    case "approve-before":
      decisions.approve(ctx, { pos: [body.target], opts: { ...opts, before: true } }, p, io);
      break;
    case "reject-milestone":
      decisions.reject(ctx, { pos: [body.target], opts }, p, io);
      break;
    case "answer":
      decisions.answer(ctx, { pos: [body.target], opts: { ...opts, request: body.binding.request } }, p, io);
      break;
    case "proposal-accept":
      decisions.proposal(ctx, { pos: ["accept", body.target], opts }, p, io);
      break;
    case "proposal-reject":
      decisions.proposal(ctx, { pos: ["reject", body.target], opts }, p, io);
      break;
    case "change":
      applyChanges(ctx, body.changes, { role, p, io, note });
      break;
  }
  const text = `${JSON.stringify(env, null, 2)}\n`;
  const rel = `${DECISIONS_DIR}/${body.id}.json`;
  const command = decisions.journalLabel(p, "decision");
  updateControls(
    ctx,
    (c) => {
      c.decisions ??= {};
      c.decisions[body.id] = { kind: body.kind, role, by: who.email, at: now.toISOString(), hash: sha256(canonical(body)).slice(0, 32) };
    },
    { journal: command },
  );
  journalWrite(ctx, rel, text, command);
  if (!runnerAlive(ctx).alive) commitPaths(ctx, [rel, ".devkit/controls.json", ".devkit/journal.jsonl"], `devkit: 決定 ${body.id} の記録`);
  return { id: body.id, kind: body.kind, role, by: who };
}

// 反映できない理由を、落とさずに返す（同期の結果としてハブ・コンソールに返すため）
export function tryApplyEnvelope(ctx, env, o = {}) {
  try {
    return { ok: true, ...applyEnvelope(ctx, env, o) };
  } catch (e) {
    if (e instanceof DevkitError) return { ok: false, reason: e.message };
    throw e;
  }
}
