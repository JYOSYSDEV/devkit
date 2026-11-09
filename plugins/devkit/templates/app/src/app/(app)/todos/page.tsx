import { AccessDenied } from "@/components/access-denied";
import { getDb } from "@/db/client";
import { requirePermission } from "@/server/auth/guard";
import { can, ROLE_LABELS } from "@/server/auth/permissions";
import { listTodos } from "@/server/todos";
import { TodoForm } from "./components/todo-form";

const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
  timeStyle: "short",
});

// サンプル機能。画面の先頭で閲覧の権限を確かめ、登録欄は登録の権限がある人にだけ出す
// （登録の権限は defineAction も確かめるので、欄を隠すのは表示のためだけ）。
export default async function TodosPage() {
  const access = await requirePermission("todos.read");
  if (!access.ok) return <AccessDenied message={access.message} />;
  const { user } = access;
  const canCreate = can(user, "todos.create");
  const rows = await listTodos(await getDb());

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">やること</h1>
        <p className="text-sm text-gray-600">
          {user.name}（{user.roles.map((r) => ROLE_LABELS[r]).join("・")}）
        </p>
      </div>

      <section aria-labelledby="new-heading" className="space-y-3">
        <h2 id="new-heading" className="text-lg font-semibold">
          新規登録
        </h2>
        {canCreate ? <TodoForm /> : <p>閲覧のみの権限のため、登録はできません。</p>}
      </section>

      <section aria-labelledby="list-heading" className="space-y-3">
        <h2 id="list-heading" className="text-lg font-semibold">
          一覧
        </h2>
        {rows.length === 0 ? (
          <p>まだ登録がありません。</p>
        ) : (
          <ul className="divide-y divide-gray-200 rounded border border-gray-200">
            {rows.map((todo) => (
              <li key={todo.id} className="flex items-center justify-between gap-4 p-4">
                <span className={todo.done ? "text-gray-500 line-through" : ""}>{todo.title}</span>
                <time dateTime={todo.createdAt.toISOString()} className="text-sm text-gray-500">
                  {dateFormat.format(todo.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
