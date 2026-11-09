// 人が読むための資料: 人間ゲートの確認資料（HTML）、状況ページ（HTML）、実行のまとめ（朝のまとめ・Markdown）。
// 埋め込む値はすべてエスケープする（仕様書や AI の報告に <script> が含まれていても実行されない）。
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import { git } from "./git.mjs";
import { loadControls, parseSpec, pendingRoles, requiredRoles, specText } from "./model.mjs";
import { computeStatus, MS_JA, OUTER_JA, STATUS_JA } from "./status.mjs";
import { escapeHtml as h, localTime, readJson, readText, writeText } from "./util.mjs";

const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--ok:#1a7f37;--ng:#cf222e;--warn:#9a6700;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--card:#151b23}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--card)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}pre{background:var(--card);padding:10px;overflow:auto;border-radius:6px}
.ok{color:var(--ok)}.ng{color:var(--ng)}.warn{color:var(--warn)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
figure{margin:12px 0}figure img{max-width:100%;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:13px}
`;

function page(title, body, { refresh = 0 } = {}) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""
  }<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${h(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function screenshots(dir, limitBytes = 12 * 1024 * 1024) {
  if (!existsSync(dir)) return [];
  const out = [];
  let total = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
    const p = join(dir, f);
    const st = lstatSync(p);
    if (!st.isFile()) continue;
    const size = st.size;
    if (total + size > limitBytes) break;
    total += size;
    out.push({ name: f.replace(/\.png$/, "").replaceAll("__", " › "), data: readFileSync(p).toString("base64") });
  }
  return out;
}

// ---------- 人間ゲートの確認資料 ----------

export function writeGateReport(ctx, { g, s, mid }) {
  const m = g.milestones.find((x) => x.id === mid);
  const ms = s.milestones[mid];
  const c = loadControls(ctx);
  const required = requiredRoles(c, mid, ms.required ?? []);
  const pend = pendingRoles(c, mid, required, { sha: ms.head });
  const spec = parseSpec(specText(ctx, g) ?? "");
  const nodes = g.nodes.filter((n) => n.milestone === mid);
  const parts = [];
  parts.push(`<h1>${h(mid)}「${h(m.title)}」の確認</h1><p class="muted">${h(g.mission)} ／ 検証した版 <code>${h((ms.head ?? "").slice(0, 10))}</code> ／ ${h(localTime(ms.verifiedAt))}</p>`);
  parts.push(
    `<div class="card"><strong>確認をお願いする人:</strong> ${required.map((r) => `${h(ROLE_PERSON[r])}${pend.includes(r) ? "（未承認）" : "（承認済み）"}`).join("、") || "なし"}<br>` +
      `よければ端末で ${pend.map((r) => `<code>pnpm devkit approve ${h(mid)} --role ${h(r)}</code>`).join(" ／ ")}、直してほしい点があれば <code>pnpm devkit reject ${h(mid)} --role &lt;業務|技術&gt; --note "直してほしい点"</code></div>`,
  );
  parts.push("<h2>できたこと</h2><table><tr><th>作業</th><th>内容</th><th>独立レビュー</th></tr>");
  for (const n of nodes) {
    const ns = s.nodes[n.id] ?? {};
    const ev = ns.evidence?.file ? readJson(join(ctx.root, ns.evidence.file), null) : null;
    parts.push(`<tr><td>${h(n.id)} ${h(n.title)}</td><td>${h(ns.summary ?? ev?.implementer?.summary ?? "")}</td><td>${h(ev?.review?.summary ?? "")}${ns.minors?.length ? `<br><span class="muted">軽微な指摘 ${ns.minors.length} 件</span>` : ""}</td></tr>`);
  }
  parts.push("</table>");
  parts.push("<h2>受入基準</h2><table><tr><th>番号</th><th>内容（仕様書）</th><th>作業</th></tr>");
  for (const n of nodes) for (const a of n.acceptance) parts.push(`<tr><td>${h(a)}</td><td>${h(spec.get(a) ?? "")}</td><td>${h(n.id)}</td></tr>`);
  parts.push("</table><p class='muted'>すべて、番号をテスト名に含むテストが実行されて合格しています（ランナーが実行結果で照合）。</p>");
  const flags = ms.flags ?? [];
  parts.push("<h2>判断してほしいこと（変更内容から自動で見つけたもの）</h2>");
  if (!flags.length) parts.push("<p>なし（計画で決めた確認だけです）</p>");
  for (const f of flags) parts.push(`<div class="card"><strong>${h(f.rule)}（${h(ROLE_LABEL[f.role] ?? "")}）</strong> ${h(f.message)}${f.items?.length ? `<ul>${f.items.map((i) => `<li><code>${h(i)}</code></li>`).join("")}</ul>` : ""}</div>`);
  if (flags.some((f) => f.rule === "ESC-03") && ms.base && ms.head) {
    const d = git(ctx.root, ["diff", "--text", `${ms.base}...${ms.head}`, "--", "src/server/auth/permissions.ts"]).out;
    if (d) parts.push(`<h3>権限表の変更</h3><pre>${h(d)}</pre>`);
  }
  if (m.release) {
    const rel = ms.release;
    parts.push(`<h2>リリース前検査</h2><p class="${rel?.ok ? "ok" : "ng"}">${rel?.ok ? "合格" : "未達（技術の承認には合格が必要）"}</p>`);
    for (const v of rel?.violations ?? []) parts.push(`<div class="card ng">${h(v.rule)} ${h(v.file ?? "")} ${h(v.message)}</div>`);
    const fr = ms.finalReview;
    if (fr) {
      parts.push(`<h2>最終レビュー（AI）</h2><p>${h(fr.summary ?? "")}</p>`);
      if (fr.unresolved)
        parts.push(`<div class="card ng">最終レビューの指摘が残っています（自動の修正は上限の ${h(g.limits.maxFinalFixRounds)} 回に達しました）。標準オーナーが指摘を確かめ、承認するか差し戻してください。</div>`);
      for (const f of fr.findings ?? []) parts.push(`<div class="card ${f.severity === "minor" ? "" : "warn"}">[${h(f.severity)}] ${h(f.file ?? "")}${f.line ? `:${h(f.line)}` : ""} ${h(f.problem)}${f.fix ? ` → ${h(f.fix)}` : ""}</div>`);
    }
  }
  const shots = screenshots(join(ctx.cache, "screens", mid));
  parts.push(`<h2>画面</h2>${shots.length ? "" : "<p class='muted'>画面写真はありません（E2E で保存されたものを載せます）</p>"}`);
  for (const sh of shots) parts.push(`<figure><img alt="${h(sh.name)}" src="data:image/png;base64,${sh.data}"><figcaption>${h(sh.name)}</figcaption></figure>`);
  const file = join(ctx.gates, `${mid}.html`);
  writeText(file, page(`${mid} の確認`, parts.join("\n")));
  return relative(ctx.root, file).replaceAll("\\", "/");
}

// ---------- 状況ページ ----------

export function writeStatusHtml(ctx) {
  const st = computeStatus(ctx);
  if (!st.hasPlan) return null;
  const run = st.runner.run ?? {};
  const parts = [];
  parts.push(`<h1>${h(st.mission)}</h1><p class="muted">更新 ${h(localTime(new Date().toISOString()))} ／ 30秒ごとに自動で読み込み直します</p>`);
  parts.push(
    `<div class="card"><strong>状態:</strong> ${h(OUTER_JA[st.outer] ?? st.outer)}${st.reason ? `（${h(st.reason)}）` : ""}<br><strong>ランナー:</strong> ${
      st.runner.alive ? `実行中（${h(run.phase ?? "")}、最終応答 ${h(localTime(run.heartbeatAt))}）` : st.runner.lock ? `<span class="ng">応答なし（最終応答 ${h(localTime(run.heartbeatAt))}）</span>` : "停止中"
    }<br><strong>誰の番か:</strong> ${h(st.whoseTurn)}<br><strong>費用:</strong> $${h((st.usage?.costUsd ?? 0).toFixed(2))}</div>`,
  );
  if (st.waitingFor.length) {
    parts.push("<h2>人の判断待ち</h2><table><tr><th>誰</th><th>何を</th><th>端末で</th></tr>");
    for (const w of st.waitingFor) parts.push(`<tr><td>${h(ROLE_PERSON[w.role])}</td><td>${h(w.what)}</td><td><code>${h(w.command)}</code></td></tr>`);
    parts.push("</table>");
  }
  parts.push("<h2>マイルストーン</h2><table><tr><th>ID</th><th>名前</th><th>状態</th></tr>");
  for (const m of st.milestones) parts.push(`<tr><td>${h(m.id)}</td><td>${h(m.title)}${m.release ? "（リリース）" : ""}</td><td>${h(MS_JA[m.status] ?? m.status)}</td></tr>`);
  parts.push("</table><h2>作業</h2><table><tr><th>ID</th><th>名前</th><th>マイルストーン</th><th>状態</th><th>試行</th><th>メモ</th></tr>");
  for (const n of st.nodes) parts.push(`<tr><td>${h(n.id)}</td><td>${h(n.title)}</td><td>${h(n.milestone)}</td><td>${h(STATUS_JA[n.status] ?? n.status)}</td><td>${h(n.attempts)}</td><td>${h(n.note ?? "")}</td></tr>`);
  parts.push("</table>");
  const recent = readText(ctx.progress).split("\n").filter((l) => l.startsWith("- ")).slice(-15).reverse();
  parts.push(`<h2>直近の出来事</h2><pre>${h(recent.join("\n"))}</pre>`);
  writeText(ctx.statusHtml, page("devkit の状況", parts.join("\n"), { refresh: 30 }));
  return ctx.statusHtml;
}

// ---------- 実行のまとめ（朝のまとめ） ----------

export function writeRunReport(ctx, { startedAt, stamp, stop, events, usage }) {
  const st = computeStatus(ctx);
  const lines = [];
  lines.push(`# 実行のまとめ（${localTime(startedAt)} 〜 ${localTime(new Date().toISOString())}）`, "");
  lines.push(`- 止まった理由: ${stop?.reason ?? "-"}`);
  if (st.hasPlan) {
    lines.push(`- ミッション: ${st.mission}（${OUTER_JA[st.outer] ?? st.outer}）`);
    lines.push(`- 作業: 完了 ${st.counts.done} / 全 ${st.nodes.length}`);
  }
  lines.push(`- 費用（この実行）: $${(usage?.costUsd ?? 0).toFixed(2)}、ターン ${usage?.turns ?? 0}`, "");
  const done = events.filter((e) => /統合して完了|全体検証に合格/.test(e.text));
  lines.push("## できたこと", ...(done.length ? done.map((e) => `- ${e.text}`) : ["- なし"]), "");
  if (st.hasPlan) {
    lines.push("## 人の判断待ち");
    if (!st.waitingFor.length) lines.push("- なし");
    for (const w of st.waitingFor) lines.push(`- ${ROLE_PERSON[w.role]}: ${w.what} → 端末で \`${w.command}\``);
    lines.push("");
    const stuck = st.nodes.filter((n) => ["failed", "blocked"].includes(n.status));
    lines.push("## 止まっている作業", ...(stuck.length ? stuck.map((n) => `- ${n.id}「${n.title}」: ${STATUS_JA[n.status]} ${n.note ?? ""}`) : ["- なし"]), "");
  }
  const decisions = events.filter((e) => /再計画を適用|判断:/.test(e.text));
  const progressDecisions = readText(ctx.progress)
    .split("\n")
    .filter((l) => l.includes("判断:"))
    .filter((l) => {
      const m = l.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      return m ? new Date(m[1].replace(" ", "T")).getTime() >= new Date(startedAt).getTime() - 60_000 : false;
    });
  lines.push("## AI が自分で決めたこと（違っていれば直してください）", ...([...new Set([...decisions.map((e) => `- ${e.text}`), ...progressDecisions])].slice(0, 30)), ...(decisions.length || progressDecisions.length ? [] : ["- なし"]), "");
  lines.push("## 出来事", ...events.map((e) => `- ${localTime(e.at)} ${e.text}`), "");
  const file = join(ctx.reports, `run-${stamp}.md`);
  writeText(file, `${lines.join("\n")}\n`);
  return relative(ctx.root, file).replaceAll("\\", "/");
}

// ---------- ログの要約（devkit logs） ----------

export function summarizeLogs(ctx, { dir = null, limit = 40 } = {}) {
  const base = dir ?? latestLogDir(ctx);
  if (!base) return "ログがまだありません";
  const out = [`ログ: ${relative(ctx.root, base)}`];
  for (const f of readdirSync(base).sort()) {
    const p = join(base, f);
    if (f.endsWith(".jsonl")) {
      const evs = readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const tools = [];
      let result = null;
      for (const e of evs) {
        if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") tools.push(`${c.name}${c.input?.command ? `(${String(c.input.command).slice(0, 60)})` : c.input?.file_path ? `(${c.input.file_path})` : ""}`);
        if (e.type === "result") result = e;
      }
      out.push(`- ${f}: ${result ? `${result.subtype ?? ""} ${result.num_turns ?? 0}ターン $${(result.total_cost_usd ?? 0).toFixed(2)}` : "結果なし"}${tools.length ? ` ／ ${tools.slice(-limit / 4).join(", ")}` : ""}`);
    } else if (f.endsWith("-verify.log")) {
      const t = readFileSync(p, "utf8").trim().split("\n").slice(-3).join(" ⏎ ");
      out.push(`- ${f}: ${t.slice(0, 200)}`);
    }
  }
  return out.join("\n");
}

function latestLogDir(ctx) {
  if (!existsSync(ctx.logs)) return null;
  const dirs = readdirSync(ctx.logs).filter((d) => d.startsWith("run-")).sort();
  return dirs.length ? join(ctx.logs, dirs.at(-1)) : null;
}
