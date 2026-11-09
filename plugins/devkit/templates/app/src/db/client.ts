import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PoolConfig } from "pg";
import { isBuildPhase, loadEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { dbErrorInfo, installDbErrorSanitizer } from "./errors";
import * as schema from "./schema";

// アプリ本体・テストの両方で使える DB 型。サーバー処理はこの型を引数で受け取る。
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// DB の例外を、値（SQL のパラメータ = 入力値）を含まない DbError にする（src/db/errors.ts）。
// defineAction の外（画面・ルートハンドラ）で例外が起きても、Next.js の標準エラーに入力値が出ない。
installDbErrorSanitizer();

// PostgreSQL への接続の設定。時間切れを決めておき、DB が詰まったときにリクエストが溜まり続けないようにする。
export function pgPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: 10,
    // 接続を待つ上限（ミリ秒）。超えたら例外にする
    connectionTimeoutMillis: 5_000,
    // 使っていない接続を閉じるまでの時間
    idleTimeoutMillis: 30_000,
    // 1つの SQL の実行時間の上限（PostgreSQL の statement_timeout）
    statement_timeout: 30_000,
  };
}

let dbPromise: Promise<Db> | undefined;

// DATABASE_URL が postgres:// なら PostgreSQL（開発は Docker Compose、本番は共有の DB）に接続する。
// pglite://memory はメモリ上の PostgreSQL 17（PGlite）で、E2E とワーカーの worktree で使う。起動時にマイグレーションを適用する。
// PostgreSQL へのマイグレーションは人が pnpm db:setup（開発）/ pnpm db:migrate で適用する。
export function getDb(): Promise<Db> {
  if (isBuildPhase()) {
    // Next.js は、リクエスト時の API を使わない画面を `next build` でプリレンダリングする。
    // DB を読む画面がそうなると、ビルド時の DB（本番扱いで DATABASE_URL 未設定）に接続しようとして失敗するか、
    // ビルド時点のデータで固定された画面になる。
    throw new Error(
      "next build の最中に DB へ接続しようとしました。DB を読む画面は src/app/(app)/ の下に置くか（force-dynamic）、" +
        'そのページかルートで export const dynamic = "force-dynamic" を指定してください。',
    );
  }
  dbPromise ??= connect(loadEnv().DATABASE_URL).catch((e) => {
    dbPromise = undefined; // 失敗した接続を使い回さず、次の呼び出しでやり直す
    throw e;
  });
  return dbPromise;
}

async function connect(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dataDir = url.slice("pglite://".length);
    if (dataDir !== "memory") {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dataDir, { recursive: true });
    }
    const client = dataDir === "memory" ? new PGlite() : new PGlite(dataDir);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    return db as unknown as Db;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool(pgPoolConfig(url));
  // 使っていない接続が切れたときの例外。これを受けないとプロセスが落ちる。接続先や値は書かず、コードだけを残す。
  pool.on("error", (err) => {
    const { code, errno } = dbErrorInfo(err);
    logger.error("db_pool_error", { code, errno });
  });
  return drizzle(pool, { schema });
}
