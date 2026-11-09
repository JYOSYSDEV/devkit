// 定時ブリーフィング: 前回の締切から今回の締切までの「夜間の成果」「今朝判断してほしいこと」「判断後に進む作業」「運用状態」を1通にまとめる。
//   - 成果は封印された state.json から決める（完了は1つのノード・マイルストーンに1つの記録なので、再起動をまたいでも重複しない）
//   - 運用の出来事（実行・停止・再試行）は events.jsonl から id で重複を除いて集める
//   - 判断を受けて進む作業は、ランナーと同じ判断（decide）を、判断を入れた写しの状態で求める
//   - 文章は構造化データから決まった形で作る（AI は使わない。AI が使えなくても作れる）。秘密値・生ログは載せない
//   - 送信は送信待ち（outbox）に入れ、配信キー（案件・締切・送り先）で重複を抑え、失敗したら間隔をあけて送り直す
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { ROLE_LABEL, ROLE_PERSON } from "../shared.mjs";
import {
	deadlineAtOrBefore,
	formatZoned,
	now,
	previousDeadline,
	zonedParts,
} from "./clock.mjs";
import { appendEvent, readEvents } from "./events.mjs";
import {
	applyHumanDecisions,
	decide,
	gateKey,
	loadConfig,
	loadControls,
	loadGraph,
	loadState,
	parseSpec,
	planApproved,
	planHash,
	requestId,
	specText,
} from "./model.mjs";
import { briefingTarget, notify } from "./notify.mjs";
import { runnerAlive } from "./status.mjs";
import { readSupervisorState, supervisorPaths } from "./supstate.mjs";
import { readJson, sha256, writeJson, writeText } from "./util.mjs";

const SECRET =
	/(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

function clean(text, max = 400) {
	const t = String(text ?? "")
		.replace(SECRET, "［伏せ字］")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

function short(sha) {
	return String(sha ?? "").slice(0, 10);
}

export function projectName(ctx) {
	return readJson(ctx.profile, null)?.project || basename(ctx.root);
}

// 締切（at 以前で最も新しいもの）と、その対象期間
export function briefingWindow(config, at = now()) {
	const b = config.briefing;
	const until = deadlineAtOrBefore(at, b.time, b.timeZone);
	const since = previousDeadline(until, b.time, b.timeZone);
	return { since, until, timeZone: b.timeZone, time: b.time };
}

// 判断を入れた写しの状態で、ランナーが次に何をするか
export function simulate(g, s, c, apply = () => {}) {
	const s2 = structuredClone(s);
	const c2 = structuredClone(c);
	apply(s2, c2);
	applyHumanDecisions(g, s2, c2);
	return decide(g, s2, c2);
}

export function workOf(d) {
	return {
		ready: d.ready.map((n) => n.id),
		merge: d.readyToMerge.map((n) => n.id),
		verify: d.verifyMilestone,
		replan: d.replan.map((x) => x.id),
		allDone: d.allDone,
	};
}

export function hasWork(w) {
	return Boolean(
		w.ready.length ||
			w.merge.length ||
			w.verify ||
			w.replan.length ||
			w.allDone,
	);
}

// ノードの後ろに続くもの（依存をたどる。完了したものは除く）
function downstream(g, s, ids) {
	const out = [];
	const seen = new Set(ids);
	let frontier = [...ids];
	while (frontier.length) {
		const next = [];
		for (const n of g.nodes) {
			if (seen.has(n.id) || s.nodes[n.id]?.status === "done") continue;
			if (n.deps.some((d) => frontier.includes(d))) {
				seen.add(n.id);
				out.push(n.id);
				next.push(n.id);
			}
		}
		frontier = next;
	}
	return out;
}

function impactOf(g, s, before, after) {
	const unlocked = after.ready.filter((id) => !before.ready.includes(id));
	const steps = [];
	if (unlocked.length) steps.push(unlocked.join("・"));
	if (after.merge.length && !before.merge.length)
		steps.push(`${after.merge.join("・")} の統合`);
	if (after.verify && after.verify !== before.verify)
		steps.push(`${after.verify} の全体検証`);
	if (after.allDone && !before.allDone) steps.push("ミッションの完了");
	const later = downstream(g, s, unlocked);
	return { unlocked, steps, later, any: steps.length > 0 };
}

function evidenceLine(ctx, ns) {
	const ev = ns.evidence?.file
		? readJson(join(ctx.root, ns.evidence.file), null)
		: null;
	if (!ev)
		return { text: "証跡のファイルを読めなかった", ok: null, deferred: [] };
	const checks = Object.entries(ev.integrity?.checks ?? {});
	const ng = checks.filter(([, c]) => !c.ok).map(([k]) => k);
	const tests = ev.integrity?.tests
		? `テスト 合格 ${ev.integrity.tests.passed}/${ev.integrity.tests.total}`
		: "";
	return {
		text: `機械検証 ${checks.length ? (ng.length ? `不合格あり（${ng.join("・")}）` : `${checks.length} 項目すべて合格`) : "記録なし"}${tests ? `・${tests}` : ""}・独立レビュー ${ev.review?.verdict === "pass" ? "合格" : (ev.review?.verdict ?? "記録なし")}`,
		ok: !ng.length,
		deferred: ev.integrity?.deferredAcs ?? [],
	};
}

export function buildBriefing(
	ctx,
	{ at = now(), window = null, partial = false } = {},
) {
	const config = loadConfig(ctx);
	const tz = config.briefing.timeZone;
	const w =
		window ??
		(partial
			? {
					since: briefingWindow(config, at).until,
					until: at,
					timeZone: tz,
					time: config.briefing.time,
				}
			: briefingWindow(config, at));
	const since = w.since.getTime();
	const until = w.until.getTime();
	const inWin = (iso) => {
		const t = Date.parse(iso ?? "");
		return Number.isFinite(t) && t > since && t <= until;
	};
	const out = {
		project: projectName(ctx),
		mission: "",
		window: {
			since: w.since.toISOString(),
			until: w.until.toISOString(),
			timeZone: tz,
			partial,
		},
		generatedAt: at.toISOString(),
		delayMinutes: partial
			? 0
			: Math.max(0, Math.round((at.getTime() - until) / 60_000)),
		achievements: [],
		acceptance: {
			total: 0,
			achieved: [],
			achievedInWindow: [],
			deferred: [],
			pending: [],
		},
		concerns: [],
		decisions: [],
		independent: [],
		operations: {},
		missing: [],
	};
	const g = loadGraph(ctx, { required: false });
	if (!g) {
		out.operations = { outer: "idle", summary: "計画はまだありません" };
		return finish(ctx, out, config);
	}
	out.mission = g.mission;
	let s;
	let c;
	try {
		s = loadState(ctx, g);
		c = loadControls(ctx);
	} catch (e) {
		out.missing.push(`状態を読めなかった: ${clean(e.message, 200)}`);
		return finish(ctx, out, config);
	}

	// ---- 夜間の成果（state.json から） ----
	for (const n of g.nodes) {
		const ns = s.nodes[n.id];
		if (ns?.status !== "done" || !inWin(ns.mergedAt)) continue;
		const ev = evidenceLine(ctx, ns);
		out.achievements.push({
			id: `node:${n.id}:${short(ns.merge)}`,
			kind: "node",
			target: n.id,
			title: n.title,
			milestone: n.milestone,
			at: ns.mergedAt,
			summary: clean(ns.summary, 300),
			acceptance: n.acceptance,
			commit: short(ns.merge),
			verification: ev.text,
			evidence: ns.evidence?.file ?? null,
			deferredAcs: ev.deferred,
		});
		for (const m of ns.minors ?? [])
			out.concerns.push(
				`${n.id}: レビューの軽微な指摘（積み残し）: ${clean(m, 200)}`,
			);
		for (const f of ns.flags ?? [])
			out.concerns.push(
				`${n.id}: 人の確認が要る変更 ${f.rule}${f.message ? `（${clean(f.message, 120)}）` : ""}`,
			);
	}
	for (const m of g.milestones) {
		const ms = s.milestones[m.id];
		if (!ms) continue;
		if (inWin(ms.verifiedAt))
			out.achievements.push({
				id: `milestone:${m.id}:${short(ms.head)}:verified`,
				kind: "milestone",
				target: m.id,
				title: m.title,
				at: ms.verifiedAt,
				event:
					ms.status === "awaiting_approval"
						? "全体検証に合格（承認待ち）"
						: ms.status === "done"
							? "全体検証に合格"
							: `全体検証に合格（今は${ms.status}）`,
				commit: short(ms.head),
			});
		if (inWin(ms.approvedAt))
			out.achievements.push({
				id: `milestone:${m.id}:${short(ms.head)}:done`,
				kind: "milestone",
				target: m.id,
				title: m.title,
				at: ms.approvedAt,
				event: "必要な承認がそろって完了",
				commit: short(ms.head),
			});
		if (ms.finalReview?.unresolved)
			out.concerns.push(
				`${m.id}: 最終レビューの指摘が残ったまま（標準オーナーの判断に回した）`,
			);
	}
	if (inWin(s.finishedAt))
		out.achievements.push({
			id: `mission:${s.finishedAt}`,
			kind: "mission",
			target: g.mission,
			at: s.finishedAt,
			event: "全マイルストーンが完了（リリース判断・デプロイは人）",
		});
	out.achievements.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	// 受入基準
	const defined = [...parseSpec(specText(ctx, g) ?? "").keys()].filter((k) =>
		k.startsWith("AC-"),
	);
	out.acceptance.total = defined.length;
	for (const n of g.nodes) {
		const ns = s.nodes[n.id];
		const acs = n.acceptance.filter((a) => a.startsWith("AC-"));
		if (ns?.status !== "done") {
			out.acceptance.pending.push(...acs);
			continue;
		}
		const msDone =
			s.milestones[n.milestone]?.status === "done" ||
			s.milestones[n.milestone]?.status === "awaiting_approval";
		const deferred = msDone ? [] : (evidenceLine(ctx, ns).deferred ?? []);
		for (const a of acs) {
			if (deferred.includes(a)) out.acceptance.deferred.push(a);
			else {
				out.acceptance.achieved.push(a);
				if (inWin(ns.mergedAt)) out.acceptance.achievedInWindow.push(a);
			}
		}
	}

	// ---- 今朝の判断事項と、判断後に進む作業 ----
	const base = simulate(g, s, c);
	const before = workOf(base);
	const plan = planApproved(ctx, c);
	const anyIndependent = hasWork(before) && s.outer === "running";
	const priority = (impact) =>
		impact.any
			? anyIndependent
				? "中"
				: "高（判断がないと全体が止まったまま）"
			: "低";
	if (!plan.ok) {
		for (const r of plan.pending)
			out.decisions.push({
				id: `plan@${short(plan.hash)}`,
				kind: "plan",
				role: r,
				question: `計画（仕様書・マイルストーン・作業の依存グラフ）を${plan.changedAfterApproval ? "、承認の後の変更を含めて" : ""}承認するか`,
				priority: "高（承認がそろうまで作業を始めない）",
				recommendation:
					"仕様書と計画（pnpm devkit check）を確かめ、問題がなければ承認",
				alternatives: ["直してほしい点を伝えて、計画を作り直してもらう"],
				impact: {
					steps: ["ランナーが作業を始める（再開する）"],
					later: [],
					unlocked: [],
				},
				version: `計画のハッシュ ${short(plan.hash)}`,
				where: `${g.spec}・.devkit/graph.json`,
				command: `pnpm devkit approve plan --role ${ROLE_LABEL[r]}`,
			});
	}
	for (const a of base.waiting.approvals) {
		const allRoles = (s2, c2) => {
			const key = a.kind === "before" ? gateKey("before", a.target) : a.target;
			c2.approvals[key] ??= {};
			for (const r of a.roles)
				c2.approvals[key][r] = {
					sha: a.sha,
					by: "（仮）",
					at: at.toISOString(),
				};
		};
		const impact = impactOf(g, s, before, workOf(simulate(g, s, c, allRoles)));
		if (a.kind === "milestone") {
			const m = g.milestones.find((x) => x.id === a.target);
			const ms = s.milestones[a.target];
			const flags = (ms.flags ?? []).map((f) => f.rule);
			for (const r of a.roles)
				out.decisions.push({
					id: `${a.target}@${short(a.sha)}`,
					kind: "milestone",
					role: r,
					question: `${a.target}「${m?.title ?? ""}」を承認するか${flags.length ? `（人の確認が要る変更: ${[...new Set(flags)].join("・")}）` : ""}`,
					priority: priority(impact),
					recommendation: ms.finalReview?.unresolved
						? "最終レビューの残った指摘を確かめ、受け入れられるなら承認、でなければ差し戻し"
						: "確認資料で受入基準と変更内容を確かめ、問題がなければ承認",
					alternatives: [
						"差し戻し（直してほしい点を --note に書く。再計画に回る）",
					],
					impact: {
						...impact,
						needsAll:
							a.roles.length > 1 ? a.roles.map((x) => ROLE_PERSON[x]) : null,
					},
					version: `検証したコミット ${short(a.sha)}`,
					where: `.devkit/gates/${a.target}.html（なければ pnpm devkit gate ${a.target}）`,
					command: `pnpm devkit approve ${a.target} --role ${ROLE_LABEL[r]}`,
				});
		} else {
			const n = g.nodes.find((x) => x.id === a.target);
			for (const r of a.roles)
				out.decisions.push({
					id: `${a.target}:before@${String(a.sha).slice(0, 8)}`,
					kind: "before",
					role: r,
					question: `${a.target}「${n?.title ?? ""}」に着手してよいか`,
					priority: priority(impact),
					recommendation:
						"作業の内容（goal・変更してよい範囲）を確かめ、問題がなければ承認",
					alternatives: ["着手しない（計画を直してもらう）"],
					impact,
					version: `ノードの定義 ${String(a.sha).slice(0, 8)}`,
					where: ".devkit/graph.json",
					command: `pnpm devkit approve ${a.target} --before --role ${ROLE_LABEL[r]}`,
				});
		}
	}
	for (const a of base.waiting.answers) {
		const ns = s.nodes[a.node];
		const req = ns?.request ?? {};
		const rid = requestId(a.node, req);
		const impact = impactOf(
			g,
			s,
			before,
			workOf(
				simulate(g, s, c, (s2, c2) => {
					c2.answers[a.node] = [
						...(c2.answers[a.node] ?? []),
						{
							request: rid,
							role: a.role,
							note: "（仮）",
							at: at.toISOString(),
							applied: false,
						},
					];
				}),
			),
		);
		out.decisions.push({
			id: rid,
			kind: "request",
			role: a.role,
			question: `${clean(req.what, 300)}（${req.condition ?? ""}、${a.node}）`,
			why: clean(req.why, 300),
			priority: priority(impact),
			recommendation: clean(req.recommendation, 300),
			alternatives: (req.options ?? []).map((o) => clean(o, 160)),
			impact,
			version: `計画 ${short(req.plan) || "（記録なし）"}・作業の起点 ${short(req.base) || "（記録なし）"}`,
			where: `.devkit/requests/${a.node}.md`,
			command: `pnpm devkit answer ${a.node} --role ${ROLE_LABEL[a.role]} --request ${rid} --note "<回答>"`,
		});
	}
	for (const p of base.waiting.proposals) {
		const doc = readJson(join(ctx.proposals, `${p.id}.json`), null);
		const graph = doc?.proposal?.graph ?? null;
		for (const r of p.roles ?? ["technical"])
			out.decisions.push({
				id: p.id,
				kind: "proposal",
				role: r,
				question: `再計画の案 ${p.id} を承認するか（人の確認が要る理由: ${(
					p.reasons ?? []
				)
					.slice(0, 3)
					.map((x) => clean(x, 120))
					.join(" / ")}）`,
				priority: anyIndependent
					? "中"
					: "高（判断がないと全体が止まったまま）",
				recommendation: clean(
					doc?.proposal?.summary ?? "案の内容を確かめて判断",
					300,
				),
				alternatives: ["却下する（計画を人が直して pnpm devkit approve plan）"],
				impact: {
					steps: [
						`${p.milestone} の止まっていた作業（${(p.items ?? []).map((x) => x.id).join("・") || "—"}）をやり直す`,
					],
					later: [],
					unlocked: [],
				},
				version: graph
					? `案の計画のハッシュ ${short(planHash(ctx, graph))}`
					: "適用できる計画なし",
				where: `.devkit/proposals/${p.id}.json`,
				command: `pnpm devkit proposal accept ${p.id} --role ${ROLE_LABEL[r]}`,
			});
	}
	if (s.outer === "running") {
		for (const id of before.ready)
			out.independent.push(
				`${id}「${g.nodes.find((n) => n.id === id)?.title ?? ""}」`,
			);
		for (const id of before.merge) out.independent.push(`${id} の統合`);
		if (before.verify) out.independent.push(`${before.verify} の全体検証`);
		if (before.replan.length)
			out.independent.push(
				`止まった作業の再計画（${before.replan.join("・")}）`,
			);
	}

	// ---- 運用状態 ----
	const rs = runnerAlive(ctx);
	const sv = readSupervisorState(ctx);
	const svFresh =
		sv.heartbeatAt && at.getTime() - Date.parse(sv.heartbeatAt) < 5 * 60_000;
	const { events, broken, missing } = readEvents(ctx, { since, until });
	if (missing)
		out.missing.push(
			"運用の記録（.devkit/events.jsonl）がない（実行・停止の履歴は集計していない）",
		);
	if (broken) out.missing.push(`運用の記録に読めない行が ${broken} 行ある`);
	// 実行は、締切の後の終了も見て分ける（締切の時点で実行中だったものを、落ちたものと書かない）
	const later = readEvents(ctx, {
		since,
		until: Math.max(until, at.getTime()),
	}).events;
	const runs = new Map();
	for (const e of later) {
		if (!e.type?.startsWith("run_")) continue;
		const key = `${e.run}:${e.pid}`;
		const r = runs.get(key) ?? { run: e.run, pid: e.pid };
		if (e.type === "run_started")
			Object.assign(r, { startedAt: e.at, by: e.by });
		if (e.type === "run_ended")
			Object.assign(r, {
				endedAt: e.at,
				code: e.code,
				reason: clean(e.reason, 200),
				costUsd: e.costUsd ?? 0,
			});
		if (e.type === "run_refused")
			Object.assign(r, {
				endedAt: e.at,
				code: e.code,
				reason: `起動しなかった: ${clean(e.reason, 200)}`,
				refused: true,
			});
		runs.set(key, r);
	}
	const runList = [...runs.values()].filter((r) =>
		r.startedAt
			? Date.parse(r.startedAt) <= until
			: Date.parse(r.endedAt ?? 0) <= until,
	);
	for (const r of runList) {
		if (r.endedAt && Date.parse(r.endedAt) > until) {
			r.atDeadline = "締切の時点で実行中（その後に終了）";
			r.reason = `締切の時点で実行中。${formatZoned(new Date(r.endedAt), tz)} に終了: ${r.reason ?? ""}`;
			r.endedAt = null;
		}
	}
	const crashed = runList.filter(
		(r) =>
			r.startedAt &&
			!r.endedAt &&
			!r.atDeadline &&
			!(rs.alive && rs.lock?.pid === r.pid),
	);
	for (const r of crashed)
		out.missing.push(
			`途中で終わった実行がある（${r.run}、pid ${r.pid}。終了の記録がない。落ちた可能性）`,
		);
	const retries = events.filter((e) => e.type === "supervisor_retry");
	const maxCycles = c.maxCycles ?? g.limits.maxCycles;
	const costWindow =
		Math.round(runList.reduce((x, r) => x + (r.costUsd ?? 0), 0) * 100) / 100;
	out.operations = {
		outer: s.outer,
		reason: clean(s.reason, 200),
		runner: rs.alive
			? {
					alive: true,
					pid: rs.lock?.pid,
					phase: rs.run?.phase ?? "",
					current: Object.keys(rs.run?.current ?? {}),
				}
			: { alive: false },
		supervisor: svFresh
			? {
					alive: true,
					status: sv.status,
					reason: clean(sv.reason, 200),
					nextRetryAt: sv.current?.nextAt ?? null,
				}
			: { alive: false, status: sv.status, reason: clean(sv.reason, 200) },
		cycles: {
			used: s.cycle ?? 0,
			max: maxCycles,
			left: Math.max(0, maxCycles - (s.cycle ?? 0)),
		},
		runsToday: sv.day?.runs ?? null,
		maxRunsPerDay: config.supervisor.limits.maxRunsPerDay,
		usage: {
			windowUsd: costWindow,
			totalUsd: Math.round((s.usage?.costUsd ?? 0) * 100) / 100,
		},
		runs: runList.map((r) => ({
			run: r.run,
			startedAt: r.startedAt ?? null,
			endedAt: r.endedAt ?? null,
			code: r.code ?? null,
			reason: r.reason ?? "",
			by: r.by ?? null,
		})),
		retries: retries.map((e) => ({
			at: e.at,
			kind: e.kind,
			attempt: e.attempt,
			nextAt: e.nextAt,
		})),
	};
	if (!svFresh)
		out.missing.push(
			"Supervisor が動いていない（自動の再開・再試行はしていない）",
		);
	return finish(ctx, out, config);
}

function finish(ctx, out, config) {
	const unlockCount = new Set(
		out.decisions.flatMap((d) => d.impact?.unlocked ?? []),
	).size;
	const nAch = out.achievements.length;
	const nDec = new Set(out.decisions.map((d) => `${d.id}:${d.role}`)).size;
	out.subject = `［devkit／${out.project}］${out.window.partial ? "途中経過・" : "夜間"}成果${nAch}件・判断${nDec}件・判断後に${unlockCount}作業`;
	out.text = renderBriefing(out, config);
	return out;
}

function ops(o) {
	const st =
		{
			idle: "計画中（未開始）",
			running: "進行中",
			paused: "一時停止",
			stalled: "停止（進捗なし）",
			done: "完了",
		}[o.outer] ?? o.outer;
	return `${st}${o.reason ? `（${o.reason}）` : ""}`;
}

export function renderBriefing(b, config) {
	const tz = b.window.timeZone;
	const since = new Date(b.window.since);
	const until = new Date(b.window.until);
	const L = [];
	L.push(b.subject);
	L.push("");
	L.push(
		`対象: ${formatZoned(since, tz)}〜${formatZoned(until, tz)}（${tz}）${b.window.partial ? "の途中経過" : ""}。${formatZoned(until, tz, { withDate: false })} 時点: ${b.operations?.outer ? ops(b.operations) : "—"}`,
	);
	L.push(
		`作成: ${formatZoned(new Date(b.generatedAt), tz)}${b.delayMinutes > 5 ? `（締切から ${b.delayMinutes} 分遅れて作成。対象期間は締切までのまま）` : ""}。この報告は記録から決まった形で作っています（AI による要約ではありません）。`,
	);
	if (b.mission) L.push(`ミッション: ${b.mission}`);
	L.push("");
	L.push("## 夜間の成果");
	if (!b.achievements.length)
		L.push("- この期間に新しく完了したものはありません");
	for (const a of b.achievements) {
		if (a.kind === "node") {
			L.push(
				`- ${a.target}「${a.title}」: 完了（統合 ${a.commit}）。受入基準 ${a.acceptance.join("・") || "なし"}。${a.verification}`,
			);
			if (a.summary) L.push(`  内容: ${a.summary}`);
			if (a.deferredAcs?.length)
				L.push(
					`  E2E での照合待ち: ${a.deferredAcs.join("・")}（マイルストーンの全体検証で確かめる）`,
				);
			if (a.evidence) L.push(`  証跡: ${a.evidence}`);
		} else if (a.kind === "milestone")
			L.push(`- ${a.target}「${a.title}」: ${a.event}（版 ${a.commit}）`);
		else L.push(`- ${a.event}`);
	}
	const acc = b.acceptance;
	if (acc.total)
		L.push(
			`- 受入基準: 達成 ${new Set(acc.achieved).size}/${acc.total}${acc.achievedInWindow.length ? `（この期間に ${acc.achievedInWindow.join("・")}）` : ""}${acc.deferred.length ? `。E2E の照合待ち ${acc.deferred.join("・")}` : ""}${acc.pending.length ? `。未達 ${acc.pending.join("・")}` : ""}`,
		);
	if (b.concerns.length) {
		L.push("- 残っている懸念:");
		for (const x of b.concerns.slice(0, 12)) L.push(`  - ${x}`);
	}
	L.push("");
	L.push("## 今朝判断してほしいこと");
	if (!b.decisions.length) L.push("- 判断待ちはありません");
	for (const d of b.decisions) {
		L.push(`- ${d.id}／${ROLE_PERSON[d.role]}: ${d.question}`);
		L.push(`  優先度: ${d.priority}／期限: 未設定（計画に期限の項目がない）`);
		if (d.why) L.push(`  理由: ${d.why}`);
		L.push(
			`  推奨: ${d.recommendation || "—"}${d.alternatives?.length ? `。代替: ${d.alternatives.join(" ／ ")}` : ""}`,
		);
		const imp = d.impact ?? {};
		L.push(
			`  影響: ${imp.steps?.length ? `判断で ${imp.steps.join("・")} に進める${imp.needsAll ? `（${imp.needsAll.join("と")}の両方の承認で）` : ""}` : "判断しても、すぐに始まる作業はない"}。未判断のままでは、この経路は止まったまま`,
		);
		L.push(`  対象の版: ${d.version}／確認先: ${d.where}`);
		L.push(`  端末で: ${d.command}`);
	}
	L.push("");
	L.push("## 判断後に進む作業");
	const flows = b.decisions.filter((d) => d.impact?.steps?.length);
	if (!flows.length) L.push("- 判断を受けて始まる作業はありません");
	for (const d of flows)
		L.push(
			`- ${d.id} → ${d.impact.steps.join(" → ")}${d.impact.later?.length ? ` → その後 ${d.impact.later.join("・")}` : ""}`,
		);
	L.push(
		`- 判断を待たずに進む作業: ${b.independent.length ? b.independent.join("・") : "なし"}`,
	);
	L.push("- 所要時間: 実績の記録がないため示しません");
	L.push("");
	L.push("## 運用状態");
	const o = b.operations ?? {};
	if (o.runner) {
		L.push(
			`- 状態: ${ops(o)}／ランナー: ${o.runner.alive ? `実行中（${o.runner.phase}${o.runner.current?.length ? `: ${o.runner.current.join("・")}` : ""}）` : "停止中"}`,
		);
		L.push(
			`- Supervisor: ${o.supervisor.alive ? `動いている（${o.supervisor.status}${o.supervisor.reason ? `: ${o.supervisor.reason}` : ""}）` : `動いていない${o.supervisor.status && o.supervisor.status !== "stopped" ? `（最後の状態: ${o.supervisor.status}）` : ""}`}${o.supervisor.nextRetryAt ? `／次の再試行 ${formatZoned(new Date(o.supervisor.nextRetryAt), tz)}` : ""}`,
		);
		L.push(
			`- 残りの上限: サイクル ${o.cycles.left}（${o.cycles.used}/${o.cycles.max}）${o.runsToday !== null ? `／今日の自動起動 ${o.runsToday}/${o.maxRunsPerDay}` : ""}`,
		);
		L.push(
			`- 使用量の目安: この期間 $${o.usage.windowUsd}・累計 $${o.usage.totalUsd}（API の料金で換算した目安。実際の請求額やサブスクリプションの残りの枠ではありません）`,
		);
		L.push(
			`- この期間の実行: ${o.runs.length} 回${
				o.runs.length
					? `（${o.runs
							.slice(-5)
							.map((r) =>
								`${r.startedAt ? formatZoned(new Date(r.startedAt), tz, { withDate: false }) : "?"}〜${r.endedAt ? formatZoned(new Date(r.endedAt), tz, { withDate: false }) : "実行中"} ${r.reason || ""}`.trim(),
							)
							.join(" ／ ")}）`
					: ""
			}`,
		);
		if (o.retries?.length)
			L.push(
				`- 再試行: ${o.retries.map((r) => `${r.kind} ${r.attempt} 回目（${formatZoned(new Date(r.nextAt), tz, { withDate: false })}）`).join(" ／ ")}`,
			);
	} else if (o.summary) L.push(`- ${o.summary}`);
	L.push(
		`- 集計の欠落・未取得: ${b.missing.length ? b.missing.join("／") : "なし"}`,
	);
	L.push("");
	return L.join("\n");
}

// ---------- 保存と配信 ----------

export function briefingDir(ctx) {
	return join(ctx.dir, "briefings");
}

export function writeBriefing(ctx, b) {
	const p = zonedParts(new Date(b.window.until), b.window.timeZone);
	const name = `${p.y}${String(p.mo).padStart(2, "0")}${String(p.d).padStart(2, "0")}-${String(p.h).padStart(2, "0")}${String(p.mi).padStart(2, "0")}${b.window.partial ? "-partial" : ""}`;
	const dir = briefingDir(ctx);
	mkdirSync(dir, { recursive: true });
	const md = join(dir, `${name}.md`);
	writeText(md, b.text);
	const { text, ...data } = b;
	writeJson(join(dir, `${name}.json`), data);
	return relative(ctx.root, md);
}

export function deliveryKey(ctx, deadlineIso, to) {
	return sha256(`${ctx.root}|${deadlineIso}|${to}`).slice(0, 16);
}

// 送信待ちに入れる（同じ配信キーがあれば入れ直さない）
export function enqueueBriefing(ctx, b, file, to) {
	const key = deliveryKey(ctx, b.window.until, to);
	const path = join(supervisorPaths(ctx).outbox, `${key}.json`);
	const cur = readJson(path, null);
	if (cur) return cur;
	const entry = {
		key,
		deadline: b.window.until,
		to,
		subject: b.subject,
		file,
		status: "pending",
		attempts: 0,
		nextAt: now().toISOString(),
		createdAt: now().toISOString(),
		lastError: null,
		sentAt: null,
	};
	writeJson(path, entry);
	return entry;
}

// 送信待ち。壊れたファイルは読まずに脇へよける（1つ壊れていても、ほかの配信を止めない）
export function outboxEntries(ctx) {
	const dir = supervisorPaths(ctx).outbox;
	if (!existsSync(dir)) return [];
	const out = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
		try {
			const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
			if (e?.key) out.push(e);
		} catch {
			try {
				renameSync(join(dir, f), join(dir, `${f}.broken`));
			} catch {}
		}
	}
	return out;
}

// 1つの配信を、送る間だけ自分のものにする（Supervisor と人の briefing --send が同時に送らない）
function claim(dir, key) {
	const lock = join(dir, `${key}.sending`);
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		return () => rmSync(lock, { force: true });
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs > 120_000) {
				rmSync(lock, { force: true });
				writeFileSync(lock, String(process.pid), { flag: "wx" });
				return () => rmSync(lock, { force: true });
			}
		} catch {}
		return null;
	}
}

// 送信待ちを送る。失敗したら間隔をあけて送り直し、上限を超えたら failed（保存したブリーフィングは残る）
export async function flushOutbox(ctx, { maxAttempts = 12 } = {}) {
	const results = [];
	const dir = supervisorPaths(ctx).outbox;
	for (const listed of outboxEntries(ctx)) {
		if (
			!["pending", "no_target"].includes(listed.status) ||
			Date.parse(listed.nextAt) > now().getTime()
		)
			continue;
		const release = claim(dir, listed.key);
		if (!release) continue;
		try {
			const path = join(dir, `${listed.key}.json`);
			// 自分のものにしてから読み直す（ほかのプロセスが送り終えていたら送らない）
			const e = readJson(path, null);
			if (!e || !["pending", "no_target"].includes(e.status)) continue;
			await sendOne(ctx, e, path, maxAttempts, results);
		} catch {
		} finally {
			release();
		}
	}
	return results;
}

async function sendOne(ctx, e, path, maxAttempts, results) {
	const target = briefingTarget(e.to);
	if (!target) {
		// 送り先がない: 失敗にせず、待ってから確かめ直す（あとで環境変数を設定すれば送られる）
		Object.assign(e, {
			status: "no_target",
			lastError:
				"送り先が設定されていない（DEVKIT_NOTIFY_CMD など）。保存したブリーフィングを見る",
			nextAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
		});
		writeJson(path, e);
		results.push(e);
		return;
	}
	let text = "";
	try {
		text = readFileSync(join(ctx.root, e.file), "utf8");
	} catch {
		text = `${e.subject}\n（本文のファイル ${e.file} を読めなかった）`;
	}
	const r = await notify({
		target,
		message: text,
		subject: e.subject,
		file: join(ctx.root, e.file),
	});
	e.attempts += 1;
	if (r.sent) {
		Object.assign(e, {
			status: "sent",
			sentAt: now().toISOString(),
			lastError: null,
		});
		appendEvent(
			ctx,
			"briefing_sent",
			{ key: e.key, deadline: e.deadline, to: e.to },
			`briefing:${e.key}:sent`,
		);
	} else {
		const wait = Math.min(60, 2 ** e.attempts) * 60_000;
		Object.assign(e, {
			lastError: r.reason,
			nextAt: new Date(now().getTime() + wait).toISOString(),
		});
		if (e.attempts >= maxAttempts) e.status = "failed";
		appendEvent(ctx, "briefing_failed", {
			key: e.key,
			deadline: e.deadline,
			attempt: e.attempts,
			reason: clean(r.reason, 200),
		});
	}
	if (e.status === "no_target") e.status = "pending";
	writeJson(path, e);
	results.push(e);
}

// 締切の分を作って保存し、送信待ちに入れる（同じ締切で2回作らない）。戻り値: { briefing, file, entry, created }
export function produceBriefing(ctx, { at = now(), deadline = null } = {}) {
	const config = loadConfig(ctx);
	const window = deadline
		? {
				since: previousDeadline(
					deadline,
					config.briefing.time,
					config.briefing.timeZone,
				),
				until: deadline,
				timeZone: config.briefing.timeZone,
				time: config.briefing.time,
			}
		: null;
	const b = buildBriefing(ctx, { at, window });
	const key = deliveryKey(ctx, b.window.until, config.briefing.to);
	const existing = outboxEntries(ctx).find((e) => e.key === key);
	if (existing)
		return {
			briefing: b,
			file: existing.file,
			entry: existing,
			created: false,
		};
	const file = writeBriefing(ctx, b);
	appendEvent(
		ctx,
		"briefing_generated",
		{
			deadline: b.window.until,
			file,
			decisions: b.decisions.length,
			achievements: b.achievements.length,
		},
		`briefing:${b.window.until}:generated`,
	);
	const entry = enqueueBriefing(ctx, b, file, config.briefing.to);
	return { briefing: b, file, entry, created: true };
}
