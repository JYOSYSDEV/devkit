# 本番用イメージ（Next.js standalone 出力）。デプロイ先に依存しない形でここまでを標準とする。
# ビルドコンテキストから除くもの（node_modules・.env・.git・worktree など）は .dockerignore にある。
# DB のマイグレーションはアプリの起動時には流さない。デプロイの手順で人が、下の migrate のイメージで流す（docs/runbook.md）。
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
# Host を書き換えるリバースプロキシの後ろに置くときの、Server Action を受け付けるホスト（カンマ区切り。docs/runbook.md）。
# standalone ではビルドの時点の値が使われるので、docker build --build-arg で渡す。
ARG SERVER_ACTIONS_ALLOWED_ORIGINS=""
RUN pnpm build

# マイグレーション用のイメージ（drizzle/ と drizzle-kit を含む）。アプリのイメージとは別に作り、デプロイの前に人が実行する:
#   docker build --target migrate -t <名前>-migrate .
#   docker run --rm -e DATABASE_URL=postgres://… <名前>-migrate ./node_modules/.bin/drizzle-kit migrate
FROM node:24-alpine AS migrate
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
USER node

# アプリのイメージ（既定の target。最後の段に置く）
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone の server.js は HOSTNAME で待ち受ける。Docker は HOSTNAME にコンテナ ID を入れるので、全アドレスで待ち受けるよう上書きする。
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
CMD ["node", "server.js"]
