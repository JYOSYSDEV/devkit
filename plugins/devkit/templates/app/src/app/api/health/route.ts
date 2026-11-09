import { getDb } from "@/db/client";
import { logger } from "@/lib/logger";
import { allowAnonymous } from "@/server/auth/guard";
import { describeDbError, errorType } from "@/server/db-error";
import { checkDb } from "@/server/health";

export const dynamic = "force-dynamic";

// 死活監視と E2E の起動待ちに使う
export async function GET() {
  allowAnonymous("ヘルスチェック");
  try {
    await checkDb(await getDb());
    return Response.json({ status: "ok", db: "ok" });
  } catch (err) {
    const { code, errno } = describeDbError(err);
    logger.error("health_check_failed", { errorType: errorType(err), code, errno });
    return Response.json({ status: "error", db: "unavailable" }, { status: 503 });
  }
}
