// Server Action（defineAction）の結果の型。画面（クライアントコンポーネント）とサーバーの両方から使う。
// クライアントコンポーネントは src/server/ を import しないので、型と初期値はここから import する。
//
//   const [state, formAction, pending] = useActionState(createTodoAction, initialActionState);
export type ActionState<T = unknown> = {
  status: "idle" | "success" | "error";
  // 利用者に見せるメッセージ（日本語）。内部のエラー内容は入れない
  message?: string;
  // 入力欄ごとのエラー（キーはフォームの name。欄の直下に表示する）
  errors?: Record<string, string>;
  data?: T;
};

export const initialActionState: ActionState<never> = { status: "idle" };
