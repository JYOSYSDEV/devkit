// 作業場所と検証の隔離。
//
// - 作業場所（work）: AI の作業ディレクトリ・レビュー用の取り出し・検証用の取り出しは、すべてリポジトリの外に置く。
//   既定は ~/.cache/devkit/<案件のキー>/work（.devkit/config.json の workDir で変えられる）。
// - 検証（verify）: 対象コミットを git の外の普通のフォルダに取り出し、コンテナの中で
//     1) 依存のインストール（ネットワークあり。キャッシュは書ける）
//     2) 検証コマンド（--network none・root 以外・キャッシュはツールだけ読み取り専用）
//   の順に実行する。コンテナから見えるのは取り出したフォルダとキャッシュだけで、本体のリポジトリ・承認・計画には届かない。
// - 結果（test-reports/・画面写真）は、リンクをたどらず、取り出したフォルダの中の普通のファイルだけを読む。
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./util.mjs";

export const ISOLATION_DEFAULTS = {
  mode: "container", // container | none（none は隔離なし。テストと、隔離できない環境で人が明示したときだけ）
  engine: "docker", // docker | podman（実行ファイルの名前かパス）
  image: null, // 省略時は package.json の @playwright/test の版に合わせた mcr.microsoft.com/playwright:v<版>-noble
  installNetwork: "bridge", // 依存のインストールのネットワーク（プロキシが 127.0.0.1 にある環境では host）
  memory: "6g",
  cpus: null,
  pids: 4096,
  shmSize: "1g",
  tmpfsSize: "2g",
  user: null, // 省略時は自動（root で動かしているときは 1000:1000、podman は keep-id）
  readOnlyRoot: true,
  passProxy: true, // インストールの段階に HTTP(S)_PROXY・NO_PROXY・NODE_EXTRA_CA_CERTS を渡す
  pnpmVersion: null, // 省略時は package.json の packageManager（pnpm@x.y.z）
  installArgs: [],
  verifyArgs: [],
  pullTimeoutMinutes: 20,
};

const MARKER = ".devkit-workbase";

function cacheHome() {
  if (process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)) return process.env.XDG_CACHE_HOME;
  return join(homedir(), ".cache");
}

export function projectKey(ctx) {
  let root = ctx.root;
  try {
    root = realpathSync(ctx.root);
  } catch {}
  return `${basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 32)}-${sha256(root).slice(0, 10)}`;
}

export function isolationConfig(config = {}) {
  return { ...ISOLATION_DEFAULTS, ...(config.isolation ?? {}) };
}

// 作業場所のルート。印のファイルを置き、devkit のコマンドがここの中では「作業用の場所」と分かるようにする
export function workBase(ctx, config = {}) {
  const base = config.workDir ? resolve(ctx.root, config.workDir) : join(cacheHome(), "devkit", projectKey(ctx), "work");
  const rootReal = safeReal(ctx.root);
  const baseReal = safeReal(base);
  if (baseReal === rootReal || baseReal.startsWith(`${rootReal}${sep}`)) throw new Error(`workDir（${base}）はリポジトリの外に置く`);
  mkdirSync(base, { recursive: true });
  if (!existsSync(join(base, MARKER))) writeFileSync(join(base, MARKER), `devkit の作業場所（${ctx.root}）。中のものは消してよい\n`);
  return base;
}

export function cacheBase(ctx, config = {}) {
  const iso = isolationConfig(config);
  const base = iso.cacheDir ? resolve(ctx.root, iso.cacheDir) : join(cacheHome(), "devkit", projectKey(ctx), "cache");
  mkdirSync(join(base, "tools"), { recursive: true });
  mkdirSync(join(base, "pnpm-store"), { recursive: true });
  mkdirSync(join(base, "npm"), { recursive: true });
  return base;
}

// path が devkit の作業場所の中か（印のファイルを上にたどって探す）
export function insideWorkBase(path) {
  let dir = resolve(path);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, MARKER))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

function safeReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// ---------- プロセスの実行（制限時間つき。時間切れでは、プロセスグループごと止め、出力が閉じなくても戻る） ----------

export function runProcess(file, args, { cwd, env, timeoutMs, logFile, shell = false, onTimeout = null }) {
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  const log = logFile ? createWriteStream(logFile, { flags: "w" }) : null;
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      log?.end();
      resolvePromise({ code: 127, timedOut: false, out: e.message });
      return;
    }
    let out = "";
    let timedOut = false;
    let done = false;
    const keep = (c) => {
      const s = c.toString();
      out = (out + s).slice(-400_000);
      log?.write(s);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = (sig) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log?.end();
      resolvePromise({ code: timedOut ? 124 : (code ?? 1), timedOut, out });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      keep(`\n[devkit] 制限時間（${Math.round(timeoutMs / 1000)} 秒）を超えたので止めます\n`);
      try {
        onTimeout?.();
      } catch {}
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000).unref();
      // 孫のプロセスが出力を握ったままでも、ここで戻る
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(124);
      }, 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => keep(`\n${e.message}\n`));
    child.on("close", (code) => finish(code));
  });
}

// ---------- コンテナ ----------

let ENGINE_CACHE = new Map();

export function engineName(iso) {
  return basename(String(iso.engine || "docker")).replace(/\.exe$/i, "");
}

// エンジンが使えるか・rootless か。結果はプロセスの中でだけ覚える
export function engineInfo(iso) {
  const key = iso.engine;
  if (ENGINE_CACHE.has(key)) return ENGINE_CACHE.get(key);
  const v = spawnSync(iso.engine, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 30_000 });
  let info;
  if (v.status !== 0) {
    info = { ok: false, reason: (v.stderr || v.stdout || v.error?.message || "").trim().split("\n")[0] || `${iso.engine} を実行できない` };
  } else {
    const podman = engineName(iso).includes("podman");
    let rootless = false;
    if (podman) {
      const r = spawnSync(iso.engine, ["info", "--format", "{{.Host.Security.Rootless}}"], { encoding: "utf8", timeout: 30_000 });
      rootless = r.stdout?.trim() === "true";
    } else {
      const r = spawnSync(iso.engine, ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8", timeout: 30_000 });
      rootless = /rootless/.test(r.stdout ?? "");
    }
    info = { ok: true, version: v.stdout.trim(), podman, rootless };
  }
  ENGINE_CACHE.set(key, info);
  return info;
}

export function resetEngineCache() {
  ENGINE_CACHE = new Map();
}

// 取り出したフォルダから、使うイメージと pnpm の版を決める（package.json は共有ファイルで、作業では変えられない）
export function imageFor(iso, pkg) {
  if (iso.image) return iso.image;
  const pw = pkg?.devDependencies?.["@playwright/test"] ?? pkg?.dependencies?.["@playwright/test"];
  const m = String(pw ?? "").match(/^\D*(\d+\.\d+\.\d+)$/);
  return m ? `mcr.microsoft.com/playwright:v${m[1]}-noble` : "node:24-bookworm-slim";
}

export function pnpmVersionFor(iso, pkg) {
  if (iso.pnpmVersion) return String(iso.pnpmVersion);
  const m = String(pkg?.packageManager ?? "").match(/^pnpm@(\d+\.\d+\.\d+)(?:[+-].*)?$/);
  return m ? m[1] : "";
}

export function ensureImage(iso, image, { logFile } = {}) {
  const have = spawnSync(iso.engine, ["image", "inspect", image], { encoding: "utf8", timeout: 60_000 });
  if (have.status === 0) return { ok: true };
  return runProcess(iso.engine, ["pull", image], { env: process.env, timeoutMs: iso.pullTimeoutMinutes * 60_000, logFile }).then((r) =>
    r.code === 0 ? { ok: true } : { ok: false, reason: `イメージ ${image} を取得できない: ${r.out.trim().split("\n").slice(-3).join(" ")}` },
  );
}

// コンテナの中の利用者。root で動かしているときは、取り出したフォルダの持ち主を合わせる
export function containerUser(iso, info) {
  if (iso.user) {
    const m = String(iso.user).match(/^(\d+):(\d+)$/);
    return { args: ["--user", String(iso.user)], chown: m && process.getuid?.() === 0 ? { uid: Number(m[1]), gid: Number(m[2]) } : null };
  }
  if (info.podman) return { args: ["--userns=keep-id"], chown: null };
  if (info.rootless) return { args: ["--user", "0:0"], chown: null };
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined) return { args: [], chown: null };
  if (uid === 0) return { args: ["--user", "1000:1000"], chown: { uid: 1000, gid: 1000 } };
  return { args: ["--user", `${uid}:${gid}`], chown: null };
}

export function chownTree(dir, uid, gid) {
  const walk = (p) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    try {
      lchownSync(p, uid, gid);
    } catch {}
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(dir);
}

// コンテナの中で最初に実行する部分: pnpm がなければ、キャッシュの tools に入れる（インストールの段階だけ取得できる）
const PRELUDE = [
  "set -e",
  'mkdir -p "$HOME"',
  'if [ -n "$DEVKIT_PNPM_VERSION" ] && ! command -v pnpm >/dev/null 2>&1; then',
  '  T="/cache/tools/pnpm-$DEVKIT_PNPM_VERSION"',
  '  if [ ! -x "$T/node_modules/.bin/pnpm" ] && [ "$DEVKIT_PHASE" = install ]; then',
  '    W="$T.tmp-$$"; rm -rf "$W"',
  '    npm install --prefix "$W" --no-audit --no-fund --no-save --loglevel=error "pnpm@$DEVKIT_PNPM_VERSION"',
  '    mv "$W" "$T" 2>/dev/null || rm -rf "$W"',
  "  fi",
  '  export PATH="$T/node_modules/.bin:$PATH"',
  "fi",
].join("\n");

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

// docker run の引数を組み立てる（テストで中身を確かめられるように、実行とは分ける）
export function containerRunArgs({ iso, info, phase, name, project, image, dir, cache, screens = null, env = {}, command }) {
  const user = containerUser(iso, info);
  const args = ["run", "--rm", "--name", name, "--label", `devkit.project=${project}`, "--label", `devkit.phase=${phase}`, "--init"];
  args.push(...user.args);
  args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  if (iso.pids) args.push("--pids-limit", String(iso.pids));
  if (iso.memory) args.push("--memory", String(iso.memory));
  if (iso.cpus) args.push("--cpus", String(iso.cpus));
  if (iso.shmSize) args.push("--shm-size", String(iso.shmSize));
  if (iso.readOnlyRoot) args.push("--read-only");
  args.push("--tmpfs", `/tmp:rw,exec,nosuid,size=${iso.tmpfsSize || "2g"}`);
  args.push("--network", phase === "install" ? String(iso.installNetwork || "bridge") : "none");
  args.push("-v", `${dir}:/work`);
  if (phase === "install") args.push("-v", `${cache}:/cache`);
  else args.push("-v", `${join(cache, "tools")}:/cache/tools:ro`);
  if (screens) args.push("-v", `${screens}:/screens`);
  const e = {
    HOME: "/tmp/home",
    CI: "1",
    TMPDIR: "/tmp",
    NEXT_TELEMETRY_DISABLED: "1",
    FORCE_COLOR: "0",
    DEVKIT_VERIFY: "1",
    DEVKIT_RUNNER: "1",
    DEVKIT_ROLE: "verify",
    DEVKIT_PHASE: phase,
    ...env,
  };
  if (phase === "install") {
    Object.assign(e, { npm_config_store_dir: "/cache/pnpm-store", npm_config_cache: "/cache/npm", npm_config_package_import_method: "copy" });
    if (iso.passProxy) {
      for (const k of PROXY_VARS) if (process.env[k]) e[k] = process.env[k];
      const ca = process.env.NODE_EXTRA_CA_CERTS;
      if (ca && existsSync(ca)) {
        args.push("-v", `${ca}:/etc/devkit/extra-ca.crt:ro`);
        e.NODE_EXTRA_CA_CERTS = "/etc/devkit/extra-ca.crt";
      }
    }
    args.push(...(iso.installArgs ?? []));
  } else args.push(...(iso.verifyArgs ?? []));
  for (const [k, v] of Object.entries(e)) args.push("-e", `${k}=${v}`);
  args.push("-w", "/work", image, "sh", "-c", `${PRELUDE}\n${command}`);
  return { args, chown: user.chown };
}

export function killContainer(iso, name) {
  spawnSync(iso.engine, ["kill", name], { encoding: "utf8", timeout: 30_000 });
  spawnSync(iso.engine, ["rm", "-f", name], { encoding: "utf8", timeout: 30_000 });
}

// 落ちたランナーが残したコンテナを片付ける
export function cleanupContainers(iso, project) {
  if (iso.mode !== "container") return 0;
  const r = spawnSync(iso.engine, ["ps", "-aq", "--filter", `label=devkit.project=${project}`], { encoding: "utf8", timeout: 30_000 });
  const ids = (r.stdout ?? "").split(/\s+/).filter(Boolean);
  if (ids.length) spawnSync(iso.engine, ["rm", "-f", ...ids], { encoding: "utf8", timeout: 60_000 });
  return ids.length;
}

let SEQ = 0;

// 取り出したフォルダ（dir）で、コンテナの中でコマンドを実行する。mode: none のときは、そのフォルダでそのまま実行する（隔離なし）
export async function runIsolated(ctx, config, { phase, dir, command, timeoutMs, logFile, env = {}, screens = null, label = "" }) {
  const iso = isolationConfig(config);
  if (iso.mode === "none") {
    const hostEnv = { ...sanitizedHostEnv(), DEVKIT_VERIFY: "1", DEVKIT_RUNNER: "1", DEVKIT_ROLE: "verify", DEVKIT_PHASE: phase, FORCE_COLOR: "0", CI: "1", ...env };
    if (screens) hostEnv.E2E_SCREENSHOT_DIR = screens;
    return runProcess(command, [], { cwd: dir, env: hostEnv, timeoutMs, logFile, shell: true });
  }
  const info = engineInfo(iso);
  if (!info.ok) return { code: 125, timedOut: false, out: `コンテナを使えません: ${info.reason}`, envError: true };
  const pkg = safeReadJson(dir, "package.json", 1_000_000) ?? {};
  const image = imageFor(iso, pkg);
  const cache = cacheBase(ctx, config);
  const project = projectKey(ctx).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const name = `devkit-${project}-${phase}-${process.pid}-${++SEQ}`.slice(0, 120);
  const e = { ...env, DEVKIT_PNPM_VERSION: pnpmVersionFor(iso, pkg) };
  if (screens) e.E2E_SCREENSHOT_DIR = "/screens";
  const { args, chown } = containerRunArgs({ iso, info, phase, name, project, image, dir, cache, screens, env: e, command });
  if (chown) {
    chownTree(dir, chown.uid, chown.gid);
    for (const p of [cache, join(cache, "tools"), join(cache, "pnpm-store"), join(cache, "npm")]) chownTree(p, chown.uid, chown.gid);
    if (screens) chownTree(screens, chown.uid, chown.gid);
  }
  const img = await ensureImage(iso, image, { logFile: logFile ? `${logFile}.pull.log` : null });
  if (!img.ok) return { code: 125, timedOut: false, out: img.reason, envError: true };
  const r = await runProcess(iso.engine, args, { env: process.env, timeoutMs, logFile, onTimeout: () => killContainer(iso, name) });
  if (r.timedOut) killContainer(iso, name);
  // 125〜127 はエンジン自身の失敗（イメージ・権限・デーモン）
  if (r.code === 125 && /Cannot connect|permission denied while trying to connect|daemon/i.test(r.out)) r.envError = true;
  return { ...r, label };
}

export function sanitizedHostEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_config_|NPM_CONFIG_|PNPM_|pnpm_config_)/.test(k)) continue;
    if (["NODE_OPTIONS", "DEVKIT_ROLE", "DEVKIT_RUNNER", "DEVKIT_PHASE", "CLAUDECODE", "VITEST", "VITEST_MODE", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(k)) continue;
    if (/^CLAUDE_CODE_/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// ---------- 取り出したフォルダの中のファイルを安全に読む ----------

// root の中の普通のファイルだけを読む（リンクや、外を指すパスは読まない）
export function safeRead(root, rel, maxBytes = 64 * 1024 * 1024) {
  const p = join(root, rel);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) return null;
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return null;
  }
  const rootReal = safeReal(root);
  if (!real.startsWith(`${rootReal}${sep}`)) return null;
  try {
    return readFileSync(real);
  } catch {
    return null;
  }
}

export function safeReadJson(root, rel, maxBytes) {
  const buf = safeRead(root, rel, maxBytes);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

// 画面写真（.png）だけを、リンクをたどらずに写す
export function copyScreens(from, to, { maxFiles = 400, maxBytes = 20 * 1024 * 1024 } = {}) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  let n = 0;
  const walk = (rel) => {
    let names;
    try {
      const st = lstatSync(join(from, rel));
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      names = readdirSync(join(from, rel));
    } catch {
      return;
    }
    for (const name of names) {
      if (n >= maxFiles) return;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(from, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && /\.png$/i.test(name)) {
        const buf = safeRead(from, r, maxBytes);
        if (!buf) continue;
        const out = join(to, r.replace(/[\\/]/g, "__"));
        writeFileSync(out, buf);
        n++;
      }
    }
  };
  walk("");
  return n;
}

export function relInside(root, p) {
  const r = relative(root, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r.replaceAll("\\", "/") : null;
}
