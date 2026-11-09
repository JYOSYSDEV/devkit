import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Db } from "@/db/client";
import { DbError } from "@/db/errors";
import { auditLogs } from "@/db/schema";
import { type ActionDefinition, ActionError, executeAction, formDataToObject, MESSAGES } from "@/server/action";
import { DENIED_AUDIT_WINDOW_SECONDS } from "@/server/audit";
import type { CurrentUser, Permission } from "@/server/auth/permissions";
import { createTestDb } from "../helpers/test-db";

// defineAction の仕組みのテストは、サンプル（todos）や案件の権限表に依存させない（サンプルを消しても動くように）。
// 権限表はテスト用のものに差し替え、DB はテストの中で作る表 items を使う。
vi.mock("@/server/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/permissions")>();
  const table: Record<string, readonly string[]> = {
    "items.read": ["admin", "member", "viewer"],
    "items.create": ["admin", "member"],
  };
  return {
    ...actual,
    PERMISSIONS: table,
    can: (user: CurrentUser | null, permission: string) =>
      !!user && user.roles.some((r) => (table[permission] ?? []).includes(r)),
  };
});

const CREATE = "items.create" as Permission;
const member: CurrentUser = { id: "u-member", name: "一般", roles: ["member"] };
const viewer: CurrentUser = { id: "u-viewer", name: "閲覧者", roles: ["viewer"] };

const ItemInput = z.object({ title: z.string().trim().min(1, "タイトルは必須です").max(200) });

async function insertItem(db: Db, title: string): Promise<number> {
  const result = await db.execute(sql`insert into items (title) values (${title}) returning id`);
  return Number((result as unknown as { rows: { id: number }[] }).rows[0]?.id);
}

async function itemTitles(db: Db): Promise<string[]> {
  const result = await db.execute(sql`select title from items order by id`);
  return (result as unknown as { rows: { title: string }[] }).rows.map((r) => r.title);
}

// "use server" のファイル（例: src/app/(app)/todos/actions.ts）と同じ形の定義
const createItemDef: ActionDefinition<typeof ItemInput, { id: number }> = {
  permission: CREATE,
  input: ItemInput,
  audit: true,
  async handler(input, { db }) {
    const id = await insertItem(db, input.title);
    return { message: "登録しました", data: { id }, auditTarget: id };
  },
};

// ロガーの出力（標準出力・標準エラー）を集める
function captureLogs() {
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, "write").mockImplementation(collect);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(collect);
  return {
    lines,
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}

describe("executeAction（defineAction の中身）", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.execute(sql`create table items (id serial primary key, title text not null)`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
  });

  it("権限があり入力が正しければ処理し、同じトランザクションで監査ログを残す", async () => {
    const r = await executeAction(createItemDef, { db, user: member, requestId: "req-1" }, { title: "請求書を送る" });
    expect(r.status).toBe("success");
    expect(r.message).toBe("登録しました");
    expect(await itemTitles(db)).toEqual(["請求書を送る"]);
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => [l.actorId, l.action, l.outcome, l.target, l.requestId])).toEqual([
      ["u-member", "items.create", "success", "1", "req-1"],
    ]);
  });

  it("保存後に移る画面（redirectTo）は、確定した後の結果として返す", async () => {
    const def: ActionDefinition<typeof ItemInput, undefined> = {
      ...createItemDef,
      async handler(input, { db: tx }) {
        const id = await insertItem(tx, input.title);
        return { auditTarget: id, redirectTo: `/items/${id}` };
      },
    };
    const r = await executeAction(def, { db, user: member }, { title: "移動する" });
    expect(r).toMatchObject({ status: "success", redirectTo: "/items/1" });
    expect(await itemTitles(db)).toHaveLength(1);
  });

  it("権限がなければ「この操作を行う権限がありません」を返し、処理せず、拒否の監査ログをちょうど1行残す", async () => {
    const handler = vi.fn(createItemDef.handler);
    const r = await executeAction(
      { ...createItemDef, handler },
      { db, user: viewer, requestId: "req-2" },
      { title: "x" },
    );
    expect(r).toEqual({ status: "error", message: "この操作を行う権限がありません" });
    expect(handler).not.toHaveBeenCalled();
    expect(await itemTitles(db)).toHaveLength(0);
    const logs = await db.select().from(auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs.map((l) => [l.actorId, l.action, l.outcome, l.requestId, l.attempts])).toEqual([
      ["u-viewer", "items.create", "denied", "req-2", 1],
    ]);
  });

  it("ログインしていなければ「ログインしてください」を返し、actor を anonymous として残す", async () => {
    const r = await executeAction(createItemDef, { db, user: null }, { title: "x" });
    expect(r).toEqual({ status: "error", message: MESSAGES.loginRequired });
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => [l.actorId, l.outcome])).toEqual([["anonymous", "denied"]]);
  });

  it("未ログインの呼び出しを繰り返しても、時間枠の中では1行にまとめて回数を数える", async () => {
    const base = new Date("2026-04-01T09:00:05Z");
    for (let i = 0; i < 5; i++) {
      const now = new Date(base.getTime() + i * 1000);
      await executeAction(createItemDef, { db, user: null, requestId: `req-${i}`, now }, { title: "x" });
    }
    let logs = await db.select().from(auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: "anonymous", outcome: "denied", attempts: 5, requestId: "req-0" });

    // 次の時間枠では新しい行になる
    const next = new Date(base.getTime() + DENIED_AUDIT_WINDOW_SECONDS * 1000);
    await executeAction(createItemDef, { db, user: null, now: next }, { title: "x" });
    logs = await db.select().from(auditLogs);
    expect(logs).toHaveLength(2);
  });

  it("処理が途中で失敗したら、書き込みも監査ログも取り消す", async () => {
    const logs = captureLogs();
    const failing: ActionDefinition<typeof ItemInput, undefined> = {
      ...createItemDef,
      async handler(input, { db: tx }) {
        await insertItem(tx, input.title);
        throw new Error("後続の処理で失敗");
      },
    };
    const r = await executeAction(failing, { db, user: member }, { title: "途中まで" });
    logs.restore();
    expect(r).toEqual({ status: "error", message: MESSAGES.failed });
    expect(await itemTitles(db)).toHaveLength(0);
    expect(await db.select().from(auditLogs)).toHaveLength(0);
  });

  it("監査ログの書き込みが失敗したら、処理の書き込みも取り消す", async () => {
    const logs = captureLogs();
    await db.execute(sql`drop table audit_logs`);
    const r = await executeAction(createItemDef, { db, user: member }, { title: "監査ログなし" });
    logs.restore();
    expect(r).toEqual({ status: "error", message: MESSAGES.failed });
    expect(await itemTitles(db)).toHaveLength(0);
  });

  it("一意制約の違反は利用者向けの文言にし、ログには入力値を出さずコードと制約名だけを残す", async () => {
    await db.execute(sql`create table uniq_test (v text unique)`);
    const secret = "yamada.taro@example.co.jp";
    const def: ActionDefinition<typeof ItemInput, undefined> = {
      permission: CREATE,
      input: ItemInput,
      audit: true,
      async handler(input, { db: tx }) {
        await tx.execute(sql`insert into uniq_test (v) values (${input.title})`);
        await tx.execute(sql`insert into uniq_test (v) values (${input.title})`);
        return {};
      },
    };

    // 前提の確認: Db の例外は、値を含まない DbError に包み直されている（src/db/errors.ts）
    const direct = await db
      .transaction(async (tx) => def.handler({ title: secret }, { db: tx, user: member }))
      .catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(DbError);
    expect(inspect(direct, { depth: 5 })).not.toContain(secret);

    const logs = captureLogs();
    const r = await executeAction(def, { db, user: member, requestId: "req-uniq" }, { title: secret });
    logs.restore();

    expect(r).toEqual({ status: "error", message: "同じ内容がすでに登録されています" });
    const output = logs.lines.join("");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("yamada");
    const entry = JSON.parse(logs.lines.find((l) => l.includes('"action_failed"')) ?? "{}");
    expect(entry).toMatchObject({
      level: "error",
      event: "action_failed",
      action: "items.create",
      userId: "u-member",
      requestId: "req-uniq",
      code: "23505",
      constraint: "uniq_test_v_key",
    });
    expect(entry).not.toHaveProperty("message");
    expect(await db.select().from(auditLogs)).toHaveLength(0);
  });

  it("入力エラーは欄ごとのメッセージで返し、処理しない", async () => {
    const r = await executeAction(createItemDef, { db, user: member }, { title: "   " });
    expect(r).toEqual({ status: "error", message: MESSAGES.invalidInput, errors: { title: "タイトルは必須です" } });
    expect(await itemTitles(db)).toHaveLength(0);
  });

  it("業務エラー（ActionError）はそのまま返し、想定外の例外は内部の情報を隠す", async () => {
    const logs = captureLogs();
    const def: ActionDefinition<z.ZodObject<{ kind: z.ZodString }>, undefined> = {
      permission: CREATE,
      input: z.object({ kind: z.string() }),
      audit: false,
      async handler({ kind }) {
        if (kind === "business") throw new ActionError("締め日を過ぎているため登録できません");
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      },
    };
    const business = await executeAction(def, { db, user: member }, { kind: "business" });
    const unexpected = await executeAction(def, { db, user: member }, { kind: "other" });
    logs.restore();
    expect(business).toEqual({ status: "error", message: "締め日を過ぎているため登録できません" });
    expect(unexpected).toEqual({ status: "error", message: MESSAGES.failed });
    expect(JSON.stringify(unexpected)).not.toContain("10.0.0.1");
  });

  it("FormData ではない引数（Server Action を直接呼んだ場合など）は入力の誤りにし、拒否の監査ログに残す", async () => {
    const handler = vi.fn(createItemDef.handler);
    const r = await executeAction(
      { ...createItemDef, handler },
      { db, user: member, requestId: "req-raw" },
      { title: "直接" },
      { requireFormData: true },
    );
    expect(r).toEqual({ status: "error", message: MESSAGES.invalidInput });
    expect(handler).not.toHaveBeenCalled();
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => [l.actorId, l.outcome, l.requestId, l.detail])).toEqual([
      ["u-member", "denied", "req-raw", { reason: "invalid_request" }],
    ]);
  });

  it("権限がなければ、受け取った値（FormData）を読む前に止める", async () => {
    const fd = new FormData();
    fd.append("title", "読まれない");
    const getAll = vi.spyOn(fd, "getAll");
    const r = await executeAction(createItemDef, { db, user: viewer }, fd, { requireFormData: true });
    expect(r.message).toBe(MESSAGES.forbidden);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("FormData を入力スキーマに合わせてオブジェクトにして検証する", async () => {
    const fd = new FormData();
    fd.append("$ACTION_ID_abc", "");
    fd.append("title", "フォームから");
    const r = await executeAction(createItemDef, { db, user: member }, fd, { requireFormData: true });
    expect(r.status).toBe("success");
    expect(await itemTitles(db)).toEqual(["フォームから"]);
  });

  it("非同期の検証（refine(async …)）が例外を投げても、500 にせず一般的なメッセージを返す", async () => {
    const logs = captureLogs();
    const def: ActionDefinition<z.ZodType<{ code: string }>, undefined> = {
      permission: CREATE,
      input: z.object({ code: z.string() }).refine(async () => {
        throw new Error("検証用の外部サービスに接続できない");
      }),
      audit: false,
      handler: async () => ({}),
    };
    const r = await executeAction(def, { db, user: member }, { code: "x" });
    logs.restore();
    expect(r).toEqual({ status: "error", message: MESSAGES.failed });
  });

  it("非同期の検証で不合格なら、入力の誤りとして返す", async () => {
    const def: ActionDefinition<z.ZodType<{ code: string }>, undefined> = {
      permission: CREATE,
      input: z
        .object({ code: z.string() })
        .refine(async (v) => v.code === "ok", { message: "使えないコードです", path: ["code"] }),
      audit: false,
      handler: async () => ({}),
    };
    const r = await executeAction(def, { db, user: member }, { code: "ng" });
    expect(r).toEqual({ status: "error", message: MESSAGES.invalidInput, errors: { code: "使えないコードです" } });
  });
});

describe("formDataToObject", () => {
  it("スキーマが配列の項目は、値が1つでも0個でも配列にする（チェックボックス・複数選択）", () => {
    const schema = z.object({
      title: z.string(),
      tags: z.array(z.string()),
      roles: z.array(z.string()).optional(),
      ids: z.preprocess((v) => v, z.array(z.coerce.number())).default([]),
    });
    const fd = new FormData();
    fd.append("title", "請求書");
    fd.append("tags", "a");
    expect(formDataToObject(fd, schema)).toEqual({ title: "請求書", tags: ["a"], roles: [], ids: [] });
  });

  it("Next.js が付ける $ACTION_ の項目を除き、同じ name が複数あれば配列にする", () => {
    const fd = new FormData();
    fd.append("$ACTION_ID_abc", "");
    fd.append("title", "請求書");
    fd.append("tags", "a");
    fd.append("tags", "b");
    expect(formDataToObject(fd)).toEqual({ title: "請求書", tags: ["a", "b"] });
  });
});
