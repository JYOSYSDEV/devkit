import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";

// DB に接続できるかを確かめる（ヘルスチェック用）。DB の操作は src/server に置く（ARCH-02）
export async function checkDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
