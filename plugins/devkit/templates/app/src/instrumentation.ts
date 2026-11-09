import { IS_NODE_RUNTIME } from "@/lib/env";

// サーバーの起動時に1回だけ呼ばれる（Next.js の instrumentation）。
// 本番で環境変数（DATABASE_URL など）が足りなければ、起動を止める（src/server/startup-check.ts）。
export async function register() {
  if (IS_NODE_RUNTIME) {
    const { checkStartupEnv } = await import("@/server/startup-check");
    checkStartupEnv();
  }
}
