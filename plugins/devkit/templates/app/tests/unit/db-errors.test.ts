import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, pgPoolConfig } from "@/db/client";
import { DbError, dbErrorInfo } from "@/db/errors";
import { auditLogs } from "@/db/schema";
import { describeDbError } from "@/server/db-error";
import { createTestDb } from "../helpers/test-db";

// 例外が外に出たときに、値が見える経路をすべて確かめる（Next.js は console.error で例外を標準エラーに書く）
function everyView(err: unknown): string {
  const e = err as Error;
  return [String(e), e.message, e.stack, inspect(e, { depth: 10, showHidden: true }), JSON.stringify(e)].join("\n");
}

describe("DB の例外（defineAction の外でも値を出さない）", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  it("一意制約の違反は、SQLSTATE と制約名だけを持つ DbError になり、入力値・SQL・detail を含まない", async () => {
    await db.execute(sql`create table people (email text unique)`);
    const secret = "hanako.suzuki@example.co.jp";
    await db.execute(sql`insert into people (email) values (${secret})`);
    const err = await db.execute(sql`insert into people (email) values (${secret})`).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ code: "23505", constraint: "people_email_key", table: "people" });
    expect((err as Error).message).toContain("SQLSTATE 23505");
    expect((err as Error).cause).toBeUndefined();
    const all = everyView(err);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("hanako");
    expect(all).not.toContain("insert into");
  });

  it("型の誤り（メッセージに値が入る種類の例外）でも値を出さない", async () => {
    const secret = "secret-value-123";
    const err = await db.execute(sql`select ${secret}::int`).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "22P02" });
    expect(everyView(err)).not.toContain(secret);
  });

  it("クエリビルダの例外も同じ（drizzle の DrizzleQueryError のパラメータを出さない）", async () => {
    const secret = "クエリビルダの秘密の値";
    const err = await db
      .insert(auditLogs)
      // biome-ignore lint/suspicious/noExplicitAny: わざと不正な値を入れて DB の例外を起こす
      .values({ id: "not-a-number" as any, actorId: secret, action: "x", outcome: "success" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(everyView(err)).not.toContain(secret);
  });

  it("トランザクションの中の例外も DbError になる", async () => {
    const secret = "トランザクションの値";
    const err = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select ${secret}::int`);
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(everyView(err)).not.toContain(secret);
  });
});

describe("dbErrorInfo / describeDbError", () => {
  it("SQLSTATE は DB が返した例外（severity と code を持つもの）からだけ取る", () => {
    const pgError = Object.assign(new Error("duplicate key value"), {
      severity: "ERROR",
      code: "23505",
      constraint: "todos_title_key",
      detail: "Key (title)=(秘密) already exists.",
    });
    expect(dbErrorInfo({ cause: pgError })).toMatchObject({ code: "23505", constraint: "todos_title_key" });
  });

  it("Node.js のエラーコード（ECONNREFUSED・5文字の EPIPE など）は SQLSTATE と取り違えず errno にする", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
      code: "ECONNREFUSED",
      errno: -111,
    });
    const pipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(describeDbError(refused)).toEqual({
      isDbError: false,
      code: undefined,
      constraint: undefined,
      errno: "ECONNREFUSED",
    });
    expect(describeDbError(pipe)).toMatchObject({ code: undefined, errno: "EPIPE" });
    // localhost への接続は IPv6 と IPv4 の両方に失敗すると AggregateError になる
    const aggregate = new AggregateError([refused], "");
    expect(dbErrorInfo(aggregate).errno).toBe("ECONNREFUSED");
  });

  it("DbError のメッセージは識別子だけでできている", () => {
    expect(new DbError({ code: "23505", constraint: "people_email_key" }).message).toBe(
      "DB の処理に失敗しました（SQLSTATE 23505 unique_violation、制約 people_email_key）",
    );
    expect(new DbError({ errno: "ECONNREFUSED" }).message).toBe("DB の処理に失敗しました（errno ECONNREFUSED）");
  });
});

describe("PostgreSQL の接続の設定", () => {
  it("接続待ち・アイドル・SQL の実行時間に上限を付ける", () => {
    const config = pgPoolConfig("postgres://app:app@db:5432/app");
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
    expect(config.statement_timeout).toBeGreaterThan(0);
  });
});
