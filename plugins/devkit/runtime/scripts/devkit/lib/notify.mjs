// 役割ごとの通知。送り先のコマンドは環境変数で決める（メッセージはコマンド文字列に埋め込まず、環境変数で渡す）。
//   DEVKIT_NOTIFY_BUSINESS_CMD  業務ゲート・業務の判断依頼
//   DEVKIT_NOTIFY_TECH_CMD      技術ゲート・技術の判断依頼・停止・完了・環境エラー
//   DEVKIT_NOTIFY_CMD           上の2つがないときの共通の送り先（ランナーの開始・終了・サイクルの要約も）
import { spawn } from "node:child_process";
import { ROLE_LABEL } from "../shared.mjs";

export function notifyTarget(role) {
  if (role === "business") return process.env.DEVKIT_NOTIFY_BUSINESS_CMD || process.env.DEVKIT_NOTIFY_CMD || null;
  if (role === "technical") return process.env.DEVKIT_NOTIFY_TECH_CMD || process.env.DEVKIT_NOTIFY_CMD || null;
  return process.env.DEVKIT_NOTIFY_CMD || null;
}

// 失敗しても本体は止めない。結果（送れた・送れなかった）を返す
// subject・file: 定時ブリーフィングのように長いものは、件名と本文のファイルも渡す（DEVKIT_SUBJECT・DEVKIT_MESSAGE_FILE）
export function notify({ role = null, message, project = "", subject = "", file = "", target = undefined, onResult = () => {} }) {
  const cmd = target === undefined ? notifyTarget(role) : target;
  if (!cmd) return Promise.resolve({ sent: false, reason: "送り先が設定されていない" });
  const text = `${role ? `[${ROLE_LABEL[role]}の判断] ` : ""}${project ? `${project}: ` : ""}${message}`;
  return new Promise((resolvePromise) => {
    let done = false;
    const end = (r) => {
      if (done) return;
      done = true;
      onResult(r);
      resolvePromise(r);
    };
    try {
      const child = spawn(cmd, {
        shell: true,
        stdio: "ignore",
        env: { ...process.env, DEVKIT_MESSAGE: text, DEVKIT_ROLE_TARGET: role ?? "", DEVKIT_SUBJECT: subject, DEVKIT_MESSAGE_FILE: file },
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        end({ sent: false, reason: "通知コマンドが10秒で終わらなかった" });
      }, 10_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        end({ sent: false, reason: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        end(code === 0 ? { sent: true } : { sent: false, reason: `通知コマンドが exit ${code}` });
      });
    } catch (e) {
      end({ sent: false, reason: e.message });
    }
  });
}

// 定時ブリーフィングの送り先（common なら共通。なければ技術・業務の順）
export function briefingTarget(to = "common") {
  if (to === "business") return process.env.DEVKIT_NOTIFY_BUSINESS_CMD || process.env.DEVKIT_NOTIFY_CMD || null;
  if (to === "technical") return process.env.DEVKIT_NOTIFY_TECH_CMD || process.env.DEVKIT_NOTIFY_CMD || null;
  return process.env.DEVKIT_NOTIFY_CMD || process.env.DEVKIT_NOTIFY_TECH_CMD || process.env.DEVKIT_NOTIFY_BUSINESS_CMD || null;
}
