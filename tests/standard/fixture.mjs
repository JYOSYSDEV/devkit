// 標準チェッカーのテスト用の案件（テンプレートと同じ構成）を一時ディレクトリに作る
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const RUNTIME = path.join(REPO, "plugins", "devkit", "runtime");
export const CHECK = path.join(RUNTIME, "scripts", "standard", "check.mjs");
export const STANDARD = path.join(RUNTIME, "docs", "standard");

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

export const PACKAGE_JSON = {
  name: "devkit-app",
  version: "0.1.0",
  private: true,
  type: "module",
  packageManager: "pnpm@10.28.0",
  engines: { node: ">=22.12" },
  scripts: {
    dev: "next dev",
    build: "next build",
    "build:e2e": "DEVKIT_E2E_AUTH=1 next build",
    start: "next start",
    lint: "biome check .",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "test:e2e": "playwright test",
    "db:setup": "docker compose up -d --wait db && drizzle-kit migrate",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "standard:check": "node scripts/standard/check.mjs",
    "standard:release": "node scripts/standard/check.mjs --release",
    verify: "pnpm lint && pnpm typecheck && pnpm standard:check && pnpm test",
  },
  dependencies: {
    "@electric-sql/pglite": "0.5.15",
    clsx: "2.1.1",
    "drizzle-orm": "0.45.4",
    next: "16.4.5",
    pg: "8.16.3",
    react: "19.3.1",
    "react-dom": "19.3.1",
    "tailwind-merge": "3.3.1",
    zod: "4.6.7",
  },
  devDependencies: {
    "@biomejs/biome": "2.6.6",
    "@playwright/test": "1.65.0",
    "@tailwindcss/postcss": "4.3.5",
    "@types/node": "24.0.0",
    "@types/pg": "8.15.5",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.2.0",
    "drizzle-kit": "0.31.11",
    tailwindcss: "4.3.5",
    typescript: "6.0.3",
    vitest: "5.1.0",
  },
  pnpm: { onlyBuiltDependencies: ["esbuild"] },
};

export const PROFILE = {
  project: "__PROJECT_TITLE__",
  owners: {
    business: [{ name: "", email: "" }],
    technical: [{ name: "", email: "" }],
  },
  tier: "lite",
  users: "社内の1部署・数十人",
  personalData: { stored: false, items: [] },
  auth: "dev",
  externalHosts: [],
  released: false,
  releasedMigration: "",
};

/** テンプレート（＋安全の仕組みの雛形）と同じ構成のファイル */
export function templateFiles() {
  return {
    "package.json": json(PACKAGE_JSON),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n",
    ".nvmrc": "24\n",
    ".gitignore": "node_modules/\n.next/\n.env\n.env.*\n!.env.example\n.claude/worktrees/\n",
    ".env.example": "# 開発用 DB（Docker Compose の PostgreSQL 17）\nDATABASE_URL=postgres://app:app@localhost:5432/app\n",
    ".dockerignore": "node_modules\n.next\n.env\n.env.*\n!.env.example\n.git\n",
    Dockerfile: `# 本番用イメージ（Next.js standalone 出力）
# DB のマイグレーションはイメージに含めない。デプロイの手順で人が pnpm db:migrate を実行する。
FROM node:24-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_OUTPUT=standalone
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
USER app
EXPOSE 3000
CMD ["node", "server.js"]
`,
    "compose.yaml": `# 開発用 PostgreSQL 17
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
`,
    ".github/workflows/ci.yml": `name: ci
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - run: pnpm build:e2e
        env:
          DEVKIT_E2E_AUTH: "1"
          AUTH_MODE: dev
      - run: pnpm test:e2e
`,
    "drizzle.config.ts": `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://app:app@localhost:5432/app" },
});
`,
    "next.config.ts": `import type { NextConfig } from "next";

// セキュリティヘッダ（SEC-06）。開発中だけ React の再読み込みのために 'unsafe-eval' を足す。
const isDev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  \`script-src 'self' 'unsafe-inline'\${isDev ? " 'unsafe-eval'" : ""}\`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
`,
    "src/app/layout.tsx": `import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "devkit app" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
`,
    "src/app/page.tsx": `import { allowAnonymous } from "@/server/auth/guard";

export default function Home() {
  allowAnonymous("トップページは案内だけで、利用者の情報を表示しない");
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">devkit app</h1>
      <p className="mt-4 text-gray-600">このページは雛形です。詳しくは https://example.com を見る</p>
    </main>
  );
}
`,
    "src/app/error.tsx": `"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>エラーが発生しました。時間をおいてもう一度試してください。</p>
      <button type="button" onClick={() => reset()}>
        もう一度試す
      </button>
    </div>
  );
}
`,
    "src/app/(app)/layout.tsx": `import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return children;
}
`,
    "src/app/(app)/todos/page.tsx": `import { AccessDenied } from "@/components/access-denied";
import { getDb } from "@/db/client";
import { requirePermission } from "@/server/auth/guard";
import { listTodos } from "@/server/todos";
import { TodoForm } from "./components/todo-form";

export default async function TodosPage() {
  const access = await requirePermission("todos.read");
  if (!access.ok) return <AccessDenied message={access.message} />;
  const { user } = access;
  const todos = await listTodos(await getDb());
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">やること（{user.name}）</h1>
      <TodoForm />
      <ul>
        {todos.map((t) => (
          <li key={t.id}>{t.title}</li>
        ))}
      </ul>
    </main>
  );
}
`,
    "src/app/(app)/todos/actions.ts": `"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/action";
import { CreateTodoInput, completeTodo, createTodo } from "@/server/todos";

export const createTodoAction = defineAction({
  permission: "todos.create",
  input: CreateTodoInput,
  audit: true,
  async handler(input, { db }) {
    const row = await createTodo(db, input);
    revalidatePath("/todos");
    return { message: "登録しました", auditTarget: String(row.id) };
  },
});

export const completeTodoAction = defineAction({
  permission: "todos.complete",
  input: z.object({ id: z.coerce.number().int().positive() }),
  audit: true,
  handler: async ({ id }, { db }) => {
    await completeTodo(db, id);
    revalidatePath("/todos");
    return { message: "完了にしました", auditTarget: String(id) };
  },
});
`,
    "src/app/(app)/todos/components/todo-form.tsx": `"use client";

import { useActionState } from "react";
import type { ActionState } from "@/server/action";
import { createTodoAction } from "../actions";

const initial: ActionState = { ok: true, message: "" };

export function TodoForm() {
  const [state, formAction, pending] = useActionState(createTodoAction, initial);
  return (
    <form action={formAction}>
      <label htmlFor="title">タイトル</label>
      <input id="title" name="title" aria-describedby="title-error" />
      <p id="title-error">{state.fieldErrors?.title?.[0]}</p>
      <button type="submit" disabled={pending}>
        登録
      </button>
      <p role="status">{state.message}</p>
    </form>
  );
}
`,
    "src/app/api/health/route.ts": `import { getDb } from "@/db/client";
import { allowAnonymous } from "@/server/auth/guard";
import { checkHealth } from "@/server/health";

export const dynamic = "force-dynamic";

export async function GET() {
  allowAnonymous("監視とロードバランサーが認証なしで呼ぶ。DB の状態だけを返す");
  const ok = await checkHealth(await getDb());
  return ok ? Response.json({ status: "ok", db: "ok" }) : Response.json({ status: "error", db: "unavailable" }, { status: 503 });
}
`,
    "src/components/access-denied.tsx": `export function AccessDenied({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div role="alert">{message}</div>
    </main>
  );
}
`,
    "src/server/action.ts": `import { z } from "zod";
import { type Db, getDb } from "@/db/client";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/server/audit";
import { can, type Permission } from "@/server/auth/permissions";
import { getCurrentUser, type User } from "@/server/auth/session";

export type ActionState = { ok: boolean; message: string; fieldErrors?: Record<string, string[] | undefined> };

type Result = { message: string; auditTarget?: string };

type ActionDefinition<S extends z.ZodType> = {
  permission: Permission;
  input: S;
  audit: boolean;
  handler: (input: z.infer<S>, ctx: { db: Db; user: User }) => Promise<Result>;
};

// データの更新は必ずこれを通す: 利用者 → 権限（拒否も監査ログ）→ 入力の検証 → 処理と監査ログを1つのトランザクションで → 日本語のメッセージ
export function defineAction<S extends z.ZodType>(def: ActionDefinition<S>) {
  return async (_prev: ActionState, formData: FormData): Promise<ActionState> => {
    const user = await getCurrentUser();
    if (!user) return { ok: false, message: "ログインしてください" };
    const db = await getDb();
    if (!can(user.role, def.permission)) {
      await writeAudit(db, { actorId: user.id, action: def.permission, result: "denied" });
      return { ok: false, message: "この操作の権限がありません" };
    }
    const parsed = def.input.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "入力を確認してください", fieldErrors: z.flattenError(parsed.error).fieldErrors };
    try {
      const result = await db.transaction(async (tx) => {
        const r = await def.handler(parsed.data, { db: tx as unknown as Db, user });
        if (def.audit) await writeAudit(tx as unknown as Db, { actorId: user.id, action: def.permission, target: r.auditTarget, result: "ok" });
        return r;
      });
      return { ok: true, message: result.message };
    } catch (e) {
      logger.error("action failed", { action: def.permission, error: e instanceof Error ? e.name : "unknown" });
      return { ok: false, message: "処理に失敗しました。時間をおいてもう一度試してください" };
    }
  };
}
`,
    "src/server/audit.ts": `import type { Db } from "@/db/client";
import { auditLogs } from "@/db/schema";

export type AuditEntry = { actorId: string; action: string; target?: string; result: "ok" | "denied" };

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values(entry);
}
`,
    "src/server/auth/permissions.ts": `// 権限表（誰が何をできるか）。変えたら業務ゲートで確認する（ESC-03）
export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "todos.read": ["admin", "member", "viewer"],
  "todos.create": ["admin", "member"],
  "todos.complete": ["admin", "member"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
`,
    "src/server/auth/session.ts": `import { cookies } from "next/headers";
import { loadEnv } from "@/lib/env";
import type { Role } from "./permissions";

export type User = { id: string; name: string; role: Role };

// 開発用の認証（AUTH_MODE=dev）。本番のビルドでは DEVKIT_E2E_AUTH=1 のときだけ有効
export async function getCurrentUser(): Promise<User | null> {
  const env = loadEnv();
  if (env.AUTH_MODE !== "dev") return null;
  const role = ((await cookies()).get("dev-role")?.value ?? "member") as Role;
  return { id: "dev-user", name: "開発用の利用者", role };
}
`,
    "src/server/auth/guard.ts": `import { can, type Permission } from "./permissions";
import { getCurrentUser, type User } from "./session";

export type Access = { ok: true; user: User } | { ok: false; status: 401 | 403; message: string };

export async function requireUser(): Promise<Access> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, message: "ログインしてください" };
  return { ok: true, user };
}

export async function requirePermission(permission: Permission): Promise<Access> {
  const access = await requireUser();
  if (!access.ok) return access;
  if (!can(access.user.role, permission)) return { ok: false, status: 403, message: "閲覧する権限がありません" };
  return access;
}

export function deniedResponse(access: Extract<Access, { ok: false }>): Response {
  return Response.json({ error: access.message }, { status: access.status });
}

/** 認証なしで公開する入口に、理由とともに書く */
export function allowAnonymous(reason: string): void {
  if (!reason.trim()) throw new Error("allowAnonymous には理由を書く");
}
`,
    "src/server/todos.ts": `import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { type Todo, todos } from "@/db/schema";

export const CreateTodoInput = z.object({
  title: z.string().trim().min(1, "タイトルは必須です").max(200),
});

export async function createTodo(db: Db, input: unknown): Promise<Todo> {
  const { title } = CreateTodoInput.parse(input);
  const [row] = await db.insert(todos).values({ title }).returning();
  if (!row) throw new Error("insert failed");
  return row;
}

export async function listTodos(db: Db): Promise<Todo[]> {
  return db.select().from(todos).orderBy(asc(todos.id));
}

export async function completeTodo(db: Db, id: number): Promise<Todo | undefined> {
  const [row] = await db.update(todos).set({ done: true }).where(eq(todos.id, id)).returning();
  return row;
}
`,
    "src/server/health.ts": `import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { logger } from "@/lib/logger";

export async function checkHealth(db: Db): Promise<boolean> {
  try {
    await db.execute(sql\`select 1\`);
    return true;
  } catch (e) {
    logger.error("health check failed", { error: e instanceof Error ? e.name : "unknown" });
    return false;
  }
}
`,
    "src/db/schema.ts": `import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  result: text("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Todo = typeof todos.$inferSelect;
`,
    "src/db/client.ts": `import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { isBuildPhase, loadEnv } from "@/lib/env";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let dbPromise: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  if (isBuildPhase()) throw new Error("next build の最中に DB へ接続しようとしました");
  dbPromise ??= connect(loadEnv().DATABASE_URL);
  return dbPromise;
}

async function connect(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const db = drizzle(new PGlite(), { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    return db as unknown as Db;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return drizzle(new Pool({ connectionString: url }), { schema });
}
`,
    "src/lib/env.ts": `import { z } from "zod";

// 環境変数はここで一括検証する。process.env を直接読まないこと。
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().regex(/^(postgres(ql)?|pglite):\\/\\//, "DATABASE_URL は postgres:// か pglite:// で始める"),
  AUTH_MODE: z.enum(["dev", "better-auth"]).default("dev"),
});

export type Env = z.infer<typeof EnvSchema>;

export const DEV_DATABASE_URL = "postgres://app:app@localhost:5432/app";

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  const fallback = nodeEnv === "development" ? DEV_DATABASE_URL : nodeEnv === "test" ? "pglite://memory" : undefined;
  return EnvSchema.parse({ ...source, NODE_ENV: nodeEnv, DATABASE_URL: source.DATABASE_URL ?? fallback });
}

export function isBuildPhase(source: Record<string, string | undefined> = process.env): boolean {
  return source.NEXT_PHASE === "phase-production-build";
}
`,
    "src/lib/logger.ts": `type Level = "debug" | "info" | "warn" | "error";

// 構造化ログ（1行1つの JSON）。入力値・個人情報・秘密情報は渡さない（SEC-10）
function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(\`\${JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })}\\n\`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
`,
    "src/lib/utils.ts": `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
    "drizzle/0000_init.sql": `CREATE TABLE "todos" (
\t"id" serial PRIMARY KEY NOT NULL,
\t"title" text NOT NULL,
\t"done" boolean DEFAULT false NOT NULL,
\t"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
\t"id" serial PRIMARY KEY NOT NULL,
\t"actor_id" text NOT NULL,
\t"action" text NOT NULL,
\t"target" text,
\t"result" text NOT NULL,
\t"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
`,
    "drizzle/meta/_journal.json": json({ version: "7", dialect: "postgresql", entries: [{ idx: 0, tag: "0000_init" }] }),
    "tests/helpers/test-db.ts": `import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db: db as unknown as Db, close: () => client.close() };
}
`,
    "tests/unit/todos.test.ts": `import { describe, expect, it } from "vitest";
import { todos } from "@/db/schema";
import { createTodo } from "@/server/todos";
import { createTestDb } from "../helpers/test-db";

describe("createTodo", () => {
  it("[AC-1] 登録できる", async () => {
    const { db, close } = await createTestDb();
    await createTodo(db, { title: "a" });
    expect(await db.select().from(todos)).toHaveLength(1);
    await close();
  });
});
`,
    "e2e/smoke.spec.ts": `import { expect, test } from "@playwright/test";

test("ヘルスチェックが DB まで ok を返す", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
});
`,
    "docs/profile.json": json(PROFILE),
    "docs/exceptions.json": json({ exceptions: [] }),
    "docs/runbook.md": `# 運用手順書: __PROJECT_TITLE__

## 1. 起動と停止

（記入）

## 2. デプロイ

（記入）

## 3. マイグレーション

（記入）

## 4. バックアップと復元

（記入）

## 5. 監視と通知

（記入）

## 6. 障害時の連絡先

（記入）
`,
    "docs/adr/0001-standard-stack.md": "# ADR-0001: 標準スタックを採用する\n\n- 状態: 承認\n",
  };
}

/** リリースの準備ができた状態に書き換える（--release が通る） */
export function releaseReady(files) {
  const profile = {
    ...PROFILE,
    project: "備品管理",
    owners: {
      business: [{ name: "業務 太郎", email: "gyomu@example.co.jp" }],
      technical: [{ name: "技術 花子", email: "gijutsu@example.co.jp" }],
    },
    auth: "better-auth",
  };
  const pkg = JSON.parse(files["package.json"]);
  pkg.dependencies["better-auth"] = "1.4.2";
  const runbook = files["docs/runbook.md"].replace(/（記入）/g, "手順を書いた。");
  return {
    ...files,
    "package.json": json(pkg),
    "docs/profile.json": json(profile),
    "docs/runbook.md": runbook,
    "src/server/auth/auth.ts": `import { betterAuth } from "better-auth";

export const auth = betterAuth({ emailAndPassword: { enabled: true } });
`,
    "src/server/auth/session.ts": `import { headers } from "next/headers";
import { auth } from "./auth";
import type { Role } from "./permissions";

export type User = { id: string; name: string; role: Role };

export async function getCurrentUser(): Promise<User | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return { id: session.user.id, name: session.user.name, role: "member" };
}
`,
  };
}

/** 一時ディレクトリに案件を作る。files の値が null のファイルは作らない */
export function makeProject(files = templateFiles(), { withStandard = true, withChecker = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devkit-standard-"));
  if (withStandard) cpSync(STANDARD, path.join(dir, "docs", "standard"), { recursive: true });
  if (withChecker) {
    mkdirSync(path.join(dir, "scripts", "standard"), { recursive: true });
    cpSync(CHECK, path.join(dir, "scripts", "standard", "check.mjs"));
  }
  for (const [rel, content] of Object.entries(files)) {
    if (content == null) continue;
    write(dir, rel, content);
  }
  return dir;
}

export function write(dir, rel, content) {
  const file = path.join(dir, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function read(dir, rel) {
  return readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

export function remove(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** チェッカーを実行する。JSON の結果を返す */
export function run(dir, args = [], { cwd = dir } = {}) {
  const r = spawnSync(process.execPath, [CHECK, "--json", ...args], { cwd, encoding: "utf8" });
  let result = null;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    result = null;
  }
  return { code: r.status, result, stdout: r.stdout, stderr: r.stderr };
}

/** テキストで実行する（--json なし） */
export function runText(dir, args = [], { cwd = dir } = {}) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** git リポジトリにしてすべてをコミットし、そのコミットを返す */
export function gitInit(dir) {
  git(dir, "init", "-q", "-b", "main");
  return commitAll(dir, "init");
}

export function commitAll(dir, message = "change") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** 違反のルール ID（重複なし） */
export const ruleIds = (result) => [...new Set(result.violations.map((v) => v.rule))].sort();
export const flagIds = (result) => [...new Set(result.flags.map((f) => f.rule))].sort();
