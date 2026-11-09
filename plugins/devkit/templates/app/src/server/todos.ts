import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { type Todo, todos } from "@/db/schema";

// サーバー処理は「入力検証 → DB 操作」を1関数にまとめ、Db を引数で受け取る（テストで差し替えるため）。
// 権限の確認と監査ログは呼び出し側（defineAction）が行う。ここは業務の処理だけを書く。
export const CreateTodoInput = z.object({
  title: z.string().trim().min(1, "タイトルは必須です").max(200, "タイトルは200文字以内で入力してください"),
});

export async function createTodo(db: Db, input: unknown): Promise<Todo> {
  const { title } = CreateTodoInput.parse(input);
  const [row] = await db.insert(todos).values({ title }).returning();
  if (!row) throw new Error("insert failed");
  return row;
}

export async function listTodos(db: Db): Promise<Todo[]> {
  return db.select().from(todos).orderBy(asc(todos.id));
}

export async function completeTodo(db: Db, id: number): Promise<Todo | undefined> {
  const [row] = await db.update(todos).set({ done: true }).where(eq(todos.id, id)).returning();
  return row;
}
