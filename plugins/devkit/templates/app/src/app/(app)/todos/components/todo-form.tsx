"use client";

import { useActionState } from "react";
import { initialActionState } from "@/lib/action-state";
import { createTodoAction } from "../actions";

// "use client" は components/ の下（と error.tsx / global-error.tsx）にだけ書く。
// データの取得や権限の確認はサーバー側（page.tsx と defineAction）で行い、ここはフォームの表示だけにする。
export function TodoForm() {
  const [state, formAction, pending] = useActionState(createTodoAction, initialActionState);
  const titleError = state.errors?.title;

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <div className="space-y-1">
        <label htmlFor="title" className="block text-sm font-medium">
          タイトル
        </label>
        <input
          id="title"
          name="title"
          type="text"
          maxLength={200}
          aria-invalid={Boolean(titleError)}
          aria-describedby={titleError ? "title-error" : undefined}
          className="w-full rounded border border-gray-400 px-3 py-2"
        />
        {titleError && (
          <p id="title-error" className="text-sm text-red-700">
            {titleError}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {pending ? "登録中…" : "登録する"}
      </button>
      {state.message && (
        <p role="status" className={state.status === "error" ? "text-red-700" : "text-green-800"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
