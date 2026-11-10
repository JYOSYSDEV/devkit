#!/usr/bin/env node
// テスト用の偽の claude。ランナーが渡す引数と環境変数（DEVKIT_ROLE・DEVKIT_NODE）から役割を判断し、
// シナリオ（DEVKIT_FAKE_SCENARIO の JSON）に従ってファイルを書き、stream-json で結果を返す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const role = process.env.DEVKIT_ROLE ?? "unknown";
const node = process.env.DEVKIT_NODE ?? "-";
const scenario = JSON.parse(readFileSync(process.env.DEVKIT_FAKE_SCENARIO, "utf8"));
const counterFile = `${process.env.DEVKIT_FAKE_SCENARIO}.count.json`;
const counts = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, "utf8")) : {};
const key = `${role}:${node}`;
counts[key] = (counts[key] ?? 0) + 1;
writeFileSync(counterFile, JSON.stringify(counts));
const callLog = `${process.env.DEVKIT_FAKE_SCENARIO}.calls.log`;
writeFileSync(callLog, `${key}#${counts[key]} cwd=${process.cwd()} args=${process.argv.slice(2).filter((a) => a.startsWith("--")).join(" ")}\n`, { flag: "a" });
writeFileSync(`${process.env.DEVKIT_FAKE_SCENARIO}.args.jsonl`, `${JSON.stringify({ key, n: counts[key], cwd: process.cwd(), workdir: process.env.DEVKIT_WORKDIR ?? null, owns: process.env.DEVKIT_OWNS ?? null, allowRemoval: process.env.DEVKIT_ALLOW_TEST_REMOVAL ?? null, apiKey: Boolean(process.env.ANTHROPIC_API_KEY), argv: process.argv.slice(2) })}\n`, { flag: "a" });

const steps = scenario[key] ?? scenario[role] ?? [];
const step = steps[Math.min(counts[key] - 1, steps.length - 1)] ?? {};

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (step.envError) {
  process.stderr.write(`${step.envError}\n`);
  process.exit(1);
}
// 作業ディレクトリの外（本体のリポジトリなど）への書き込み。隔離がなかった場合の改ざんを再現する
for (const [file, content] of Object.entries(step.writeAbs ?? {})) writeFileSync(file, content);
if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
// 人や対話の Claude が、ランナーの実行中に devkit のコマンドを打ったことを再現する（DEVKIT_* を外して実行）
if (step.spawn) {
  const { spawnSync } = await import("node:child_process");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEVKIT_")));
  const r = spawnSync(step.spawn[0], step.spawn.slice(1), { cwd: step.spawnCwd, env: { ...env, ...(step.spawnEnv ?? {}) }, encoding: "utf8" });
  writeFileSync(`${process.env.DEVKIT_FAKE_SCENARIO}.spawn.log`, `${r.status} ${r.stdout}${r.stderr}\n`, { flag: "a" });
}
for (const [file, content] of Object.entries(step.files ?? {})) {
  const p = join(process.cwd(), file);
  mkdirSync(dirname(p), { recursive: true });
  if (content === null) {
    try {
      (await import("node:fs")).rmSync(p);
    } catch {}
  } else writeFileSync(p, content);
}
emit({ type: "system", subtype: "init", cwd: process.cwd() });
emit({ type: "assistant", message: { content: [{ type: "text", text: step.text ?? `${key} を実行` }] } });
if (step.stderr) process.stderr.write(`${step.stderr}\n`);
let output = step.output;
if (!output) {
  if (role === "implementer") output = { status: "implemented", summary: `${node} を実装した`, evidence: "pnpm verify exit 0" };
  else if (role === "reviewer" || role === "final-reviewer") output = { verdict: "pass", summary: "問題なし", findings: [] };
  else if (role === "replanner") output = { kind: "needs_human", summary: "案なし" };
}
emit({ type: "result", subtype: step.isError ? "error_during_execution" : "success", is_error: Boolean(step.isError), num_turns: step.turns ?? 3, total_cost_usd: 0.01, result: step.text ?? "done", structured_output: output });
