import { createHash } from "node:crypto";

// スクリーンショットのファイル名。describe の階層を含むテスト名（titlePath）を " - " でつなぎ、
// ファイル名に使えない文字・制御文字・空白を _ にする。長すぎる名前は切り詰め、重ならないように元の名前のハッシュを付ける。
// （Playwright を読み込まないので、Vitest からも確かめられる）
const MAX_BYTES = 180;

export function screenshotFileName(titlePath: readonly string[]): string {
  const full = titlePath.filter(Boolean).join(" - ");
  let name = full
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字をファイル名から除くため
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\s]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");
  if (!name) name = "untitled";
  if (Buffer.byteLength(name) > MAX_BYTES) {
    const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
    let cut = name;
    while (Buffer.byteLength(cut) > MAX_BYTES - 9) cut = cut.slice(0, -1);
    name = `${cut}-${hash}`;
  }
  return `${name}.png`;
}
