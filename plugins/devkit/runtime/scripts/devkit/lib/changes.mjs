// 変更案: 設定などの変更を「決まった種類の操作の並び」で表し、承認されたものだけを当てる（ADR-0008）。
//
// - 自由な差分は受け付けない。操作の種類・値の形・対象のファイルは、この表（OPS）にあるものだけ
// - 差分は、操作と今のファイルからここで作る（AI が出せるのは操作の案まで）
// - 変更案のハッシュは、操作の並びと、当てる先のファイルの今の内容のハッシュから求める。
//   承認（署名）はこのハッシュに対して行い、当てるときに求め直して合わなければ当てない
// - 当てるのは人の判断と同じ経路（journal に残してから書く・docs/decisions.md・コミット）
//
// ここで変えられないもの（端末で、人が）: 隔離をゆるめる設定（aiSandbox・isolation・permissionMode・supervisor.allowApiKey）、
// docs/standard/・scripts/・.claude/、担当者（owners）の追加と削除、仕様書の本文。依存の追加（dependency.add）は次の段階。
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { ROLE_LABEL, ROLE_PERSON, ROLES } from "../shared.mjs";
import { validTimeZone } from "./clock.mjs";
import { checkOwnerWith, journalLabel, recordWith } from "./decisions.mjs";
import { commitPaths } from "./human.mjs";
import { loadControls, loadGraph, updateControls } from "./model.mjs";
import { journalWrite } from "./seal.mjs";
import { fail, nowIso, readJson, readText, sha256 } from "./util.mjs";
import { canonical, loadCredentialKey } from "./webauthn.mjs";

const PROFILE = "docs/profile.json";
const EXCEPTIONS = "docs/exceptions.json";
const CONFIG = ".devkit/config.json";
const CONTROLS = ".devkit/controls.json";

const HOST = /^(\*\.)?(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const AUTHS = ["dev", "none", "better-auth", "sso-entra", "sso-google", "sso-lineworks"];
const TIERS = ["lite", "standard", "ha"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, name, max = 300) {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\r\n\u0000]/.test(v)) fail(`変更案: ${name} は1行の文字列（${max} 文字まで）`);
  return v.trim();
}

function int(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) fail(`変更案: ${name} は ${min}〜${max} の整数`);
  return v;
}

function realDate(v, name) {
  const s = str(v, name, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail(`変更案: ${name} は実在する日付（YYYY-MM-DD）`);
  return s;
}

function only(op, keys) {
  for (const k of Object.keys(op)) if (k !== "op" && !keys.includes(k)) fail(`変更案: ${op.op} に知らない項目 ${k}`);
}

function host(v) {
  const h = str(v, "host", 260).toLowerCase();
  if (!HOST.test(h)) fail(`変更案: 「${h}」はホスト名だけを書く（例: api.example.co.jp・*.example.co.jp）`);
  return h;
}

// 例外の1件を作る（端末の exception add と同じ形）
export function exceptionEntry(doc, { rules, subject, reason, adr, reviewBy }, who, today) {
  const id = `EXC-${String((doc.exceptions ?? []).length + 1).padStart(3, "0")}`;
  return { id, rules, subject, reason, adr, approvedBy: who.name, approvedAt: today, reviewBy };
}

// .devkit/config.json のうち、変更案で変えてよい項目と値の形
const CONFIG_KEYS = {
  "briefing.enabled": (v) => typeof v === "boolean",
  "briefing.time": (v) => typeof v === "string" && HHMM.test(v),
  "briefing.timeZone": (v) => typeof v === "string" && validTimeZone(v),
  "briefing.to": (v) => ["common", "technical", "business"].includes(v),
  "supervisor.hours": (v) => v === null || (typeof v === "string" && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v) && v.split("-").every((x) => HHMM.test(x))),
  "supervisor.intervalSeconds": (v) => Number.isInteger(v) && v >= 5 && v <= 60,
  "supervisor.limits.maxRunsPerDay": (v) => Number.isInteger(v) && v >= 1 && v <= 200,
  "supervisor.limits.maxCostUsdPerDay": (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 10000),
  "supervisor.limits.maxNoProgressRuns": (v) => Number.isInteger(v) && v >= 1 && v <= 10,
  "supervisor.retry.maxAttempts": (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  "supervisor.retry.maxWaitMinutes": (v) => Number.isInteger(v) && v >= 1 && v <= 240,
  "supervisor.retry.totalHours": (v) => Number.isInteger(v) && v >= 1 && v <= 48,
  "hub.url": (v) => typeof v === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(v) && v.length <= 200,
  "hub.materials": (v) => ["summary", "full"].includes(v),
  "console.port": (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
};

function businessOwner(doc, email) {
  const o = (doc.owners?.business ?? []).find((x) => x?.email && x.email.toLowerCase() === email.toLowerCase());
  if (!o) fail(`変更案: ${email} は docs/profile.json の owners.business にいません（担当者の追加は、人が端末で）`);
  return o;
}

// 操作の表。check: 値を確かめて正規化した操作を返す ／ file: 当てる先 ／ roles: 承認する役割 ／ apply: 文書を書き換える
const OPS = {
  "exception.add": {
    file: EXCEPTIONS,
    roles: ["technical"],
    check(op, ctx) {
      only(op, ["rules", "subject", "reason", "adr", "reviewBy"]);
      const rules = Array.isArray(op.rules) ? op.rules.map((r) => str(r, "rules", 20)) : [];
      if (!rules.length || rules.some((r) => !/^[A-Z]+-\d+$/.test(r))) fail("変更案: rules はルール ID の配列（例: TECH-01）");
      if (rules.includes("ESC-06")) fail("変更案: ESC-06 は例外にできません");
      const known = readJson(join(ctx.root, "docs", "standard", "rules.json"), null)?.rules;
      if (Array.isArray(known)) for (const r of rules) if (!known.some((k) => k.id === r)) fail(`変更案: ルール ${r} は社内標準にありません`);
      const adr = normalize(str(op.adr, "adr", 200)).replaceAll("\\", "/");
      if (!/^docs\/adr\/[\w.-]+\.md$/.test(adr)) fail("変更案: adr は docs/adr/ の下の .md");
      if (!existsSync(join(ctx.root, adr))) fail(`変更案: ADR ${adr} がありません（先に書く）`);
      return { op: op.op, rules: [...new Set(rules)].sort(), subject: str(op.subject, "subject"), reason: str(op.reason, "reason"), adr, reviewBy: realDate(op.reviewBy, "reviewBy") };
    },
    apply(doc, op, { who, today }) {
      doc.exceptions ??= [];
      if (op.reviewBy < today) fail("変更案: 見直し期限（reviewBy）が過去の日付です");
      doc.exceptions.push(exceptionEntry(doc, op, who, today));
    },
    extra: (op) => [op.adr],
    label: (op) => `例外 ${op.rules.join(",")} / ${op.subject}（見直し ${op.reviewBy}）`,
  },
  "profile.externalHosts.add": {
    file: PROFILE,
    roles: ["technical"],
    check: (op) => (only(op, ["host"]), { op: op.op, host: host(op.host) }),
    apply(doc, op) {
      doc.externalHosts = Array.isArray(doc.externalHosts) ? doc.externalHosts : [];
      if (doc.externalHosts.map((h) => String(h).toLowerCase()).includes(op.host)) fail(`変更案: ${op.host} は登録済みです`);
      doc.externalHosts.push(op.host);
    },
    label: (op) => `外部の接続先 ${op.host} を登録`,
  },
  "profile.externalHosts.remove": {
    file: PROFILE,
    roles: ["technical"],
    check: (op) => (only(op, ["host"]), { op: op.op, host: host(op.host) }),
    apply(doc, op) {
      const cur = Array.isArray(doc.externalHosts) ? doc.externalHosts : [];
      if (!cur.map((h) => String(h).toLowerCase()).includes(op.host)) fail(`変更案: ${op.host} は登録されていません`);
      doc.externalHosts = cur.filter((h) => String(h).toLowerCase() !== op.host);
    },
    label: (op) => `外部の接続先 ${op.host} を外す`,
  },
  "profile.personalData.set": {
    file: PROFILE,
    roles: ["technical"],
    check(op) {
      only(op, ["stored", "items"]);
      if (typeof op.stored !== "boolean" || !Array.isArray(op.items)) fail("変更案: personalData は stored（真偽）と items（配列）");
      const items = op.items.map((i) => str(i, "items", 100));
      if (!op.stored && items.length) fail("変更案: stored が false なら items は空");
      return { op: op.op, stored: op.stored, items };
    },
    apply(doc, op) {
      doc.personalData = { stored: op.stored, items: op.items };
    },
    label: (op) => `個人情報: ${op.stored ? op.items.join("・") || "あり" : "なし"}`,
  },
  "profile.auth.set": {
    file: PROFILE,
    roles: ["technical"],
    check(op) {
      only(op, ["value"]);
      if (!AUTHS.includes(op.value)) fail(`変更案: auth は ${AUTHS.join(" / ")} のどれか`);
      return { op: op.op, value: op.value };
    },
    apply(doc, op) {
      doc.auth = op.value;
    },
    label: (op) => `認証方式を ${op.value} に`,
  },
  "profile.tier.set": {
    file: PROFILE,
    roles: ["business", "technical"],
    check(op) {
      only(op, ["value"]);
      if (!TIERS.includes(op.value)) fail(`変更案: tier は ${TIERS.join(" / ")} のどれか`);
      return { op: op.op, value: op.value };
    },
    apply(doc, op) {
      doc.tier = op.value;
    },
    label: (op) => `運用レベルを ${op.value} に`,
  },
  // 業務担当者のパスキー（ローカルのコンソールでの署名に使う）。標準オーナーのパスキーは docs/standard/owners.json で配る
  "profile.owners.passkey.add": {
    file: PROFILE,
    roles: ["technical"],
    check(op) {
      only(op, ["email", "credential"]);
      const email = str(op.email, "email", 200);
      if (!EMAIL.test(email)) fail("変更案: email の形が正しくない");
      const c = op.credential ?? {};
      for (const k of Object.keys(c)) if (!["id", "alg", "publicKey", "label"].includes(k)) fail(`変更案: credential に知らない項目 ${k}`);
      const cred = { id: str(c.id, "credential.id", 1400), alg: str(c.alg, "credential.alg", 10), publicKey: str(c.publicKey, "credential.publicKey", 2000), ...(c.label === undefined ? {} : { label: str(c.label, "credential.label", 60) }) };
      if (!/^[A-Za-z0-9_-]+$/.test(cred.id)) fail("変更案: credential.id は base64url");
      try {
        loadCredentialKey(cred);
      } catch (e) {
        fail(`変更案: パスキーの公開鍵を使えません（${e.message}）`);
      }
      return { op: op.op, email, credential: cred };
    },
    apply(doc, op, { today }) {
      const all = (doc.owners?.business ?? []).flatMap((o) => o?.passkeys ?? []);
      if (all.some((k) => k.id === op.credential.id)) fail("変更案: このパスキーは登録済みです");
      const o = businessOwner(doc, op.email);
      o.passkeys = [...(o.passkeys ?? []), { ...op.credential, addedAt: today }];
    },
    label: (op) => `${op.email} のパスキーを登録（${op.credential.label ?? op.credential.id.slice(0, 12)}）`,
  },
  "profile.owners.passkey.remove": {
    file: PROFILE,
    roles: ["technical"],
    check(op) {
      only(op, ["email", "id"]);
      return { op: op.op, email: str(op.email, "email", 200), id: str(op.id, "id", 1400) };
    },
    apply(doc, op) {
      const o = businessOwner(doc, op.email);
      if (!(o.passkeys ?? []).some((k) => k.id === op.id)) fail("変更案: そのパスキーは登録されていません");
      o.passkeys = o.passkeys.filter((k) => k.id !== op.id);
    },
    label: (op) => `${op.email} のパスキーを外す（${op.id.slice(0, 12)}）`,
  },
  "config.set": {
    file: CONFIG,
    roles: ["technical"],
    check(op) {
      only(op, ["path", "value"]);
      const ok = Object.hasOwn(CONFIG_KEYS, op.path) ? CONFIG_KEYS[op.path] : null;
      if (!ok) fail(`変更案: 設定 ${op.path} は変更案では変えられません（変えられるのは ${Object.keys(CONFIG_KEYS).join("・")}。隔離・権限の設定は人が端末で）`);
      if (!ok(op.value)) fail(`変更案: 設定 ${op.path} の値が正しくない（${JSON.stringify(op.value)}）`);
      return { op: op.op, path: op.path, value: op.value };
    },
    apply(doc, op) {
      const keys = op.path.split(".");
      let cur = doc;
      for (const k of keys.slice(0, -1)) {
        if (cur[k] === undefined || cur[k] === null) cur[k] = {};
        if (typeof cur[k] !== "object" || Array.isArray(cur[k])) fail(`変更案: 設定 ${op.path} の途中（${k}）がオブジェクトではありません`);
        cur = cur[k];
      }
      cur[keys.at(-1)] = op.value;
    },
    label: (op) => `設定 ${op.path} = ${JSON.stringify(op.value)}`,
  },
  // サイクル上限の追加（controls.json。ほかの判断でも変わるファイルなので、内容ではなく今の上限に紐づける）
  "limits.addCycles": {
    file: CONTROLS,
    volatile: true,
    roles: ["technical"],
    check: (op) => (only(op, ["n"]), { op: op.op, n: int(op.n, "n", 1, 100) }),
    label: (op) => `サイクル上限を ${op.n} 追加`,
  },
};

export const CHANGE_OPS = Object.keys(OPS);

function fileHash(ctx, rel) {
  const p = join(ctx.root, rel);
  return existsSync(p) ? sha256(readText(p)).slice(0, 32) : "missing";
}

function emptyDoc(rel) {
  return rel === EXCEPTIONS ? { exceptions: [] } : {};
}

// 操作を確かめ、当てた後の内容・差分・承認する役割・ハッシュを求める（書き込まない）
export function planChanges(ctx, rawOps, { who = { name: "（承認者）", email: "" }, today = new Date().toLocaleDateString("sv-SE") } = {}) {
  if (!Array.isArray(rawOps) || !rawOps.length || rawOps.length > 20) fail("変更案: 操作は1〜20件の配列");
  const ops = rawOps.map((op) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) fail("変更案: 操作はオブジェクト");
    if (op.op === "dependency.add") fail("変更案: 依存の追加（dependency.add）は、まだ自動では当てません（例外の承認の後、人が pnpm add する）");
    const def = Object.hasOwn(OPS, op.op) ? OPS[op.op] : null;
    if (!def) fail(`変更案: 知らない操作 ${String(op.op).slice(0, 60)}（使えるのは ${CHANGE_OPS.join("・")}）`);
    return def.check(op, ctx);
  });
  const docs = new Map();
  const base = {};
  const extra = new Set();
  const roles = new Set();
  for (const op of ops) {
    const def = OPS[op.op];
    for (const r of def.roles) roles.add(r);
    for (const e of def.extra?.(op) ?? []) extra.add(e);
    if (def.volatile) {
      // ほかの判断でも変わるファイルなので、内容ではなく今の上限に紐づける（同じ承認を2回は当てない）
      base[`${def.file}#maxCycles`] = String(loadControls(ctx).maxCycles ?? loadGraph(ctx, { required: false })?.limits?.maxCycles ?? 0);
      continue;
    }
    if (!docs.has(def.file)) {
      base[def.file] = fileHash(ctx, def.file);
      docs.set(def.file, { before: readText(join(ctx.root, def.file)), doc: readJson(join(ctx.root, def.file), null) ?? emptyDoc(def.file) });
    }
    def.apply(docs.get(def.file).doc, op, { who, today });
  }
  const files = {};
  for (const [rel, d] of docs) {
    const after = `${JSON.stringify(d.doc, null, 2)}\n`;
    files[rel] = { baseHash: base[rel], after, diff: lineDiff(d.before, after) };
  }
  const hash = sha256(canonical({ v: 1, ops, base })).slice(0, 32);
  return { ops, hash, roles: ROLES.filter((r) => roles.has(r)), files, extra: [...extra], labels: ops.map((op) => OPS[op.op].label(op)) };
}

// 承認された変更案を当てる。hash は承認（署名）の対象。今の内容から求め直して合わなければ当てない。
// 役割がそろうまでは承認だけを記録し、そろったら当ててコミットする
export function applyChanges(ctx, { ops, hash }, { role, p, io = { out: (t) => console.log(t) }, note = "" }) {
  const today = new Date().toLocaleDateString("sv-SE");
  const who = p.who(ctx);
  const plan = planChanges(ctx, ops, { who, today });
  if (plan.hash !== hash) fail("変更案を作った後に、当てる先のファイルか操作の内容が変わっています。変更案を作り直して、承認し直してください（当てませんでした）");
  if (!plan.roles.includes(role)) fail(`この変更案を承認するのは${plan.roles.map((r) => ROLE_PERSON[r]).join("・")}です。${ROLE_PERSON[role] ?? role}は承認できません`);
  p.confirm(`change ${hash}`, { detail: `変更案 ${hash.slice(0, 10)} を${ROLE_PERSON[role]}として承認します:\n${plan.labels.map((l) => `  - ${l}`).join("\n")}` });
  checkOwnerWith(ctx, p, role, who, { note });
  const prior = loadControls(ctx).changes?.[hash];
  if (prior?.status === "applied") fail(`変更案 ${hash.slice(0, 10)} は適用済みです`);
  const command = journalLabel(p, "change");
  const summary = plan.labels.join("、");
  const target = `変更案 ${hash.slice(0, 10)}（${summary}）`;
  const complete = plan.roles.every((r) => r === role || prior?.accepts?.[r]);
  // 役割がそろうなら、先にファイルを書く（途中で失敗したら、適用済みの記録を残さない）
  if (complete) for (const [rel, f] of Object.entries(plan.files)) journalWrite(ctx, rel, f.after, command);
  const baseCycles = loadGraph(ctx, { required: false })?.limits?.maxCycles ?? 0;
  updateControls(
    ctx,
    (c) => {
      c.changes ??= {};
      const cur = c.changes[hash] ?? { status: "pending", accepts: {} };
      cur.accepts = { ...(cur.accepts ?? {}), [role]: { by: who.name, email: who.email, at: nowIso(), note } };
      cur.needed = plan.roles;
      if (complete) {
        Object.assign(cur, { status: "applied", at: nowIso(), ops: plan.ops });
        for (const op of plan.ops) if (op.op === "limits.addCycles") c.maxCycles = (c.maxCycles ?? baseCycles) + op.n;
      }
      c.changes[hash] = cur;
    },
    { journal: command },
  );
  if (!complete) {
    const left = plan.roles.filter((r) => r !== role && !prior?.accepts?.[r]);
    recordWith(ctx, p, { role, who, target, decision: "承認", sha: hash, content: note, command: "change" });
    commitPaths(ctx, [CONTROLS, ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 変更案 ${hash.slice(0, 10)} を${ROLE_LABEL[role]}が承認`);
    io.out(`${ROLE_PERSON[role]}として承認しました。残り: ${left.map((r) => ROLE_PERSON[r]).join("・")}の承認（そろったら当てます）`);
    return { applied: false, left };
  }
  recordWith(ctx, p, { role, who, target, decision: "承認・適用", sha: hash, content: note, command: "change" });
  commitPaths(ctx, [...Object.keys(plan.files), ...plan.extra, CONTROLS, ".devkit/journal.jsonl", "docs/decisions.md"], `devkit: 変更案 ${hash.slice(0, 10)} を適用`);
  io.out(`変更案 ${hash.slice(0, 10)} を当てました（${summary}）。pnpm standard:check で確かめてください`);
  return { applied: true, files: Object.keys(plan.files) };
}

// 行ごとの差分（表示用。小さな JSON が対象）
export function lineDiff(before, after, context = 2) {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) rows.push([" ", a[i++], j++]);
    else if (j < m && (i === n || lcs[i][j + 1] > lcs[i + 1][j])) rows.push(["+", b[j++]]);
    else rows.push(["-", a[i++]]);
  }
  const keep = rows.map(() => false);
  rows.forEach((r, k) => {
    if (r[0] !== " ") for (let x = Math.max(0, k - context); x <= Math.min(rows.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [];
  rows.forEach((r, k) => {
    if (keep[k]) out.push(`${r[0]} ${r[1]}`);
    else if (keep[k - 1]) out.push("  …");
  });
  return out.join("\n");
}
