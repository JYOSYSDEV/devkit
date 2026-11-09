import { type LogLevel, logLevel } from "./env";

// 構造化ログ。1行1件の JSON を、info 以下は標準出力、warn 以上は標準エラーに書く。src/ では console を使わず、これを使う。
//
//   logger.info("todo_created", { todoId: row.id, userId: user.id });
//
// - イベント名は英小文字とアンダースコア（例: action_failed）。値は ID・件数・コードなどの識別子にする。
// - 個人情報・入力値そのもの・例外のメッセージ（DB の例外は SQL の値を含む）を渡さない。
//   念のため、キー名が個人情報や秘密情報らしいもの（email, phone, address, name, password, token, secret, url など）は値を伏せ、
//   文字列の中の接続文字列のパスワード（postgres://user:****@host）も伏せる。
// - time・level・event は fields で上書きできない。

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// キー名にこれらを含むと値を伏せる（大文字小文字・区切りの - と _ と空白は無視する）。伏せすぎは許容し、漏らさない側に倒す。
const SENSITIVE_KEY_PARTS = [
  "mail",
  "phone",
  "address",
  "name",
  "birth",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "token",
  "secret",
  "apikey",
  "privatekey",
  "authorization",
  "authentication",
  "cookie",
  "credential",
  "session",
  "card",
  "account",
  "mynumber",
  "connectionstring",
  "databaseurl",
  "dsn",
  "jwt",
  "bearer",
  "signature",
];
// 短い語は、キーの中の単語として一致したときだけ伏せる（tel は telNo・tel_no を伏せ、hotelId は伏せない）
const SENSITIVE_KEY_WORDS = ["tel", "fax", "pin", "otp", "auth", "pass", "key", "url", "uri"];
// 単語として一致しても伏せないキー（ログに必要な識別子）
const SAFE_KEYS = new Set(["requestid", "userid", "actorid"]);

export const REDACTED = "[REDACTED]";

export function isSensitiveKey(key: string): boolean {
  const words = key
    .split(/[-_\s.]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  const normalized = words.join("");
  if (SAFE_KEYS.has(normalized)) return false;
  if (words.some((w) => SENSITIVE_KEY_WORDS.includes(w))) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

// 文字列の中の URL の認証情報（scheme://user:password@host）のパスワードを伏せる
export function maskUrlCredentials(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]*@/gi, `$1${REDACTED}@`);
}

// Error に似たオブジェクト（name と message、または message と stack を持つもの）
function isErrorLike(value: object): value is { name?: unknown; message?: unknown } {
  const o = value as Record<string, unknown>;
  return typeof o.message === "string" && (typeof o.name === "string" || typeof o.stack === "string");
}

// 値の中のオブジェクトも、キー名で伏せる。例外（Error と Error に似たオブジェクト）はメッセージを出さず種類だけにする
// （メッセージや detail に入力値が入ることがあるため）。
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return maskUrlCredentials(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { errorType: value.name };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (isErrorLike(value)) return { errorType: typeof value.name === "string" ? value.name : "Error" };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const RESERVED = new Set(["time", "level", "event"]);

function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (ORDER[level] < ORDER[logLevel()]) return;
    const extra = redact(fields);
    const rest =
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? Object.fromEntries(Object.entries(extra).filter(([k]) => !RESERVED.has(k)))
        : {};
    const line = JSON.stringify({ time: new Date().toISOString(), level, event: maskUrlCredentials(event), ...rest });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  } catch {
    // ログの失敗で本来の処理を止めない（循環参照などで JSON にできない場合を含む）
  }
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};
