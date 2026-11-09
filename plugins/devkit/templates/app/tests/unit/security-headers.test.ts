import { afterEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy } from "@/lib/security-headers";

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
}

describe("Content-Security-Policy", () => {
  it("既定は自分のオリジンだけを許し、埋め込み・object・base を禁止する", () => {
    const csp = contentSecurityPolicy();
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
  });

  it("画面では nonce 付きのスクリプトだけを実行し、'unsafe-inline' を使わない", () => {
    const csp = contentSecurityPolicy({ nonce: "abc123" });
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it("開発サーバーだけ 'unsafe-eval' を足す", () => {
    expect(directive(contentSecurityPolicy({ nonce: "n", dev: true }), "script-src")).toContain("'unsafe-eval'");
    expect(directive(contentSecurityPolicy({ nonce: "n" }), "script-src")).not.toContain("'unsafe-eval'");
  });
});

describe("next.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig() {
    vi.resetModules();
    return (await import("../../next.config")).default;
  }

  it('通常のビルドは .next に出力し、コードの DEVKIT_E2E_AUTH を "0" に置き換える', async () => {
    vi.stubEnv("DEVKIT_E2E_AUTH", undefined);
    const config = await loadConfig();
    expect(config.distDir).toBe(".next");
    expect(config.env).toEqual({ DEVKIT_E2E_AUTH: "0", DEVKIT_E2E_AUTH_TOKEN: "" });
  });

  it("E2E 用のビルド（DEVKIT_E2E_AUTH=1）は .next-e2e に分けて出力する", async () => {
    vi.stubEnv("DEVKIT_E2E_AUTH", "1");
    vi.stubEnv("DEVKIT_E2E_AUTH_TOKEN", "t".repeat(64));
    const config = await loadConfig();
    expect(config.distDir).toBe(".next-e2e");
    expect(config.env).toEqual({ DEVKIT_E2E_AUTH: "1", DEVKIT_E2E_AUTH_TOKEN: "t".repeat(64) });
  });

  it("通常のビルドには、環境変数にトークンがあっても埋め込まない", async () => {
    vi.stubEnv("DEVKIT_E2E_AUTH", undefined);
    vi.stubEnv("DEVKIT_E2E_AUTH_TOKEN", "t".repeat(64));
    const config = await loadConfig();
    expect(config.env?.DEVKIT_E2E_AUTH_TOKEN).toBe("");
  });

  it("SERVER_ACTIONS_ALLOWED_ORIGINS（カンマ区切り）を Server Action の allowedOrigins にする", async () => {
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "app.example.co.jp, *.example.co.jp");
    const config = await loadConfig();
    expect(config.experimental?.serverActions?.allowedOrigins).toEqual(["app.example.co.jp", "*.example.co.jp"]);
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", undefined);
    expect((await loadConfig()).experimental?.serverActions).toBeUndefined();
  });

  it("すべての応答にセキュリティヘッダーを付ける", async () => {
    const config = await loadConfig();
    const rules = (await config.headers?.()) ?? [];
    const headers = Object.fromEntries(rules.flatMap((r) => r.headers.map((h) => [h.key, h.value])));
    expect(rules.map((r) => r.source)).toEqual(["/:path*"]);
    expect(headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "Content-Security-Policy": contentSecurityPolicy(),
    });
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
