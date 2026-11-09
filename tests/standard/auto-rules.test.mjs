// 自動検査のルールごとに、違反する案件で違反が出ること（と、出てはいけない書き方で出ないこと）
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PACKAGE_JSON, PROFILE, gitInit, makeProject, releaseReady, remove, run, templateFiles } from "./fixture.mjs";

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** テンプレートを mutate で書き換えた案件で検査する */
function checkWith(mutate, args = [], { git = false, base = templateFiles } = {}) {
  const files = base();
  mutate(files);
  const dir = makeProject(files);
  try {
    if (git) gitInit(dir);
    return run(dir, args);
  } finally {
    remove(dir);
  }
}

function pkgWith(files, fn) {
  const pkg = clone(PACKAGE_JSON);
  fn(pkg);
  files["package.json"] = json(pkg);
}

/** 指定のルールの違反があり、ほかのルールの違反はない */
function expectOnly(r, rule, pattern) {
  assert.equal(r.code, 1, `違反が出ていない: ${JSON.stringify(r.result?.warnings)}`);
  const other = r.result.violations.filter((v) => v.rule !== rule);
  assert.deepEqual(other, [], `${rule} 以外の違反が出た`);
  const mine = r.result.violations.filter((v) => v.rule === rule);
  assert.ok(mine.length > 0);
  if (pattern) assert.ok(mine.some((v) => pattern.test(`${v.file ?? ""} ${v.message}`)), JSON.stringify(mine, null, 2));
  return mine;
}

const expectClean = (r) => assert.equal(r.code, 0, JSON.stringify(r.result?.violations, null, 2));

describe("TECH-01 許可リスト", () => {
  test("許可リストにない依存は違反（ESC-01 も検査済みになる）", () => {
    const r = checkWith((f) => pkgWith(f, (p) => (p.dependencies.lodash = "4.17.21")));
    const [v] = expectOnly(r, "TECH-01", /lodash/);
    assert.equal(v.file, "package.json");
    assert.ok(r.result.checked.includes("ESC-01"));
  });

  test("preApproved とパターン（@radix-ui/react-*）は可。パターンに合わない名前は違反", () => {
    expectClean(
      checkWith((f) =>
        pkgWith(f, (p) => {
          p.dependencies["better-auth"] = "1.4.2";
          p.dependencies["@radix-ui/react-dialog"] = "1.1.15";
          p.dependencies["date-fns"] = "4.1.0";
        }),
      ),
    );
    expectOnly(
      checkWith((f) => pkgWith(f, (p) => (p.dependencies["@radix-ui/number"] = "1.1.1"))),
      "TECH-01",
      /@radix-ui\/number/,
    );
  });
});

describe("TECH-02 完全固定", () => {
  test("^ の範囲は違反", () => {
    expectOnly(checkWith((f) => pkgWith(f, (p) => (p.dependencies.zod = "^4.6.7"))), "TECH-02", /zod/);
  });
  test("pnpm.overrides・overrides・resolutions も完全固定にする", () => {
    const r = checkWith((f) =>
      pkgWith(f, (p) => {
        p.pnpm.overrides = { esbuild: "~0.25.0" };
        p.overrides = { semver: { ".": "7.6.3", lru: ">=1" } };
        p.resolutions = { glob: "latest" };
      }),
    );
    const mine = expectOnly(r, "TECH-02");
    assert.equal(mine.length, 3);
  });
  test("git・URL・ファイル・npm: の別名は違反", () => {
    const r = checkWith((f) =>
      pkgWith(f, (p) => {
        p.dependencies.zod = "github:colinhacks/zod";
        p.dependencies.clsx = "https://example.com/clsx.tgz";
        p.dependencies.react = "file:../react";
        p.dependencies["react-dom"] = "npm:react-dom@19.3.1";
      }),
    );
    const mine = expectOnly(r, "TECH-02");
    const text = mine.map((v) => v.message).join("\n");
    for (const w of ["git の指定", "URL の指定", "ファイルの指定", "別名（npm:）"]) assert.ok(text.includes(w), w);
  });
  test("pnpm-lock.yaml がない・ほかのロックファイルがある・packageManager がないのは違反", () => {
    const r = checkWith((f) => {
      f["pnpm-lock.yaml"] = null;
      f["package-lock.json"] = "{}\n";
      pkgWith(f, (p) => delete p.packageManager);
    });
    const mine = expectOnly(r, "TECH-02");
    assert.equal(mine.length, 3);
  });
});

describe("TECH-03 Node.js", () => {
  test(".nvmrc の版が標準と違えば違反", () => {
    expectOnly(checkWith((f) => (f[".nvmrc"] = "22\n")), "TECH-03", /\.nvmrc/);
  });
  test(".nvmrc がなければ .node-version を読む", () => {
    expectClean(
      checkWith((f) => {
        f[".nvmrc"] = null;
        f[".node-version"] = "v24.11.0\n";
      }),
    );
  });
  test("Dockerfile の node イメージの版も合わせる", () => {
    expectOnly(checkWith((f) => (f.Dockerfile = f.Dockerfile.replace("FROM node:24-alpine AS runner", "FROM node:22-alpine AS runner"))), "TECH-03", /Dockerfile/);
  });
});

describe("ARCH-02 DB アクセス", () => {
  test("画面で drizzle-orm を import し、db を直接操作すると違反", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/todos/page.tsx"] = f["src/app/(app)/todos/page.tsx"]
        .replace('import { getDb } from "@/db/client";', 'import { getDb } from "@/db/client";\nimport { desc } from "drizzle-orm";')
        .replace("const todos = await listTodos(await getDb());", "const conn = await getDb();\n  const todos = await conn.query.todos.findMany({ orderBy: desc });");
    });
    const mine = expectOnly(r, "ARCH-02");
    assert.ok(mine.some((v) => /drizzle-orm/.test(v.message)));
    assert.ok(mine.some((v) => /\.query/.test(v.message)));
  });
  test("スキーマを相対パスで import しても違反。型だけの import は可", () => {
    expectOnly(
      checkWith((f) => {
        f["src/components/todo-list.tsx"] = 'import { todos } from "../db/schema";\nexport const t = todos;\n';
      }),
      "ARCH-02",
      /\.\.\/db\/schema/,
    );
    expectClean(
      checkWith((f) => {
        f["src/components/todo-list.tsx"] = 'import type { Todo } from "@/db/schema";\nexport function TodoList({ items }: { items: Todo[] }) {\n  return <ul>{items.length}</ul>;\n}\n';
      }),
    );
  });
});

describe("ARCH-03 defineAction", () => {
  test('"use server" ファイルで関数を export すると違反', () => {
    expectOnly(
      checkWith((f) => {
        f["src/app/(app)/todos/actions.ts"] += "\nexport async function deleteAll() {\n  return 1;\n}\n";
      }),
      "ARCH-03",
      /deleteAll/,
    );
  });
  test("関数の中の \"use server\" と export { } は違反", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/todos/page.tsx"] = f["src/app/(app)/todos/page.tsx"].replace(
        "  return (\n    <main",
        '  async function inline() {\n    "use server";\n  }\n  void inline;\n  return (\n    <main',
      );
      f["src/app/(app)/todos/actions.ts"] += "\nconst x = createTodoAction;\nexport { x };\n";
    });
    const mine = expectOnly(r, "ARCH-03");
    assert.ok(mine.some((v) => /インライン/.test(v.message)));
    assert.ok(mine.some((v) => /export/.test(v.message)));
  });
  test("defineAction を @/server/action 以外から import すると違反", () => {
    expectOnly(
      checkWith((f) => {
        f["src/app/(app)/todos/actions.ts"] = f["src/app/(app)/todos/actions.ts"].replace('from "@/server/action"', 'from "@/lib/my-action"');
      }),
      "ARCH-03",
      /@\/server\/action/,
    );
  });
});

describe("ARCH-04 クライアントコンポーネント", () => {
  test('components/ の外の "use client" は違反', () => {
    expectOnly(
      checkWith((f) => {
        f["src/app/(app)/todos/todo-client.tsx"] = '"use client";\nexport function A() {\n  return null;\n}\n';
      }),
      "ARCH-04",
      /todo-client/,
    );
  });
  test("クライアントコンポーネントから @/server を import すると違反（型だけは可）", () => {
    expectOnly(
      checkWith((f) => {
        f["src/app/(app)/todos/components/todo-form.tsx"] = f["src/app/(app)/todos/components/todo-form.tsx"].replace(
          'import { createTodoAction } from "../actions";',
          'import { createTodoAction } from "../actions";\nimport { CreateTodoInput } from "@/server/todos";\nvoid CreateTodoInput;',
        );
      }),
      "ARCH-04",
      /@\/server\/todos/,
    );
  });
});

describe("ARCH-05 環境変数", () => {
  test("src/lib/env.ts 以外の process.env は違反（文字列とコメントの中は除く）", () => {
    const r = checkWith((f) => {
      f["src/server/todos.ts"] += '\n// process.env はここで読まない\nexport const note = "process.env を読まない";\nexport const port = process.env.PORT;\nexport const { env } = process;\n';
    });
    const mine = expectOnly(r, "ARCH-05");
    assert.equal(mine.length, 2);
  });
});

describe("SEC-01・SEC-02・SEC-07 defineAction の引数", () => {
  const replaceAction = (f, from, to) => {
    f["src/app/(app)/todos/actions.ts"] = f["src/app/(app)/todos/actions.ts"].replace(from, to);
  };
  test("permission がない・権限表にない・スプレッド・変数を渡すのは SEC-01 の違反", () => {
    const r = checkWith((f) => {
      replaceAction(f, 'permission: "todos.create",', 'permission: "todos.delete",');
      replaceAction(f, 'permission: "todos.complete",', "...base,");
      f["src/app/(app)/todos/actions.ts"] += "\nconst base = {};\nconst def = base as never;\nexport const third = defineAction(def);\n";
    });
    const mine = r.result.violations.filter((v) => v.rule === "SEC-01").map((v) => v.message).join("\n");
    assert.match(mine, /todos\.delete/);
    assert.match(mine, /スプレッド/);
    assert.match(mine, /permission/);
    assert.match(mine, /その場で書いたオブジェクト/);
  });
  test("input がない・z.any() は SEC-02 の違反", () => {
    const r = checkWith((f) => {
      replaceAction(f, "  input: CreateTodoInput,\n", "");
      replaceAction(f, "input: z.object({ id: z.coerce.number().int().positive() }),", "input: z.any(),");
    });
    const mine = expectOnly(r, "SEC-02");
    assert.equal(mine.length, 2);
  });
  test("audit がない・値が式なら SEC-07 の違反", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/todos/actions.ts"] = f["src/app/(app)/todos/actions.ts"].replace("  audit: true,\n", "").replace("audit: true,", "audit: Boolean(1),");
    });
    const mine = expectOnly(r, "SEC-07");
    assert.equal(mine.length, 2);
  });
  test("権限表がなければ違反", () => {
    expectOnly(checkWith((f) => (f["src/server/auth/permissions.ts"] = "export const ROLES = [];\n")), "SEC-01", /権限表/);
  });
});

describe("SEC-03 HTML の差し込み", () => {
  test("dangerouslySetInnerHTML と innerHTML への代入は違反", () => {
    const r = checkWith((f) => {
      f["src/components/raw.tsx"] = 'export function Raw({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\nexport function set(el: HTMLElement, s: string) {\n  el.innerHTML = s;\n}\n';
    });
    const mine = expectOnly(r, "SEC-03");
    assert.equal(mine.length, 2);
  });
});

describe("SEC-04 文字列の SQL", () => {
  test("sql.raw と .execute(\"…\") は違反。sql`…` のタグ付きテンプレートは可", () => {
    const r = checkWith((f) => {
      f["src/server/report.ts"] =
        'import { sql as q } from "drizzle-orm";\nimport type { Db } from "@/db/client";\n\nexport async function report(db: Db, col: string) {\n  await db.execute(q`select 1`);\n  await db.execute(q.raw(`select ${col} from todos`));\n  await db.execute("delete from todos");\n}\n';
    });
    const mine = expectOnly(r, "SEC-04");
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((v) => v.line).sort(), [6, 7]);
  });
});

describe("SEC-05 秘密情報", () => {
  // 本物と同じ形の値をソースに書かないように、実行時に組み立てる
  const aws = ["AKIA", "Z7QK2M4XN8B3P5WD"].join("");
  const slack = ["https://hooks.slack", ".com/services/", "T0123ABCD/B0456EFGH/", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("");
  const google = ["AIza", "SyD3k9Qm2Lx7Rt5Vw8Yz1Ab4Cd6Ef0Gh2Ij"].join("");
  const entra = ["abc", "8Q~", "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3x"].join("");
  const remoteDb = ["postgres://app:", "S3cretPass", "@db.prod.internal:5432/app"].join("");

  for (const [name, value] of [
    ["AWS のアクセスキー", aws],
    ["Slack の Webhook URL", slack],
    ["Google の API キー", google],
    ["Microsoft Entra ID のクライアントシークレット", entra],
    ["パスワード付きの接続文字列", remoteDb],
  ]) {
    test(`${name}は違反`, () => {
      const r = checkWith((f) => {
        f["src/server/external/notify.ts"] = `export const target = "${value}";\n`;
      });
      expectOnly(r, "SEC-05", /notify\.ts/);
    });
  }

  test("src の外の設定ファイルも検査する（git の追跡中のファイル）", () => {
    const r = checkWith((f) => (f["deploy/app.env"] = `SLACK_URL=${slack}\n`), [], { git: true });
    expectOnly(r, "SEC-05", /deploy\/app\.env/);
  });

  test("localhost の開発用の接続文字列・ロックファイル・バイナリ・プレースホルダは対象外", () => {
    expectClean(
      checkWith((f) => {
        f["pnpm-lock.yaml"] += `# ${aws}\n`;
        f["public/logo.png"] = `\u0000PNG ${aws}`;
        f["docs/deploy.md"] = "DATABASE_URL=postgres://<user>:<password>@<host>/app\nDATABASE_URL=postgres://app:${DB_PASSWORD}@db.prod/app\n";
        f["src/server/dev.ts"] = 'export const url = "postgresql://app:app@127.0.0.1:5432/app";\nexport const message = "パスワードは8文字以上";\n';
      }),
    );
  });

  test("src のコードで password などに値を直書きすると違反", () => {
    expectOnly(checkWith((f) => (f["src/server/smtp.ts"] = 'export const smtp = { user: "app", password: "Pa55w0rd!x" };\n')), "SEC-05", /password/);
  });
});

describe("SEC-06 セキュリティヘッダ", () => {
  test("CSP に object-src 'none' がなければ違反", () => {
    expectOnly(checkWith((f) => (f["next.config.ts"] = f["next.config.ts"].replace(`  "object-src 'none'",\n`, ""))), "SEC-06", /object-src/);
  });
  test("ヘッダの名前がコメントにしかなければ違反（headers() の定義の中だけを見る）", () => {
    const r = checkWith((f) => {
      f["next.config.ts"] = f["next.config.ts"].replace(
        '  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },\n',
        '  // { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },\n',
      );
      f["next.config.ts"] += '\nexport const unused = "Strict-Transport-Security";\n';
    });
    expectOnly(r, "SEC-06", /Strict-Transport-Security/);
  });
  test("headers() がなければ違反", () => {
    expectOnly(
      checkWith((f) => (f["next.config.ts"] = 'import type { NextConfig } from "next";\n// headers() は後で\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n')),
      "SEC-06",
      /headers\(\)/,
    );
  });
  test("CSP を import した関数で組み立ててよい（関数の中身を確かめる）", () => {
    const files = (cspBody) => (f) => {
      f["src/lib/security-headers.ts"] = `export function contentSecurityPolicy(opts: { dev?: boolean } = {}): string {\n  return [${cspBody}].join("; ");\n}\n`;
      f["next.config.ts"] = f["next.config.ts"]
        .replace('import type { NextConfig } from "next";', 'import type { NextConfig } from "next";\nimport { contentSecurityPolicy } from "./src/lib/security-headers";')
        .replace('{ key: "Content-Security-Policy", value: csp }', '{ key: "Content-Security-Policy", value: contentSecurityPolicy({ dev: isDev }) }');
    };
    expectClean(checkWith(files(`"default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"`)));
    expectOnly(checkWith(files(`"default-src 'self'", "object-src 'none'", "frame-ancestors 'none'"`)), "SEC-06", /base-uri/);
  });
});

describe("SEC-11 入口のガード", () => {
  test("ガードのない画面は違反", () => {
    expectOnly(
      checkWith((f) => (f["src/app/(app)/reports/page.tsx"] = "export default async function Reports() {\n  return <p>a</p>;\n}\n")),
      "SEC-11",
      /reports\/page\.tsx/,
    );
  });
  test("ガードが最初の文でなければ違反", () => {
    expectOnly(
      checkWith((f) => {
        f["src/app/(app)/todos/page.tsx"] = f["src/app/(app)/todos/page.tsx"]
          .replace('  const access = await requirePermission("todos.read");\n', "  const ready = true;\n  const access = await requirePermission(\"todos.read\");\n  void ready;\n");
      }),
      "SEC-11",
      /最初の文/,
    );
  });
  test("API はメソッドごとに確かめる。allowAnonymous には理由が要る", () => {
    const r = checkWith((f) => {
      f["src/app/api/todos/route.ts"] =
        'import { allowAnonymous, requireUser } from "@/server/auth/guard";\n\nexport async function GET() {\n  const access = await requireUser();\n  return Response.json(access);\n}\n\nexport const POST = async (req: Request) => {\n  return Response.json(await req.json());\n};\n\nexport function DELETE() {\n  allowAnonymous("");\n  return new Response(null);\n}\n';
    });
    const mine = expectOnly(r, "SEC-11");
    assert.equal(mine.length, 3);
    assert.ok(mine.some((v) => /^GET: requireUser の結果をすぐ次の文で確かめる/.test(v.message)));
    assert.ok(mine.some((v) => /^POST/.test(v.message)));
    assert.ok(mine.some((v) => /理由/.test(v.message)));
  });
  test("ガードのモジュールがなければ違反", () => {
    expectOnly(checkWith((f) => (f["src/server/auth/guard.ts"] = null)), "SEC-11");
  });
});

describe("OPS-01 案件プロファイル", () => {
  test("tier・externalHosts の書き方が違えば違反", () => {
    const r = checkWith((f) => (f["docs/profile.json"] = json({ ...PROFILE, tier: "gold", externalHosts: ["https://api.example.co.jp/v1"] })));
    const mine = expectOnly(r, "OPS-01");
    assert.equal(mine.length, 2);
  });
  test("profile がなければ違反", () => {
    expectOnly(checkWith((f) => (f["docs/profile.json"] = null)), "OPS-01", /profile\.json/);
  });
});

describe("OPS-02 ヘルスチェック", () => {
  test("GET /api/health がなければ違反", () => {
    expectOnly(checkWith((f) => (f["src/app/api/health/route.ts"] = null)), "OPS-02");
  });
});

describe("OPS-03 起動時のマイグレーション", () => {
  test("アプリのコードで node-postgres の migrator を使うと違反（PGlite 用は可）", () => {
    expectOnly(
      checkWith((f) => (f["src/server/startup.ts"] = 'export async function register() {\n  const { migrate } = await import("drizzle-orm/node-postgres/migrator");\n  void migrate;\n}\n')),
      "OPS-03",
      /startup/,
    );
  });
  test("Dockerfile の CMD・compose の command・package.json の start で適用すると違反", () => {
    const r = checkWith(
      (f) => {
        f.Dockerfile = f.Dockerfile.replace('CMD ["node", "server.js"]', 'CMD ["sh", "-c", "pnpm db:migrate && node server.js"]');
        f["compose.yaml"] += "  app:\n    build: .\n    command:\n      - sh\n      - -c\n      - drizzle-kit migrate && node server.js\n";
        pkgWith(f, (p) => (p.scripts.start = "drizzle-kit migrate && next start"));
      },
      [],
      { git: true },
    );
    const mine = expectOnly(r, "OPS-03");
    assert.deepEqual([...new Set(mine.map((v) => v.file))].sort(), ["Dockerfile", "compose.yaml", "package.json"]);
  });
  test("Dockerfile のコメントは対象外", () => {
    expectClean(checkWith((f) => (f.Dockerfile = `# CMD pnpm db:migrate はしない\n${f.Dockerfile}`)));
  });
});

describe("OPS-04 リリース後のマイグレーション", () => {
  const released = (f) => (f["docs/profile.json"] = json({ ...PROFILE, released: true, releasedMigration: "0000_init" }));
  test("リリース後のマイグレーションの破壊的な変更は違反", () => {
    const r = checkWith((f) => {
      released(f);
      f["drizzle/0001_cleanup.sql"] = 'ALTER TABLE "todos" DROP COLUMN "done";\n--> statement-breakpoint\nDELETE FROM "audit_logs";\n-- DROP TABLE "x" はコメント\nINSERT INTO "todos" ("title") VALUES (\'DROP TABLE todos\');\n';
    });
    const mine = expectOnly(r, "OPS-04");
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((v) => v.line).sort(), [1, 3]);
  });
  test("追加だけのマイグレーションは可。releasedMigration がなければ違反", () => {
    expectClean(
      checkWith((f) => {
        released(f);
        f["drizzle/0001_add.sql"] = 'ALTER TABLE "todos" ADD COLUMN "note" text;\n';
      }),
    );
    expectOnly(checkWith((f) => (f["docs/profile.json"] = json({ ...PROFILE, released: true }))), "OPS-04", /releasedMigration/);
  });
});

describe("SEC-09 本番の認証（--release）", () => {
  const release = (mutate) => checkWith(mutate, ["--release"], { git: true, base: () => releaseReady(templateFiles()) });
  test("Dockerfile と compose の開発用の認証は違反。CI とコメントは対象外", () => {
    const r = release((f) => {
      f.Dockerfile = f.Dockerfile.replace("ENV NODE_ENV=production", "# DEVKIT_E2E_AUTH は付けない\nENV NODE_ENV=production\nENV AUTH_MODE=dev");
      f["compose.yaml"] += "  app:\n    environment:\n      DEVKIT_E2E_AUTH: \"1\"\n";
    });
    const mine = expectOnly(r, "SEC-09");
    assert.deepEqual(mine.map((v) => v.file).sort(), ["Dockerfile", "compose.yaml"]);
  });
  test("本番のビルドのスクリプトに DEVKIT_E2E_AUTH があれば違反（E2E 用のスクリプトは可）", () => {
    const r = release((f) => {
      const pkg = JSON.parse(f["package.json"]);
      pkg.scripts.build = "DEVKIT_E2E_AUTH=1 next build";
      f["package.json"] = json(pkg);
    });
    expectOnly(r, "SEC-09", /build/);
  });
  test("k8s の env の書き方（name と value が別の行）も検出する", () => {
    expectOnly(release((f) => (f["k8s/deployment.yaml"] = "env:\n  - name: AUTH_MODE\n    value: dev\n")), "SEC-09", /k8s/);
  });
  test("better-auth なのに session.ts が Better Auth を使っていなければ違反", () => {
    expectOnly(release((f) => (f["src/server/auth/auth.ts"] = "export const auth = { api: { getSession: async () => null } };\n")), "SEC-09", /session\.ts/);
  });
  test("auth: none は例外承認が必要", () => {
    const r = release((f) => {
      f["docs/profile.json"] = json({ ...JSON.parse(f["docs/profile.json"]), auth: "none" });
    });
    expectOnly(r, "SEC-09", /auth:none/);
  });
});

describe("OPS-05 運用手順書（--release）", () => {
  test("未記入の節があれば違反", () => {
    const r = checkWith((f) => (f["docs/runbook.md"] = f["docs/runbook.md"].replace("## 4. バックアップと復元\n\n手順を書いた。", "## 4. バックアップと復元\n\n（記入）")), ["--release"], {
      base: () => releaseReady(templateFiles()),
    });
    expectOnly(r, "OPS-05", /バックアップと復元/);
  });
});
