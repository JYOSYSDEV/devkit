import { describe, expect, it } from "vitest";
import { DEV_DATABASE_URL, isBuildPhase, loadEnv, logLevel, startupEnvProblems } from "@/lib/env";

describe("loadEnv", () => {
  it("本番で DATABASE_URL がなければ失敗する", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow();
  });

  it("開発では DATABASE_URL がなければ Docker Compose の PostgreSQL を使う", () => {
    expect(loadEnv({}).DATABASE_URL).toBe(DEV_DATABASE_URL);
  });

  it("テストでは DATABASE_URL がなければメモリ上の PGlite を使う", () => {
    expect(loadEnv({ NODE_ENV: "test" }).DATABASE_URL).toBe("pglite://memory");
  });

  it("postgres:// と pglite:// 以外は拒否する", () => {
    expect(() => loadEnv({ DATABASE_URL: "mysql://localhost/app" })).toThrow();
  });

  it("AUTH_MODE の既定は、開発とテストでは dev、本番では better-auth（開発用の利用者に倒さない）", () => {
    expect(loadEnv({}).AUTH_MODE).toBe("dev");
    expect(loadEnv({ NODE_ENV: "test" }).AUTH_MODE).toBe("dev");
    expect(loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://db/app" }).AUTH_MODE).toBe("better-auth");
  });

  it("AUTH_MODE は dev / none / better-auth だけを受け付ける", () => {
    expect(loadEnv({ AUTH_MODE: "none" }).AUTH_MODE).toBe("none");
    expect(() => loadEnv({ AUTH_MODE: "admin" })).toThrow();
  });

  it("DEV_AUTH_ROLE と LOG_LEVEL を読む（LOG_LEVEL の既定は info、不正な値は拒否する）", () => {
    const env = loadEnv({ DEV_AUTH_ROLE: "admin", LOG_LEVEL: "debug" });
    expect(env.DEV_AUTH_ROLE).toBe("admin");
    expect(env.LOG_LEVEL).toBe("debug");
    expect(loadEnv({}).LOG_LEVEL).toBe("info");
    expect(() => loadEnv({ LOG_LEVEL: "verbose" })).toThrow();
  });
});

describe("logLevel（ロガー用。例外を投げない）", () => {
  it("正しい値はそのまま（大文字小文字は区別しない）、未設定や不正な値は info", () => {
    expect(logLevel({ LOG_LEVEL: "warn" })).toBe("warn");
    expect(logLevel({ LOG_LEVEL: "WARN" })).toBe("warn");
    expect(loadEnv({ LOG_LEVEL: "Error" }).LOG_LEVEL).toBe("error");
    expect(logLevel({})).toBe("info");
    expect(logLevel({ LOG_LEVEL: "verbose" })).toBe("info");
  });

  it("loadEnv が失敗する設定（本番で DATABASE_URL なし）でも値を返す", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow();
    expect(logLevel({ NODE_ENV: "production", LOG_LEVEL: "error" })).toBe("error");
  });
});

describe("startupEnvProblems（起動時の検査。src/instrumentation.ts）", () => {
  it("本番で DATABASE_URL がなければ、起動を止める理由を返す（値は含めない）", () => {
    const problems = startupEnvProblems({ NODE_ENV: "production" });
    expect(problems.join("\n")).toContain("DATABASE_URL");
  });

  it("本番でも設定が正しければ何も返さない", () => {
    expect(startupEnvProblems({ NODE_ENV: "production", DATABASE_URL: "postgres://db/app" })).toEqual([]);
  });

  it("next build の最中・開発・テストでは検査しない", () => {
    expect(startupEnvProblems({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toEqual([]);
    expect(startupEnvProblems({ NODE_ENV: "development", DATABASE_URL: "mysql://x" })).toEqual([]);
    expect(startupEnvProblems({ NODE_ENV: "test" })).toEqual([]);
  });

  it("誤った値（パスワード付きの URL など）を理由の中に出さない", () => {
    const problems = startupEnvProblems({ NODE_ENV: "production", DATABASE_URL: "mysql://u:p4ss@h/db" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain("p4ss");
  });
});

describe("isBuildPhase", () => {
  it("next build の最中（NEXT_PHASE=phase-production-build）だけ true", () => {
    expect(isBuildPhase({ NEXT_PHASE: "phase-production-build" })).toBe(true);
    expect(isBuildPhase({ NEXT_PHASE: "phase-production-server" })).toBe(false);
    expect(isBuildPhase({})).toBe(false);
  });
});
