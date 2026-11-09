import { z } from "zod";

// 環境変数はここで一括検証する。process.env を直接読まないこと（src/ の中で process.env を書いてよいのはこのファイルだけ）。
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const LogLevelSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.enum(LOG_LEVELS).default("info"),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string({ error: "DATABASE_URL がありません（本番では必ず指定する）" })
    .regex(/^(postgres(ql)?|pglite):\/\//, "DATABASE_URL は postgres:// か pglite:// で始める"),
  // 利用者の認証方式（src/server/auth/session.ts）
  // - dev: 開発用の利用者（役割は Cookie devkit-dev-role か DEV_AUTH_ROLE で切り替え）。next dev と E2E 用のビルドでだけ働く
  // - none: 認証なし（全員がログインしていない扱い。公開する画面は allowAnonymous を書く）
  // - better-auth: 本番の認証（認証を実装するまでは、全員がログインしていない扱い）
  AUTH_MODE: z.enum(["dev", "none", "better-auth"]),
  // 開発用の利用者の役割。役割の一覧（src/server/auth/roles.ts）にない値は無視する
  DEV_AUTH_ROLE: z.string().optional(),
  // ログの出力レベル（大文字小文字は区別しない。WARN でもよい）
  LOG_LEVEL: LogLevelSchema,
});

export type Env = z.infer<typeof EnvSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];

// 開発用 DB は Docker Compose の PostgreSQL（pnpm db:setup で起動とマイグレーション）
export const DEV_DATABASE_URL = "postgres://app:app@localhost:5432/app";

type Source = Record<string, string | undefined>;

function prepare(source: Source) {
  const nodeEnv = source.NODE_ENV ?? "development";
  // 未設定のときの既定:
  // - development: Docker Compose の PostgreSQL
  // - test: メモリ上の PGlite（自動テスト・ワーカーの worktree で Docker を不要にするため）
  // - production: 既定なし（指定がなければ起動時に失敗させ、誤った DB で動く事故を防ぐ。src/instrumentation.ts）
  const fallback = nodeEnv === "development" ? DEV_DATABASE_URL : nodeEnv === "test" ? "pglite://memory" : undefined;
  // AUTH_MODE の既定: 開発とテストは dev、本番は better-auth（開発用の利用者には決して倒さない）
  const authMode = source.AUTH_MODE ?? (nodeEnv === "production" ? "better-auth" : "dev");
  return { ...source, NODE_ENV: nodeEnv, DATABASE_URL: source.DATABASE_URL ?? fallback, AUTH_MODE: authMode };
}

export function loadEnv(source: Source = process.env): Env {
  return EnvSchema.parse(prepare(source));
}

// 設定の誤りを、利用者に見せてよい説明（値は含めない）の一覧にする。正しければ空の配列。
export function envProblems(source: Source = process.env): string[] {
  const parsed = EnvSchema.safeParse(prepare(source));
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`);
}

// 起動時の検査（src/instrumentation.ts）。本番のサーバーを起動するときだけ、設定の誤りを返す。
// next build の最中・開発・テストでは検査しない（空の配列）。
export function startupEnvProblems(source: Source = process.env): string[] {
  if ((source.NODE_ENV ?? "development") !== "production" || isBuildPhase(source)) return [];
  return envProblems(source);
}

// ログの出力レベル。ロガーは loadEnv が失敗する設定（本番で DATABASE_URL がないなど）でも動く必要があるので、
// LOG_LEVEL だけを個別に読み、不正な値や未設定なら info にする（ここでは例外を投げない）。
export function logLevel(source: Source = process.env): LogLevel {
  const parsed = LogLevelSchema.safeParse(source.LOG_LEVEL);
  return parsed.success ? parsed.data : "info";
}

// `next build` の最中か。Next.js はリクエスト時の API を使わない画面をビルド時にプリレンダリングするので、
// その最中に DB へ接続しようとしたら（= DB を読む画面が静的になっている）原因が分かるエラーで止めるために使う。
export function isBuildPhase(source: Source = process.env): boolean {
  return source.NEXT_PHASE === "phase-production-build";
}

// Node.js のランタイムで動いているか（src/instrumentation.ts で使う。Edge のランタイムでは false）。
// process.env.NEXT_RUNTIME は Next.js がビルド時に "nodejs" / "edge" に置き換える。
export const IS_NODE_RUNTIME = process.env.NEXT_RUNTIME === "nodejs";

// 開発用の利用者（AUTH_MODE=dev）を使えるビルドか。値は **next build の時点で決まり、起動時の環境変数では変えられない**。
// - process.env.NODE_ENV は Next.js がビルド時に文字列へ置き換える（next build では "production"、next dev では "development"）。
//   Vitest では置き換えず、実行時の "test" を読む。
// - process.env.DEVKIT_E2E_AUTH は next.config.ts の env で、ビルド時の値（"1" か "0"）に置き換える。
//   "1" でビルドするのは E2E 用のビルド（playwright.config.ts の webServer。出力先は .next-e2e/）だけ。
// 置き換えは `process.env.名前` と直接書いた箇所にだけ効く。分割代入や process.env[name] にすると起動時の値を読んでしまうので、この形を崩さない。
// 確かめ方: 通常の `pnpm build` の後、AUTH_MODE=dev で起動して Cookie を送ってもログイン扱いにならない（CLAUDE.md「コードの書き方」）。
export function devAuthBuildEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEVKIT_E2E_AUTH === "1";
}

// E2E 用のビルドか（本番モードで、DEVKIT_E2E_AUTH=1 でビルドしたもの）。これもビルド時に置き換わる。
export function isE2eBuild(): boolean {
  return process.env.NODE_ENV === "production" && process.env.DEVKIT_E2E_AUTH === "1";
}

// E2E 用のビルドで開発用ログインに要るトークン。Playwright を起動するたびに乱数で作り（playwright.config.ts）、
// next.config.ts の env でビルドに埋め込む。Cookie devkit-e2e-token がこれと一致しないと、E2E 用のビルドでもログインしない。
// そのため、残っている .next-e2e/ を別に起動しても、そのときの Playwright 以外は開発用ログインを使えない。
export function e2eAuthToken(): string {
  return process.env.DEVKIT_E2E_AUTH_TOKEN ?? "";
}

// next dev で動いているか（CSP で開発時だけ eval を許すために使う）。これもビルド時に置き換わる。
export function isDevServer(): boolean {
  return process.env.NODE_ENV === "development";
}
