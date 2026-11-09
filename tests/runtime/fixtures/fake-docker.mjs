#!/usr/bin/env node
// テスト用の偽のコンテナエンジン（docker の代わり）。ランナーが組み立てた `docker run` の引数を記録し、
// マウント（-v ホスト:コンテナ）に従ってパスを読み替えて、同じコマンドをホストで実行する。
// 記録: $FAKE_DOCKER_LOG（なければ何も書かない）。FAKE_DOCKER_DOWN=1 でデーモンが動いていない状態にする。
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [sub, ...rest] = process.argv.slice(2);
const log = (obj) => process.env.FAKE_DOCKER_LOG && appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(obj)}\n`);
if (process.env.FAKE_DOCKER_DOWN === "1") {
  process.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
  process.exit(1);
}
if (sub === "version") {
  console.log("99.0.0-fake");
  process.exit(0);
}
if (sub === "info") {
  console.log("[]");
  process.exit(0);
}
if (["image", "pull", "rm", "kill"].includes(sub)) {
  log({ sub, args: rest });
  process.exit(0);
}
if (sub === "ps") process.exit(0);
if (sub !== "run") {
  process.stderr.write(`fake-docker: ${sub} は知らない\n`);
  process.exit(125);
}
const VALUE = new Set(["--name", "--label", "--user", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--shm-size", "--tmpfs", "--network", "-v", "-e", "-w", "--userns"]);
const opts = { v: [], e: [], network: null, user: null, name: null, workdir: "/" };
let i = 0;
while (i < rest.length && rest[i].startsWith("-")) {
  const a = rest[i];
  if (a.startsWith("--userns=")) {
    i++;
    continue;
  }
  if (VALUE.has(a)) {
    const v = rest[i + 1];
    if (a === "-v") opts.v.push(v);
    else if (a === "-e") opts.e.push(v);
    else if (a === "--network") opts.network = v;
    else if (a === "--user") opts.user = v;
    else if (a === "--name") opts.name = v;
    else if (a === "-w") opts.workdir = v;
    i += 2;
  } else i += 1;
}
const image = rest[i];
const cmd = rest.slice(i + 1);
const mounts = opts.v
  .map((m) => {
    const parts = m.split(":");
    const ro = parts.at(-1) === "ro";
    const ctr = ro ? parts.at(-2) : parts.at(-1);
    const host = parts.slice(0, ro ? -2 : -1).join(":");
    return { host, ctr, ro };
  })
  .sort((a, b) => b.ctr.length - a.ctr.length);
const tmp = join(process.env.FAKE_DOCKER_TMP ?? "/tmp", `fake-docker-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const map = (s) => {
  let out = String(s);
  for (const m of mounts) out = out.split(m.ctr).join(m.host);
  return out.replaceAll("/tmp/home", join(tmp, "home"));
};
const env = { PATH: process.env.PATH, FAKE_INNER_ROOT: opts.workdir, FAKE_NETWORK: opts.network ?? "" };
for (const kv of opts.e) {
  const k = kv.slice(0, kv.indexOf("="));
  const v = kv.slice(kv.indexOf("=") + 1);
  env[k] = k === "E2E_SCREENSHOT_DIR" || k === "HOME" || k === "TMPDIR" ? map(v) : v;
}
const phase = env.DEVKIT_PHASE;
log({ sub: "run", phase, image, network: opts.network, user: opts.user, name: opts.name, mounts, args: rest.slice(0, i), env: Object.keys(env) });
const cwd = map(opts.workdir);
const [prog, ...pargs] = cmd;
const r = spawnSync(prog, pargs.map((a, k) => (k === pargs.length - 1 ? map(a) : a)), { cwd, env, stdio: "inherit" });
process.exit(r.status ?? 1);
