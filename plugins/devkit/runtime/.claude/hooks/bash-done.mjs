#!/usr/bin/env node
// PostToolUse(Bash) フック: guard-bash が残した「Claude の Bash が実行中」の目印を消す。
// バックグラウンドで起動したコマンドは、まだ動いているので消さない（期限で無効になる）。
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bashMarkerDir, bashMarkerName } from "../../scripts/devkit/shared.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (!process.env.DEVKIT_ROLE && !input.tool_input?.run_in_background) rmSync(join(bashMarkerDir(), bashMarkerName(input.session_id, input.tool_use_id)), { force: true });
} catch {}
process.exit(0);
