import { headers } from "next/headers";
import { REQUEST_ID_HEADER } from "@/lib/security-headers";

// リクエスト ID（src/proxy.ts が作る）。ログと監査ログに残す。
export async function getRequestId(): Promise<string | undefined> {
  return (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
}
