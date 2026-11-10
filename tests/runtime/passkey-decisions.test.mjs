// パスキーで署名された決定（封筒）と変更案。端末のコマンドと同じ関数で反映され、署名・版・役割が合わないものは反映されない。
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cleanEnv, devkit, git, graphFor, makeProject, RUNTIME } from "./helpers.mjs";

// テストを Claude Code の中から実行しても同じに動くように（封筒の反映は、ランナーの AI からは断る）
for (const k of Object.keys(process.env)) if (!(k in cleanEnv())) delete process.env[k];

const lib = (name) => import(pathToFileURL(join(RUNTIME, "scripts", "devkit", "lib", name)).href);
const { canonical, bodyHash, assertionProblem, loadCredentialKey } = await lib("webauthn.mjs");
const { applyEnvelope, tryApplyEnvelope, checkEnvelope } = await lib("envelope.mjs");
const { planChanges, lineDiff } = await lib("changes.mjs");
const { createContext, planHash, loadControls, nodeKey, loadGraph } = await lib("model.mjs");

const HUB = { origin: "https://devkit-hub.example.co.jp", rpId: "devkit-hub.example.co.jp" };
const PORT = 4179;
const CONSOLE = { origin: `http://localhost:${PORT}`, rpId: "localhost" };
const b64u = (b) => Buffer.from(b).toString("base64url");

// 試験用のパスキー（認証器の代わり）
function passkey(alg = "ES256", id = `cred-${Math.random().toString(36).slice(2, 10)}`) {
  const pair = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("ed25519");
  return { id, alg, privateKey: pair.privateKey, credential: { id, alg, publicKey: b64u(pair.publicKey.export({ format: "der", type: "spki" })) } };
}

function assertion(key, body, { origin, rpId }, { flags = 0x05, type = "webauthn.get", challenge = b64u(bodyHash(body)), crossOrigin = false } = {}) {
  const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }));
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = key.alg === "ES256" ? sign("sha256", signed, { key: key.privateKey, dsaEncoding: "der" }) : sign(null, signed, key.privateKey);
  return { credentialId: key.id, authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) };
}

let seq = 0;
function bodyOf(over) {
  const at = new Date();
  return { v: 1, id: `DEC-${String(++seq).padStart(4, "0")}`, project: "test", note: "確認した", at: at.toISOString(), expiresAt: new Date(at.getTime() + 7 * 86400_000).toISOString(), ...over };
}

// 案件を作り、標準オーナー（Tom・ハブ）と業務担当者（Alice・コンソール）のパスキーを登録する
function setup(opts = {}) {
  const p = makeProject({ config: { console: { port: PORT } }, ...opts });
  const tom = passkey("ES256");
  const alice = passkey("EdDSA");
  mkdirSync(join(p.dir, "docs", "standard"), { recursive: true });
  writeFileSync(join(p.dir, "docs", "standard", "hub.json"), JSON.stringify(HUB));
  writeFileSync(join(p.dir, "docs", "standard", "owners.json"), JSON.stringify({ owners: [{ name: "Tom", email: "tom@example.com", passkeys: [tom.credential] }] }));
  const profile = JSON.parse(readFileSync(join(p.dir, "docs", "profile.json"), "utf8"));
  profile.owners.business[0].passkeys = [alice.credential];
  writeFileSync(join(p.dir, "docs", "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  git(p.dir, "add", "-A");
  git(p.dir, "commit", "-q", "-m", "passkeys");
  const ctx = createContext(p.dir);
  const io = { lines: [], out(t) { this.lines.push(t); } };
  const tech = (over) => {
    const body = bodyOf({ role: "technical", by: { name: "Tom", email: "tom@example.com" }, ...over });
    return { body, webauthn: assertion(tom, body, HUB) };
  };
  const biz = (over) => {
    const body = bodyOf({ role: "business", by: { name: "Alice", email: "alice@example.com" }, ...over });
    return { body, webauthn: assertion(alice, body, CONSOLE) };
  };
  return { ...p, ctx, io, tom, alice, tech, biz };
}

const decisionsMd = (dir) => readFileSync(join(dir, "docs", "decisions.md"), "utf8");
const planBody = (ctx) => ({ kind: "approve-plan", target: "plan", binding: { planHash: planHash(ctx) } });

test("正規化した JSON は、キーの順序によらず同じになる。小数は受け付けない", () => {
  assert.equal(canonical({ b: [1, "x", null, true], a: { d: 1, c: "é" } }), '{"a":{"c":"é","d":1},"b":[1,"x",null,true]}');
  assert.deepEqual(bodyHash({ a: 1, b: 2 }), bodyHash({ b: 2, a: 1 }));
  assert.throws(() => canonical({ a: 1.5 }));
  assert.throws(() => canonical({ a: undefined }));
});

test("アサーションの検証: ES256 と EdDSA は通り、内容・画面・本人確認・鍵が違えば断る", () => {
  const body = { v: 1, id: "X", n: 1 };
  for (const alg of ["ES256", "EdDSA"]) {
    const k = passkey(alg);
    const base = { body, credential: k.credential, ...HUB };
    assert.equal(assertionProblem({ ...base, webauthn: assertion(k, body, HUB) }), null, alg);
    assert.match(assertionProblem({ ...base, body: { ...body, n: 2 }, webauthn: assertion(k, body, HUB) }), /challenge/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, { ...HUB, origin: "https://evil.example" }) }), /画面が違う/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, { ...HUB, rpId: "evil.example" }) }), /rpId/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, HUB, { flags: 0x01 }) }), /本人確認/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, HUB, { flags: 0x04 }) }), /本人の操作/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, HUB, { type: "webauthn.create" }) }), /種類/);
    assert.match(assertionProblem({ ...base, webauthn: assertion(k, body, HUB, { crossOrigin: true }) }), /埋め込まれた/);
    const other = passkey(alg, k.id);
    assert.match(assertionProblem({ ...base, webauthn: assertion(other, body, HUB) }), /公開鍵と合わない/);
    const a = assertion(k, body, HUB);
    assert.match(assertionProblem({ ...base, webauthn: { ...a, credentialId: "other" } }), /登録されたパスキー/);
  }
  assert.match(assertionProblem({ body, credential: passkey().credential, origin: "", rpId: "", webauthn: {} }), /設定されていない/);
});

test("公開鍵: RSA や形の違う鍵は登録できない", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" });
  assert.throws(() => loadCredentialKey({ id: "a", alg: "ES256", publicKey: b64u(rsa) }), /P-256/);
  assert.throws(() => loadCredentialKey({ id: "a", alg: "RS256", publicKey: b64u(rsa) }), /使えない/);
  assert.throws(() => loadCredentialKey({ id: "a", alg: "ES256", publicKey: "!!" }), /base64url/);
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" });
  assert.throws(() => loadCredentialKey({ id: "a", alg: "ES256", publicKey: b64u(p384) }), /P-256/);
});

test("計画の承認: 業務担当者はコンソール、標準オーナーはハブの署名で。記録に証明の種類と決定の ID が残る", () => {
  const t = setup();
  const b = t.biz(planBody(t.ctx));
  const r1 = applyEnvelope(t.ctx, b, { io: t.io });
  assert.equal(r1.by.name, "Alice");
  assert.equal(loadControls(t.ctx).plan.approvedHash, null, "片方だけではそろわない");
  const tc = t.tech(planBody(t.ctx));
  applyEnvelope(t.ctx, tc, { io: t.io });
  const c = loadControls(t.ctx);
  assert.equal(c.plan.approvedHash, planHash(t.ctx));
  assert.equal(c.plan.approvals.business.email, "alice@example.com");
  assert.equal(c.decisions[b.body.id].kind, "approve-plan");
  const md = decisionsMd(t.dir);
  assert.match(md, new RegExp(`業務 \\| Alice \\| 計画.*コンソール（パスキー）・${b.body.id}`));
  assert.match(md, new RegExp(`技術 \\| Tom \\| 計画.*ハブ（パスキー）・${tc.body.id}`));
  // 封筒が残り、コミットされている。journal にも証明の種類が残る
  assert.deepEqual(JSON.parse(readFileSync(join(t.dir, ".devkit", "decisions", `${tc.body.id}.json`), "utf8")), tc);
  assert.equal(git(t.dir, "status", "--porcelain"), "");
  assert.match(readFileSync(join(t.dir, ".devkit", "journal.jsonl"), "utf8"), new RegExp(`approve plan \\[passkey ${tc.body.id}\\]`));
  // 端末のコマンドから見ても承認済みで、開始できる
  assert.match(devkit(t.dir, ["check"]).out, /計画: 承認済み/);
  assert.equal(devkit(t.dir, ["start"], { scenarioFile: t.scenarioFile }).code, 0);
});

test("同じ決定は1回だけ。古い計画への決定・期限切れ・別の案件・改変された本体は反映しない", () => {
  const t = setup();
  const ok = t.tech(planBody(t.ctx));
  applyEnvelope(t.ctx, ok, { io: t.io });
  assert.match(tryApplyEnvelope(t.ctx, ok, { io: t.io }).reason, /反映済み/);

  assert.match(tryApplyEnvelope(t.ctx, t.tech({ ...planBody(t.ctx), binding: { planHash: "0".repeat(32) } }), { io: t.io }).reason, /計画が、決定の後に変わって/);
  const past = new Date(Date.now() - 86400_000).toISOString();
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ ...planBody(t.ctx), at: new Date(Date.now() - 2 * 86400_000).toISOString(), expiresAt: past }), { io: t.io }).reason, /期限が切れて/);
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ ...planBody(t.ctx), expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() }), { io: t.io }).reason, /長すぎ/);
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ ...planBody(t.ctx), project: "other" }), { io: t.io }).reason, /この案件/);
  const e = t.biz(planBody(t.ctx));
  assert.match(tryApplyEnvelope(t.ctx, { ...e, body: { ...e.body, note: "書き換えた" } }, { io: t.io }).reason, /challenge/);
  assert.match(tryApplyEnvelope(t.ctx, { ...e, body: { ...e.body, kind: "rm -rf" } }, { io: t.io }).reason, /知らない種類/);
  assert.match(tryApplyEnvelope(t.ctx, { ...e, body: { ...e.body, id: "../x" } }, { io: t.io }).reason, /ID の形/);
  assert.equal(loadControls(t.ctx).plan.approvals.business, undefined, "断った決定は何も書かない");
});

test("役割と人: 業務担当者の鍵では技術の決定を作れない。登録のない人・別の画面の署名・代理は断る", () => {
  const t = setup();
  // Alice の鍵で「技術」と名乗る（owners.json に Alice はいない）
  const body = bodyOf({ ...planBody(t.ctx), role: "technical", by: { name: "Alice", email: "alice@example.com" } });
  assert.match(tryApplyEnvelope(t.ctx, { body, webauthn: assertion(t.alice, body, HUB) }, { io: t.io }).reason, /登録されていません/);
  // Tom を名乗るが、鍵は Alice のもの
  const body2 = bodyOf({ ...planBody(t.ctx), role: "technical", by: { name: "Tom", email: "tom@example.com" } });
  assert.match(tryApplyEnvelope(t.ctx, { body: body2, webauthn: assertion(t.alice, body2, HUB) }, { io: t.io }).reason, /登録されたパスキーの署名ではありません/);
  // 標準オーナーの鍵でも、コンソール（localhost）で作った署名は技術の決定にならない
  assert.match(tryApplyEnvelope(t.ctx, { body: body2, webauthn: assertion(t.tom, body2, CONSOLE) }, { io: t.io }).reason, /画面が違う|rpId/);
  // 業務担当者の署名を、別の番号のコンソールで作ったもの
  const body3 = bodyOf({ ...planBody(t.ctx), role: "business", by: { name: "Alice", email: "alice@example.com" } });
  assert.match(tryApplyEnvelope(t.ctx, { body: body3, webauthn: assertion(t.alice, body3, { ...CONSOLE, origin: "http://localhost:9999" }) }, { io: t.io }).reason, /画面が違う/);
  // owners.json にはいるが、この案件の担当者（profile の owners.technical）ではない人
  const bob = passkey();
  writeFileSync(join(t.dir, "docs", "standard", "owners.json"), JSON.stringify({ owners: [{ name: "Bob", email: "bob@example.com", passkeys: [bob.credential] }] }));
  const body4 = bodyOf({ ...planBody(t.ctx), role: "technical", by: { name: "Bob", email: "bob@example.com" } });
  assert.match(tryApplyEnvelope(t.ctx, { body: body4, webauthn: assertion(bob, body4, HUB) }, { io: t.io }).reason, /owners\.technical に載っていません/);
  assert.equal(loadControls(t.ctx).plan.approvals.technical, undefined);
});

test("ハブの設定がない案件・コンソールの番号がない案件では、署名された決定を受け付けない", () => {
  const t = setup({ config: {} });
  writeFileSync(join(t.dir, "docs", "standard", "hub.json"), JSON.stringify({ origin: "", rpId: "" }));
  assert.match(tryApplyEnvelope(t.ctx, t.tech(planBody(t.ctx)), { io: t.io }).reason, /設定されていない/);
  assert.match(tryApplyEnvelope(t.ctx, t.biz(planBody(t.ctx)), { io: t.io }).reason, /設定されていない/);
});

test("着手前の承認: ノードの定義に紐づく。定義が違えば反映しない", () => {
  const g = graphFor();
  g.nodes[1].before = ["technical"];
  const t = setup({ graph: g });
  const n = loadGraph(t.ctx).nodes.find((x) => x.id === "N2");
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ kind: "approve-before", target: "N2", binding: { nodeKey: "deadbeef" } }), { io: t.io }).reason, /定義が、決定のときと違/);
  applyEnvelope(t.ctx, t.tech({ kind: "approve-before", target: "N2", binding: { nodeKey: nodeKey(n) } }), { io: t.io });
  assert.equal(loadControls(t.ctx).approvals["N2:before"].technical.sha, nodeKey(n));
  // 業務担当者は、技術の着手前の承認を出せない（端末のコマンドと同じ検査）
  assert.match(tryApplyEnvelope(t.ctx, t.biz({ kind: "approve-before", target: "N2", binding: { nodeKey: nodeKey(n) } }), { io: t.io }).reason, /業務担当者の承認は要りません/);
});

test("変更案: 外部の接続先と設定を、承認されたら自動で当てる。差分は devkit が作る", () => {
  const t = setup();
  const ops = [
    { op: "profile.externalHosts.add", host: "API.Partner.co.jp" },
    { op: "config.set", path: "supervisor.hours", value: "22:00-07:00" },
  ];
  const plan = planChanges(t.ctx, ops);
  assert.deepEqual(plan.roles, ["technical"]);
  assert.match(plan.files["docs/profile.json"].diff, /\+ {5}"api\.partner\.co\.jp"/);
  assert.match(plan.files[".devkit/config.json"].diff, /\+ .*"hours": "22:00-07:00"/);
  assert.equal(readFileSync(join(t.dir, "docs", "profile.json"), "utf8").includes("partner"), false, "plan は書かない");

  // 業務担当者は承認できない
  assert.match(tryApplyEnvelope(t.ctx, t.biz({ kind: "change", changes: { ops, hash: plan.hash } }), { io: t.io }).reason, /標準オーナーです/);
  const env = t.tech({ kind: "change", changes: { ops, hash: plan.hash } });
  applyEnvelope(t.ctx, env, { io: t.io });
  assert.deepEqual(JSON.parse(readFileSync(join(t.dir, "docs", "profile.json"), "utf8")).externalHosts, ["api.partner.co.jp"]);
  assert.equal(JSON.parse(readFileSync(join(t.dir, ".devkit", "config.json"), "utf8")).supervisor.hours, "22:00-07:00");
  assert.match(decisionsMd(t.dir), /変更案 .*外部の接続先 api\.partner\.co\.jp を登録、設定 supervisor\.hours.*承認・適用/);
  assert.equal(git(t.dir, "status", "--porcelain"), "");
  assert.equal(loadControls(t.ctx).changes[plan.hash].status, "applied");
  // 記録は devkit が書いたものとして扱われる（封印に掛からない）
  assert.match(devkit(t.dir, ["seal"]).out, /すべて devkit のコマンドとランナーが書いたもの/);
});

test("変更案: 作った後に当てる先が変わっていたら当てない。署名した操作と違う操作も当てない", () => {
  const t = setup();
  const ops = [{ op: "profile.externalHosts.add", host: "api.partner.co.jp" }];
  const plan = planChanges(t.ctx, ops);
  const env = t.tech({ kind: "change", changes: { ops, hash: plan.hash } });
  const file = join(t.dir, "docs", "profile.json");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.replace('"tier": "lite"', '"tier": "ha"'));
  assert.match(tryApplyEnvelope(t.ctx, env, { io: t.io }).reason, /変わっています/);
  writeFileSync(file, before);
  // ハッシュはそのままに、操作だけ差し替える（署名は通るように作り直しても、ハッシュが合わない）
  const swapped = t.tech({ kind: "change", changes: { ops: [{ op: "profile.externalHosts.add", host: "evil.example.com" }], hash: plan.hash } });
  assert.match(tryApplyEnvelope(t.ctx, swapped, { io: t.io }).reason, /変わっています/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("変更案: 決まった種類の操作だけ。隔離をゆるめる設定・知らない操作・依存の追加は断る", () => {
  const t = setup();
  const bad = [
    [{ op: "config.set", path: "aiSandbox", value: "off" }, /変更案では変えられません/],
    [{ op: "config.set", path: "isolation.mode", value: "none" }, /変更案では変えられません/],
    [{ op: "config.set", path: "permissionMode", value: "bypassPermissions" }, /変更案では変えられません/],
    [{ op: "config.set", path: "supervisor.allowApiKey", value: true }, /変更案では変えられません/],
    [{ op: "config.set", path: "__proto__.x", value: 1 }, /変更案では変えられません/],
    [{ op: "config.set", path: "briefing.time", value: "25:00" }, /値が正しくない/],
    [{ op: "config.set", path: "hub.url", value: "http://insecure.example" }, /値が正しくない/],
    [{ op: "file.write", path: "src/x.ts", text: "x" }, /知らない操作/],
    [{ op: "constructor" }, /知らない操作/],
    [{ op: "dependency.add", name: "left-pad", version: "1.3.0" }, /まだ自動では当てません/],
    [{ op: "profile.externalHosts.add", host: "https://x.example/path" }, /ホスト名だけ/],
    [{ op: "profile.externalHosts.add", host: "a.example", extra: 1 }, /知らない項目/],
    [{ op: "profile.auth.set", value: "magic" }, /auth は/],
    [{ op: "exception.add", rules: ["ESC-06"], subject: "*", reason: "x", adr: "docs/adr/0001-x.md", reviewBy: "2099-01-01" }, /ESC-06/],
    [{ op: "exception.add", rules: ["TECH-01"], subject: "dependency:x", reason: "x", adr: "../outside.md", reviewBy: "2099-01-01" }, /docs\/adr\//],
    [{ op: "exception.add", rules: ["TECH-01"], subject: "dependency:x", reason: "x", adr: "docs/adr/0009-none.md", reviewBy: "2099-01-01" }, /がありません/],
    [{ op: "profile.owners.passkey.add", email: "nobody@example.com", credential: passkey().credential }, /owners\.business にいません/],
    [{ op: "profile.owners.passkey.add", email: "alice@example.com", credential: { id: "x", alg: "RS256", publicKey: "AAAA" } }, /公開鍵を使えません/],
  ];
  for (const [op, re] of bad) assert.throws(() => planChanges(t.ctx, [op]), re, JSON.stringify(op));
  assert.throws(() => planChanges(t.ctx, []), /1〜20件/);
  assert.match(planChanges(t.ctx, [{ op: "profile.auth.set", value: "sso-lineworks" }]).labels[0], /sso-lineworks/);
});

test("変更案: 標準の例外（ADR と一緒にコミット）・サイクル上限・業務担当者のパスキーの登録", () => {
  const t = setup();
  mkdirSync(join(t.dir, "docs", "adr"), { recursive: true });
  writeFileSync(join(t.dir, "docs", "adr", "0004-papaparse.md"), "# ADR-0004\n");
  writeFileSync(join(t.dir, "docs", "exceptions.json"), '{\n  "exceptions": []\n}\n');
  git(t.dir, "add", "docs/exceptions.json");
  git(t.dir, "commit", "-q", "-m", "exceptions");
  const second = passkey("ES256");
  const ops = [
    { op: "exception.add", rules: ["TECH-01"], subject: "dependency:papaparse", reason: "CSV の取り込み", adr: "docs/adr/0004-papaparse.md", reviewBy: "2099-05-31" },
    { op: "limits.addCycles", n: 5 },
    { op: "profile.owners.passkey.add", email: "alice@example.com", credential: { ...second.credential, label: "会社の PC" } },
  ];
  const plan = planChanges(t.ctx, ops);
  applyEnvelope(t.ctx, t.tech({ kind: "change", changes: { ops, hash: plan.hash } }), { io: t.io });
  const exc = JSON.parse(readFileSync(join(t.dir, "docs", "exceptions.json"), "utf8")).exceptions;
  assert.equal(exc.length, 1);
  assert.deepEqual({ id: exc[0].id, approvedBy: exc[0].approvedBy, subject: exc[0].subject }, { id: "EXC-001", approvedBy: "Tom", subject: "dependency:papaparse" });
  assert.equal(loadControls(t.ctx).maxCycles, 25, "計画の上限 20 に 5 を足す");
  assert.equal(git(t.dir, "status", "--porcelain"), "", "ADR も一緒にコミットされる");
  // 登録した2本目のパスキーで、業務担当者が署名できる
  const body = bodyOf({ ...planBody(t.ctx), role: "business", by: { name: "Alice", email: "alice@example.com" } });
  applyEnvelope(t.ctx, { body, webauthn: assertion(second, body, CONSOLE) }, { io: t.io });
  assert.equal(loadControls(t.ctx).plan.approvals.business.by, "Alice");
  // 同じ変更案（上限が 20 のときの「5 追加」）を、別の決定としてもう一度出しても当たらない
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ kind: "change", changes: { ops, hash: plan.hash } }), { io: t.io }).reason, /登録済み|変わっています/);
  const again = [{ op: "limits.addCycles", n: 5 }];
  const h1 = planChanges(t.ctx, again).hash;
  applyEnvelope(t.ctx, t.tech({ kind: "change", changes: { ops: again, hash: h1 } }), { io: t.io });
  assert.equal(loadControls(t.ctx).maxCycles, 30);
  assert.match(tryApplyEnvelope(t.ctx, t.tech({ kind: "change", changes: { ops: again, hash: h1 } }), { io: t.io }).reason, /変わっています/);
  assert.equal(loadControls(t.ctx).maxCycles, 30);
});

test("変更案: 2つの役割が要る操作（運用レベル）は、そろってから当てる", () => {
  const t = setup();
  const ops = [{ op: "profile.tier.set", value: "standard" }];
  const plan = planChanges(t.ctx, ops);
  assert.deepEqual(plan.roles, ["business", "technical"]);
  const tier = () => JSON.parse(readFileSync(join(t.dir, "docs", "profile.json"), "utf8")).tier;
  applyEnvelope(t.ctx, t.tech({ kind: "change", changes: { ops, hash: plan.hash } }), { io: t.io });
  assert.equal(tier(), "lite");
  assert.match(t.io.lines.join("\n"), /残り: 業務担当者/);
  applyEnvelope(t.ctx, t.biz({ kind: "change", changes: { ops, hash: plan.hash } }), { io: t.io });
  assert.equal(tier(), "standard");
  assert.equal(git(t.dir, "status", "--porcelain"), "");
});

test("ランナーが起動した AI からは、署名があっても反映しない", () => {
  const t = setup();
  const env = t.tech(planBody(t.ctx));
  process.env.DEVKIT_ROLE = "implementer";
  try {
    assert.match(tryApplyEnvelope(t.ctx, env, { io: t.io }).reason, /ランナーが起動した AI/);
  } finally {
    delete process.env.DEVKIT_ROLE;
  }
  assert.ok(checkEnvelope(t.ctx, env).who);
});

test("差分の表示: 変わった行と前後だけを出す", () => {
  const d = lineDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\n", 1);
  assert.equal(d, "  c\n- d\n+ X\n  e\n  …");
});
