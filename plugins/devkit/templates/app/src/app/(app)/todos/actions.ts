"use server";

import { revalidatePath } from "next/cache";
import { defineAction } from "@/server/action";
import { CreateTodoInput, createTodo } from "@/server/todos";

// "use server" のファイルには defineAction で作った Server Action だけを書く（権限・入力検証・監査ログは defineAction が行う）。
export const createTodoAction = defineAction({
  permission: "todos.create",
  input: CreateTodoInput,
  audit: true,
  async handler(input, { db }) {
    const todo = await createTodo(db, input);
    revalidatePath("/todos");
    return { message: "登録しました", auditTarget: todo.id };
  },
});
