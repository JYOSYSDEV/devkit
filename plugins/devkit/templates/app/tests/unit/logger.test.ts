import { afterEach, describe, expect, it, vi } from "vitest";
import { isSensitiveKey, logger, REDACTED, redact } from "@/lib/logger";

function capture() {
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, "write").mockImplementation(collect);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(collect);
  return {
    lines,
    stdout: out,
    stderr: err,
  };
}

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("1行1件の JSON を書き、warn 以上は標準エラーに出す", () => {
    const c = capture();
    logger.info("todo_created", { todoId: 1 });
    logger.error("action_failed", { code: "23505" });
    expect(c.stdout).toHaveBeenCalledTimes(1);
    expect(c.stderr).toHaveBeenCalledTimes(1);
    const info = JSON.parse(c.lines[0] ?? "");
    expect(info).toMatchObject({ level: "info", event: "todo_created", todoId: 1 });
    expect(typeof info.time).toBe("string");
  });

  it("個人情報や秘密情報らしいキーの値を伏せる（入れ子も）", () => {
    const c = capture();
    logger.info("user_updated", {
      userId: "u-1",
      email: "taro@example.co.jp",
      user: { fullName: "山田太郎", phone: "090-0000-0000", address: "東京都", tel: "03-0000-0000" },
      password: "p@ss",
      accessToken: "abc",
      client_secret: "xyz",
      items: [{ mailAddress: "a@example.co.jp" }],
    });
    const line = c.lines.join("");
    for (const value of [
      "taro@example.co.jp",
      "山田太郎",
      "090-0000-0000",
      "東京都",
      "03-0000-0000",
      "p@ss",
      "abc",
      "xyz",
    ]) {
      expect(line).not.toContain(value);
    }
    expect(line).not.toContain("a@example.co.jp");
    expect(JSON.parse(line)).toMatchObject({ userId: "u-1", email: REDACTED, user: { fullName: REDACTED } });
  });

  it("Error はメッセージを出さず、種類だけにする", () => {
    expect(redact({ err: new TypeError("secret value 123") })).toEqual({ err: { errorType: "TypeError" } });
  });

  it("キー名の判定", () => {
    for (const key of [
      "email",
      "Email",
      "user_name",
      "phoneNumber",
      "tel",
      "telNo",
      "tel_no",
      "faxNumber",
      "homeAddress",
      "apiKey",
      "authorization",
      "databaseUrl",
      "DATABASE_URL",
      "connectionString",
      "url",
      "callbackUrl",
      "privateKey",
      "private_key",
      "passphrase",
      "jwt",
      "otp",
      "bearer",
      "auth",
      "cookie",
      "set-cookie",
      "Set-Cookie",
      "AUTHORIZATION",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["userId", "action", "code", "constraint", "requestId", "count", "hotel_id", "mode", "errno"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("文字列の中の接続文字列のパスワードを伏せる", () => {
    const c = capture();
    logger.error("db_failed", { note: "postgres://app:p4ssw0rd@db.internal:5432/app に接続できない" });
    expect(c.lines.join("")).not.toContain("p4ssw0rd");
    expect(c.lines.join("")).toContain("postgres://app:[REDACTED]@db.internal");
  });

  it("Error でない、Error に似たオブジェクト（DB の例外を JSON にしたものなど）も種類だけにする", () => {
    const pgLike = { name: "DatabaseError", message: "invalid input syntax: 秘密", detail: "Key (x)=(秘密)" };
    expect(redact({ err: pgLike })).toEqual({ err: { errorType: "DatabaseError" } });
    expect(redact({ e: { message: "秘密", stack: "Error: 秘密\n at x" } })).toEqual({ e: { errorType: "Error" } });
  });

  it("time・level・event は fields で上書きできない", () => {
    const c = capture();
    logger.error("real_event", { time: "1970-01-01", level: "debug", event: "fake_event", userId: "u-1" });
    const line = JSON.parse(c.lines[0] ?? "{}");
    expect(line).toMatchObject({ level: "error", event: "real_event", userId: "u-1" });
    expect(line.time).not.toBe("1970-01-01");
  });

  it("LOG_LEVEL は大文字小文字を区別しない", () => {
    vi.stubEnv("LOG_LEVEL", "WARN");
    const c = capture();
    logger.info("skipped");
    logger.warn("written");
    expect(c.lines).toHaveLength(1);
  });

  it("LOG_LEVEL より低いレベルは書かない", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const c = capture();
    logger.info("skipped");
    logger.warn("written");
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain('"written"');
  });

  it("環境変数の設定が誤っていても（本番で DATABASE_URL なし・LOG_LEVEL が不正）ロガー自体は例外を投げない", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("LOG_LEVEL", "verbose");
    const c = capture();
    expect(() => logger.error("startup_failed", { reason: "env" })).not.toThrow();
    expect(c.lines).toHaveLength(1);
  });

  it("JSON にできない値でも例外を投げない", () => {
    const c = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("circular", { circular })).not.toThrow();
    expect(c.lines.length).toBeLessThanOrEqual(1);
  });
});
