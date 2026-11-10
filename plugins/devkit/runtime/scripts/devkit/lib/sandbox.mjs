import { spawnSync } from "node:child_process";

// Claude Code のサンドボックスが使えるか（aiSandbox: required のとき）
export function sandboxProblem(config) {
  if (config.aiSandbox !== "required") return null;
  if (process.platform === "win32") return "Windows ネイティブでは Claude Code のサンドボックスを使えません。WSL2 で動かすか、.devkit/config.json の aiSandbox を off にしてください";
  if (process.platform === "linux") {
    for (const bin of ["bwrap", "socat"]) {
      if (spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status !== 0)
        return `${bin} がありません（sudo apt-get install bubblewrap socat）。入れられない場合は .devkit/config.json の aiSandbox を off にしてください（AI のコマンドが作業ディレクトリの外にも書けるようになります）`;
    }
  }
  return null;
}
