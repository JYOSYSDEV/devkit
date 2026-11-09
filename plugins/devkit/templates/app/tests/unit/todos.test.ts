import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { completeTodo, createTodo, listTodos } from "@/server/todos";
import { createTestDb } from "../helpers/test-db";

describe("todos（サンプル）", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  it("作成した todo が一覧に出る", async () => {
    await createTodo(db, { title: "請求書を送る" });
    const rows = await listTodos(db);
    expect(rows.map((r) => r.title)).toEqual(["請求書を送る"]);
    expect(rows[0]?.done).toBe(false);
  });

  it("空のタイトルは拒否する", async () => {
    await expect(createTodo(db, { title: "   " })).rejects.toThrow("タイトルは必須です");
  });

  it("完了にできる", async () => {
    const todo = await createTodo(db, { title: "経費を申請する" });
    const updated = await completeTodo(db, todo.id);
    expect(updated?.done).toBe(true);
  });
});
