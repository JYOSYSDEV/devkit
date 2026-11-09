import { startupEnvProblems } from "@/lib/env";
import { logger } from "@/lib/logger";

// 起動時の環境変数の検査（src/instrumentation.ts から、Node.js のランタイムでだけ呼ぶ）。
// 本番（NODE_ENV=production で、next build の最中ではないとき）に設定が足りない・誤っていれば、ログを書いてプロセスを止める。
// 例外を投げるだけでは Next.js は起動を続け、DB を使う画面がリクエストのたびに 500 になるため、止める。
export function checkStartupEnv(): void {
  const problems = startupEnvProblems();
  if (problems.length === 0) return;
  // 値は出さず、どの項目が誤っているかだけを書く
  logger.error("startup_env_invalid", { problems });
  process.exit(1);
}
