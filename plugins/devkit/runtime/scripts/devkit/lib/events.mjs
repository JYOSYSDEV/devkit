// 運用の出来事の記録（.devkit/events.jsonl。追記だけ）。ランナーの起動・終了・断った起動、Supervisor の判断・再試行・停止・配信。
// 1行 = { id, at, type, ... }。同じ出来事を2回書いても、読むときに id で1つにする（再起動をまたいでも数え直さない）。
// 夜間の成果（完了したノード・マイルストーン）は、封印された state.json から決めるので、ここには頼らない。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./clock.mjs";
import { sha256 } from "./util.mjs";

export function eventsFile(ctx) {
  return join(ctx.dir, "events.jsonl");
}

export function appendEvent(ctx, type, data = {}, id = null) {
  const at = now().toISOString();
  const ev = { id: id ?? `${type}:${sha256(`${at}:${process.pid}:${Math.random()}`).slice(0, 12)}`, at, type, ...data };
  try {
    mkdirSync(ctx.dir, { recursive: true });
    appendFileSync(eventsFile(ctx), `${JSON.stringify(ev)}\n`);
  } catch {}
  return ev;
}

// since < at <= until の出来事（id で重複を除く）。読めない行の数も返す（集計の欠落として報告する）
export function readEvents(ctx, { since = -Infinity, until = Infinity } = {}) {
  const file = eventsFile(ctx);
  if (!existsSync(file)) return { events: [], broken: 0, missing: true };
  const seen = new Set();
  const events = [];
  let broken = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      broken++;
      continue;
    }
    const t = Date.parse(ev.at);
    if (!ev.id || !Number.isFinite(t)) {
      broken++;
      continue;
    }
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    if (t > since && t <= until) events.push(ev);
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, broken, missing: false };
}
