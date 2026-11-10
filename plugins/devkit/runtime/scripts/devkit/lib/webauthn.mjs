// パスキー（WebAuthn）の署名の検証。依存パッケージなし（node:crypto だけ）。
//
// 決定の本体（JSON）を正規化して SHA-256 を取り、それを WebAuthn の challenge にして本人のパスキーで署名してもらう。
// ここでは、返ってきたアサーション（authenticatorData・clientDataJSON・signature）が、
//   - その本体に対するものか（challenge）
//   - 決めた画面（origin・rpId）で作られたか
//   - 本人確認（UV: 生体か PIN）が済んでいるか
//   - 登録された公開鍵で検証できるか
// を確かめる。公開鍵は、案件の中の封印されたファイル（docs/standard/owners.json・docs/profile.json）から渡す。
import { createHash, createPublicKey, verify } from "node:crypto";

const B64U = /^[A-Za-z0-9_-]+$/;

export function b64uDecode(s) {
  if (typeof s !== "string" || !B64U.test(s)) return null;
  return Buffer.from(s, "base64url");
}

export function b64uEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

// 正規化した JSON（キーを文字コード順に並べ、空白を入れない）。ブラウザの側も同じ規則で作る。
// 数は整数だけ（小数・指数は実装によって書き方が変わるので使わない）。undefined・関数などは受け付けない
export function canonical(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("正規化できない数（整数だけ）");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  throw new Error("正規化できない値");
}

export function bodyHash(body) {
  return createHash("sha256").update(canonical(body)).digest();
}

export const ALGS = ["ES256", "EdDSA"];

// 登録されたパスキー { id, alg, publicKey（SPKI の DER を base64url にしたもの） } から公開鍵を作る。
// 使えるのは ES256（P-256）と EdDSA（Ed25519）だけ。合わなければ理由を投げる
export function loadCredentialKey(cred) {
  if (!cred || typeof cred !== "object") throw new Error("パスキーの記録がない");
  if (!ALGS.includes(cred.alg)) throw new Error(`使えない署名の方式（${cred.alg ?? "なし"}）。ES256 か EdDSA`);
  const der = b64uDecode(cred.publicKey);
  if (!der) throw new Error("公開鍵が base64url ではない");
  let key;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("公開鍵を読めない（SPKI の DER ではない）");
  }
  if (cred.alg === "ES256" && !(key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1")) throw new Error("ES256 の鍵が P-256 ではない");
  if (cred.alg === "EdDSA" && key.asymmetricKeyType !== "ed25519") throw new Error("EdDSA の鍵が Ed25519 ではない");
  return key;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

// アサーションを検証する。合えば null、合わなければ理由（文字列）を返す
export function assertionProblem({ body, webauthn, credential, origin, rpId }) {
  if (!origin || !rpId) return "署名を確かめる画面（origin・rpId）が設定されていない";
  if (!webauthn || typeof webauthn !== "object") return "署名（webauthn）がない";
  if (!credential || webauthn.credentialId !== credential.id) return "登録されたパスキーの署名ではない";
  const authData = b64uDecode(webauthn.authenticatorData);
  const clientRaw = b64uDecode(webauthn.clientDataJSON);
  const signature = b64uDecode(webauthn.signature);
  if (!authData || !clientRaw || !signature) return "署名の形式が正しくない（base64url）";
  let client;
  try {
    client = JSON.parse(clientRaw.toString("utf8"));
  } catch {
    return "clientDataJSON を読めない";
  }
  if (client?.type !== "webauthn.get") return "署名の種類が違う（webauthn.get ではない）";
  let want;
  try {
    want = b64uEncode(bodyHash(body));
  } catch (e) {
    return `決定の本体を正規化できない（${e.message}）`;
  }
  if (client.challenge !== want) return "署名が、この決定の内容に対するものではない（challenge が合わない）";
  if (client.origin !== origin) return `署名が作られた画面が違う（${String(client.origin).slice(0, 80)}）`;
  if (client.crossOrigin === true) return "別のサイトに埋め込まれた画面で作られた署名は受け付けない";
  if (authData.length < 37) return "authenticatorData が短い";
  if (!authData.subarray(0, 32).equals(createHash("sha256").update(rpId).digest())) return "署名の rpId が違う";
  const flags = authData[32];
  if (!(flags & FLAG_UP)) return "本人の操作（UP）がない署名";
  if (!(flags & FLAG_UV)) return "本人確認（UV: 生体か PIN）が済んでいない署名";
  let key;
  try {
    key = loadCredentialKey(credential);
  } catch (e) {
    return e.message;
  }
  const signed = Buffer.concat([authData, createHash("sha256").update(clientRaw).digest()]);
  let ok = false;
  try {
    ok = credential.alg === "ES256" ? verify("sha256", signed, { key, dsaEncoding: "der" }, signature) : verify(null, signed, key, signature);
  } catch {
    ok = false;
  }
  return ok ? null : "署名が公開鍵と合わない";
}
