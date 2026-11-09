import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit は .env を読まないので、アプリ（Next.js）と同じ .env を読み込んでから接続先を決める。
// すでに設定されている環境変数は上書きされない。
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://app:app@localhost:5432/app", // 開発用 PostgreSQL（compose.yaml）
  },
});
