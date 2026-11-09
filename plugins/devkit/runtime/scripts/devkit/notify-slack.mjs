#!/usr/bin/env node
// Slack の Incoming Webhook に devkit の通知を送る。
//   export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   （業務と技術で分けるなら、コマンドごとに別の URL を渡す）
//   export DEVKIT_NOTIFY_CMD="node scripts/devkit/notify-slack.mjs"
// メッセージは環境変数 DEVKIT_MESSAGE で受け取る（コマンド文字列には埋め込まれない）。
const url = process.env.SLACK_WEBHOOK_URL;
const text = process.env.DEVKIT_MESSAGE ?? "";
if (!url) {
  console.error("SLACK_WEBHOOK_URL が設定されていません");
  process.exit(1);
}
const controller = new AbortController();
setTimeout(() => controller.abort(), 8000).unref();
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal });
process.exit(res.ok ? 0 : 1);
