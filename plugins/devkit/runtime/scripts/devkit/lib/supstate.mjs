// Supervisor の管理情報の置き場所（.devkit/cache/supervisor/。手元の機械だけのもので、コミットしない）。
// 計画・承認・検証の正本は state.json・controls.json に置き、ここには承認の台帳を作らない。
import { join } from "node:path";
import { readJson, writeJson } from "./util.mjs";

export function supervisorPaths(ctx) {
  const dir = join(ctx.dir, "cache", "supervisor");
  return { dir, state: join(dir, "state.json"), lock: join(dir, "lock"), outbox: join(dir, "outbox") };
}

export const SUPERVISOR_STOPS = ["limit_stop", "manual_stop", "policy_stop", "env_stop"];

export function readSupervisorState(ctx) {
  const st = readJson(supervisorPaths(ctx).state, null) ?? {};
  return {
    version: 1,
    status: "stopped",
    reason: "",
    since: null,
    pid: null,
    host: null,
    heartbeatAt: null,
    child: null,
    failures: {},
    current: null,
    day: { key: null, runs: 0, costStart: null },
    noProgress: 0,
    briefing: { lastDeadline: null, file: null },
    ...st,
  };
}

export function writeSupervisorState(ctx, st) {
  writeJson(supervisorPaths(ctx).state, st);
}
