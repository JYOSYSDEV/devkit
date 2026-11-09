import { describe, expect, it } from "vitest";
import { screenshotFileName } from "../../e2e/names";

describe("E2E のスクリーンショットのファイル名", () => {
  it("ファイル名・describe・テスト名をつなぎ、同じテスト名でも describe が違えば重ならない", () => {
    const a = screenshotFileName(["todos.spec.ts", "一般の利用者", "[AC-1] 登録できる"]);
    const b = screenshotFileName(["todos.spec.ts", "管理者", "[AC-1] 登録できる"]);
    expect(a).toBe("todos.spec.ts_-_一般の利用者_-_[AC-1]_登録できる.png");
    expect(a).not.toBe(b);
  });

  it("ファイル名に使えない文字と制御文字を _ にする", () => {
    expect(screenshotFileName(["a/b.spec.ts", 'x:y*z?"<>|\t\n'])).toBe("a_b.spec.ts_-_x_y_z.png");
  });

  it("長すぎる名前は切り詰め、ハッシュを付けて重ならないようにする", () => {
    const long = "あ".repeat(200);
    const a = screenshotFileName(["spec.ts", `${long}1`]);
    const b = screenshotFileName(["spec.ts", `${long}2`]);
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(200);
    expect(a).not.toBe(b);
  });
});
