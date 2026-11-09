import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/db/client";
import { installDbErrorSanitizer } from "@/db/errors";
import * as schema from "@/db/schema";

// アプリと同じく、DB の例外を値を含まない DbError にする（src/db/client.ts と同じ）
installDbErrorSanitizer();

// テストごとに使い捨ての PostgreSQL（PGlite, インプロセス）を作り、マイグレーションを適用する。
// Docker 不要・並列実行でも衝突しないので、worktree ごとの並列開発でもそのまま動く。
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db: db as unknown as Db, close: () => client.close() };
}
