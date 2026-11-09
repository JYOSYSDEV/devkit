export const meta = {
  name: "devkit-graph",
  description: "devkit の ready ノードを並列に実装し、goal 条件を独立検証してから統合ブランチへ統合する",
  whenToUse: "devkit-outer-loop スキルの各サイクルで、pnpm -s devkit dispatch の出力をそのまま args に渡す",
  phases: [
    { title: "Implement", detail: "ノードごとに隔離 worktree で実装" },
    { title: "Verify", detail: "別エージェントが goal 条件を判定し、未達ならフィードバックして再実装" },
    { title: "Integrate", detail: "達成ノードを統合ブランチへマージして全体検証" },
  ],
};

// ---- 入力 ----
// args = { cycle, branch, verify, maxRounds, nodes: [{ id, title, goal, owns, spec, attempts, note, branch }] }
// nodes[].branch はノードブランチ名（dispatch が統合ブランチ名を含めて決める。例: devkit/expense-app--N2-c3）
// pnpm -s devkit dispatch の出力をそのまま渡す。
const input = args ?? {};
const nodes = Array.isArray(input.nodes) ? input.nodes : [];
const cycle = input.cycle;
const baseBranch = input.branch;
const verifyCmd = input.verify ?? "pnpm verify";
const maxRounds = Math.min(Math.max(Number(input.maxRounds ?? 3), 1), 5);

// 引数の誤りは黙って空の結果を返さず、失敗として返す（outer loop がノードを pending に戻せるように）
if (!Number.isInteger(cycle) || cycle < 1) throw new Error("args.cycle がない（pnpm -s devkit dispatch の出力を渡す）");
if (!baseBranch) throw new Error("args.branch がない（pnpm -s devkit dispatch の出力を渡す）");
if (nodes.length === 0) throw new Error("args.nodes が空（dispatch の nodes が空なら、ワークフローは起動しない）");

// ---- 構造化出力のスキーマ ----
const IMPL = {
  type: "object",
  required: ["status", "branch", "summary", "evidence"],
  properties: {
    status: { type: "string", enum: ["implemented", "blocked"] },
    branch: { type: "string" },
    worktree: { type: "string" },
    commit: { type: "string" },
    summary: { type: "string" },
    evidence: { type: "string" },
    needs: { type: "string" },
  },
};

const VERDICT = {
  type: "object",
  required: ["verdict", "reason"],
  properties: {
    verdict: { type: "string", enum: ["met", "not_met", "impossible"] },
    reason: { type: "string" },
    feedback: { type: "string" },
    notes: { type: "string" }, // Minor の指摘（判定は止めない）
  },
};

const MERGE = {
  type: "object",
  required: ["nodes", "verify"],
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "result"],
        properties: {
          id: { type: "string" },
          result: { type: "string", enum: ["merged", "conflict", "verify_failed", "skipped"] },
          reason: { type: "string" },
        },
      },
    },
    verify: { type: "string" },
  },
};

// ---- 1ノード = goal ループ（実装 → 独立検証 → 未達ならフィードバックして再実装）----
async function runNode(node) {
  const branch = node.branch || `${baseBranch}--${node.id}-c${cycle}`;
  let feedback = node.note ? `前回までの経緯: ${node.note}` : "";
  let impl = null;
  const worktrees = []; // ラウンドごとの実装者の worktree（作業はブランチにコミット済み。反映のあとで消す）

  for (let round = 1; round <= maxRounds; round++) {
    impl = await agent(
      [
        `devkit ノード ${node.id}「${node.title}」を実装する（サイクル ${cycle}、ラウンド ${round}/${maxRounds}）。`,
        `統合ブランチ: ${baseBranch}`,
        round === 1
          ? `ノードブランチ: ${branch}（新規作成。同じ名前のブランチが既にあれば、何も変更せず status: blocked、needs に「ブランチ ${branch} が既にある」と書いて終える）`
          : `ノードブランチ: ${branch}（前のラウンドの続き。git switch ${branch} で取り出す）`,
        `仕様: ${node.spec ?? "（なし）"}`,
        `変更してよいパス(owns): ${node.owns.join(", ")}`,
        "",
        "goal 条件（これを満たして終える）:",
        node.goal,
        feedback ? `\n前ラウンドの評価者からのフィードバック:\n${feedback}` : "",
      ].join("\n"),
      {
        label: `impl:${node.id}#${round}`,
        phase: "Implement",
        agentType: "implementer",
        isolation: "worktree",
        schema: IMPL,
      },
    );

    if (!impl) return { id: node.id, verdict: "error", reason: "実装エージェントが応答しませんでした", rounds: round, worktrees };
    if (impl.worktree) worktrees.push(impl.worktree);
    if (impl.status === "blocked")
      return {
        id: node.id,
        verdict: "impossible",
        reason: impl.needs || impl.summary,
        branch: impl.branch,
        rounds: round,
        needs: impl.needs ?? "",
        worktrees,
      };

    const v = await agent(
      [
        `devkit ノード ${node.id}「${node.title}」の goal 条件と品質を独立に判定する。`,
        `統合ブランチ: ${baseBranch}`,
        `ノードブランチ: ${impl.branch}`,
        `実装者の worktree: ${impl.worktree ?? "（不明）"}`,
        `実装者の commit: ${impl.commit ?? "（不明）"}`,
        `変更してよいパス(owns): ${node.owns.join(", ")}`,
        "",
        "goal 条件:",
        node.goal,
        "",
        `実装者の自己申告（参考。信用せず自分で確認すること）: ${impl.evidence}`,
      ].join("\n"),
      { label: `verify:${node.id}#${round}`, phase: "Verify", agentType: "verifier", schema: VERDICT },
    );

    if (!v) return { id: node.id, verdict: "error", reason: "評価エージェントが応答しませんでした", rounds: round, worktrees };
    if (v.verdict === "met")
      return {
        id: node.id,
        verdict: "met",
        reason: v.reason,
        branch: impl.branch,
        rounds: round,
        summary: impl.summary,
        needs: impl.needs ?? "",
        notes: v.notes ?? "",
        worktrees,
      };
    if (v.verdict === "impossible")
      return { id: node.id, verdict: "impossible", reason: v.reason, branch: impl.branch, rounds: round, worktrees };
    feedback = v.feedback || v.reason;
  }

  return {
    id: node.id,
    verdict: "not_met",
    reason: `${maxRounds} ラウンドで goal 未達。最後の指摘: ${feedback}`,
    branch: impl?.branch,
    rounds: maxRounds,
    worktrees,
  };
}

phase("Implement");
const results = (await pipeline(nodes, (node) => runNode(node))).map(
  (r, i) => r ?? { id: nodes[i].id, verdict: "error", reason: "ノードの実行が中断されました" },
);

// ---- 統合 ----
const passed = results.filter((r) => r.verdict === "met");
let integration = null;
if (passed.length) {
  phase("Integrate");
  integration = await agent(
    [
      `統合ブランチ ${baseBranch} に、次のノードブランチを上から順にマージし、毎回 \`${verifyCmd}\` で検証する。`,
      ...passed.map((r) => `- ${r.id}: ${r.branch}`),
    ].join("\n"),
    { label: "integrate", phase: "Integrate", agentType: "integrator", schema: MERGE },
  );
}

const mergeResult = new Map((integration?.nodes ?? []).map((n) => [n.id, n]));
for (const r of results) {
  if (r.verdict !== "met") continue;
  const m = mergeResult.get(r.id);
  if (!m || m.result !== "merged") {
    r.verdict = "integration_failed";
    r.reason = m ? `${m.result}: ${m.reason ?? ""}` : "統合結果が返りませんでした";
  }
}

log(results.map((r) => `${r.id}: ${r.verdict}`).join(" / "));
return { cycle, results, integration };
