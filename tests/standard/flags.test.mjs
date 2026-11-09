// 変更の検出（--base）: 人間ゲートに回すフラグと、差分が取れないときに安全側に倒すこと
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { PROFILE, commitAll, git, gitInit, makeProject, read, remove, run, templateFiles, write } from "./fixture.mjs";

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * テンプレートを（setup で書き換えて）コミットし、change で変更してから --base で検査する。
 * commit: true なら変更をコミットして --head で比べる
 */
function diffCheck(change, { setup, commit = false, args = [] } = {}) {
  const files = templateFiles();
  if (setup) setup(files);
  const dir = makeProject(files);
  try {
    const base = gitInit(dir);
    change(dir);
    const extra = commit ? ["--head", commitAll(dir, "change")] : [];
    return run(dir, ["--base", base, ...extra, ...args]);
  } finally {
    remove(dir);
  }
}

const flagsOf = (r, rule) => r.result.flags.filter((f) => f.rule === rule);
const items = (r, rule) => flagsOf(r, rule).flatMap((f) => f.items);

function addColumn(dir, line) {
  const schema = read(dir, "src/db/schema.ts").replace('  title: text("title").notNull(),\n', `  title: text("title").notNull(),\n${line}\n`);
  write(dir, "src/db/schema.ts", schema);
}

describe("SEC-08 個人情報らしき項目", () => {
  test("borrower_name（人 + 名前）はテーブル名に関係なく検出する", () => {
    const r = diffCheck((dir) => {
      write(
        dir,
        "src/db/schema.ts",
        `${read(dir, "src/db/schema.ts")}\nexport const loans = pgTable("loans", {\n  id: serial("id").primaryKey(),\n  borrowerName: text("borrower_name").notNull(),\n  itemName: text("item_name").notNull(),\n});\n`,
      );
    });
    assert.equal(r.code, 0);
    const found = items(r, "SEC-08");
    assert.ok(found.some((i) => i.startsWith("loans.borrower_name")), JSON.stringify(found));
    assert.ok(!found.some((i) => i.startsWith("loans.item_name")));
    assert.equal(flagsOf(r, "SEC-08")[0].role, "technical");
  });

  test("マイグレーション SQL の employee_no・staff_code とローマ字（shimei）も検出する", () => {
    const r = diffCheck((dir) => {
      write(
        dir,
        "drizzle/0001_staff.sql",
        'CREATE TABLE "assignments" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"employee_no" text NOT NULL,\n\t"staff_code" varchar(10),\n\t"shimei" text,\n\t"product_name" text\n);\n',
      );
    });
    const found = items(r, "SEC-08").join("\n");
    for (const c of ["assignments.employee_no", "assignments.staff_code", "assignments.shimei"]) assert.ok(found.includes(c), c);
    assert.ok(!found.includes("product_name"));
  });

  test("外部キーの user_id は対象外。文字列の employee_id は対象", () => {
    const fk = diffCheck((dir) => addColumn(dir, '  userId: integer("user_id").references(() => users.id),'));
    assert.deepEqual(items(fk, "SEC-08"), []);
    const text = diffCheck((dir) => addColumn(dir, '  employeeId: text("employee_id"),'));
    assert.ok(items(text, "SEC-08").some((i) => i.startsWith("todos.employee_id")));
  });

  test("個人情報でない列だけなら出ない（DATA は出る）", () => {
    const r = diffCheck((dir) => addColumn(dir, '  dueDate: timestamp("due_date"),'));
    assert.deepEqual(flagsOf(r, "SEC-08"), []);
    assert.deepEqual(items(r, "DATA"), ["src/db/schema.ts"]);
    assert.equal(flagsOf(r, "DATA")[0].role, "technical");
  });
});

describe("ESC-02 外部接続", () => {
  test("src/server/external/ の外での @aws-sdk の import はフラグ", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/server/files.ts", 'import { S3Client } from "@aws-sdk/client-s3";\n\nexport const s3 = new S3Client({});\n');
    });
    const found = items(r, "ESC-02");
    assert.ok(found.some((i) => i.includes("src/server/files.ts") && i.includes("@aws-sdk/client-s3")), JSON.stringify(found));
  });

  test("src/server/external/ の中なら import のフラグは出ず、外部連携の変更として出る", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/server/external/s3.ts", 'import { S3Client } from "@aws-sdk/client-s3";\n\nexport const s3 = new S3Client({});\n');
    });
    const flags = flagsOf(r, "ESC-02");
    assert.equal(flags.length, 1);
    assert.deepEqual(flags[0].items, ["src/server/external/s3.ts"]);
  });

  test("src/db/client.ts の pg は対象外（SEC-12 で確かめる）", () => {
    const r = diffCheck((dir) => write(dir, "src/db/client.ts", `${read(dir, "src/db/client.ts")}\nexport const loadPg = () => import("pg");\n`));
    assert.deepEqual(flagsOf(r, "ESC-02"), []);
    assert.deepEqual(items(r, "SEC-12"), ["src/db/client.ts"]);
  });

  test("externalHosts にないホストはフラグ。登録済み（ワイルドカードを含む）・example・localhost は出ない", () => {
    const setup = (f) => (f["docs/profile.json"] = json({ ...PROFILE, externalHosts: ["api.partner.co.jp", "*.cdn.partner.co.jp"] }));
    const ok = diffCheck(
      (dir) =>
        write(
          dir,
          "src/lib/links.ts",
          'export const API = "https://api.partner.co.jp/v1";\nexport const IMG = "https://img.cdn.partner.co.jp/a.png";\nexport const DOC = "https://www.example.com/";\nexport const DEV = "http://localhost:3000";\n',
        ),
      { setup },
    );
    assert.deepEqual(flagsOf(ok, "ESC-02"), []);
    const ng = diffCheck((dir) => write(dir, "src/lib/links.ts", 'export const API = "https://api.other.co.jp/v1";\n// https://commented.example.net/\n'), { setup });
    assert.deepEqual(items(ng, "ESC-02"), ["api.other.co.jp（src/lib/links.ts:1）"]);
  });

  test("src の外の設定ファイル（compose）の接続先と、未追跡のファイルも見る", () => {
    const r = diffCheck((dir) => {
      write(dir, "compose.yaml", `${read(dir, "compose.yaml")}  mail:\n    image: mailhog\n    environment:\n      SMTP_URL: smtp://smtp.corp.co.jp:25\n`);
      write(dir, "src/lib/new file.ts", 'export const hook = "https://events.vendor.io/hook";\n');
    });
    const found = items(r, "ESC-02").join("\n");
    assert.match(found, /smtp\.corp\.co\.jp（compose\.yaml:\d+）/);
    assert.match(found, /events\.vendor\.io（src\/lib\/new file\.ts:1）/);
  });

  test("src/server/external/ の外の fetch はフラグ（同じオリジンへの相対パスは除く）", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/server/weather.ts", 'export async function w(url: string) {\n  await fetch("/api/health");\n  return fetch(url);\n}\n');
    });
    const found = items(r, "ESC-02");
    assert.deepEqual(found, ["src/server/weather.ts:3（fetch）"]);
  });

  test(".gitattributes の -diff や textconv でも、追加した URL を隠せない", () => {
    const r = diffCheck(
      (dir) => {
        git(dir, "config", "diff.hide.textconv", "sh -c 'true'");
        write(dir, "src/server/todos.ts", `${read(dir, "src/server/todos.ts")}\nexport const LEAK = "https://collector.evil.example.org.attacker.io/x";\n`);
        write(dir, "src/lib/utils.ts", `${read(dir, "src/lib/utils.ts")}\nexport const B = "https://second.attacker.io/y";\n`);
      },
      { setup: (f) => (f[".gitattributes"] = "*.ts -diff\nsrc/lib/*.ts diff=hide\n") },
    );
    const found = items(r, "ESC-02").join("\n");
    assert.match(found, /collector\.evil\.example\.org\.attacker\.io（src\/server\/todos\.ts:\d+）/);
    assert.match(found, /second\.attacker\.io（src\/lib\/utils\.ts:\d+）/);
  });

  test("承認済みの例外（host:）があれば、そのホストは出ない", () => {
    const r = diffCheck((dir) => write(dir, "src/lib/links.ts", 'export const API = "https://api.partner.co.jp/v1";\n'), {
      setup: (f) => {
        f["docs/adr/0004-partner.md"] = "# ADR-0004\n";
        f["docs/exceptions.json"] = json({
          exceptions: [
            {
              id: "EXC-001",
              rules: ["ESC-02"],
              subject: "host:api.partner.co.jp",
              reason: "取引先の API",
              adr: "docs/adr/0004-partner.md",
              approvedBy: "技術 花子",
              approvedAt: "2026-01-05",
              reviewBy: "2099-12-31",
            },
          ],
        });
      },
    });
    assert.deepEqual(flagsOf(r, "ESC-02"), []);
  });
});

describe("ESC-03・SEC-12・DATA", () => {
  test("権限表の変更は業務ゲート（ESC-03）。SEC-12 には入らない", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/server/auth/permissions.ts", read(dir, "src/server/auth/permissions.ts").replace('"todos.create": ["admin", "member"],', '"todos.create": ["admin", "member", "viewer"],'));
    });
    const flags = flagsOf(r, "ESC-03");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].role, "business");
    assert.deepEqual(flags[0].items, ["src/server/auth/permissions.ts"]);
    assert.deepEqual(flagsOf(r, "SEC-12"), []);
  });

  test("安全の仕組みの中心（env・auth・CI・標準・プロファイル）の変更と削除は SEC-12", () => {
    const r = diffCheck((dir) => {
      write(dir, "src/lib/env.ts", `${read(dir, "src/lib/env.ts")}\n`);
      rmSync(path.join(dir, "src", "server", "auth", "session.ts"));
      write(dir, ".github/workflows/ci.yml", `${read(dir, ".github/workflows/ci.yml")}\n`);
      write(dir, "docs/standard/dependencies.json", read(dir, "docs/standard/dependencies.json").replace('"zod": "入力検証",', '"zod": "入力検証",\n    "lodash": "便利",'));
      write(dir, "docs/profile.json", json({ ...PROFILE, externalHosts: ["evil.example.io"] }));
    });
    const found = items(r, "SEC-12");
    for (const f of [".github/workflows/ci.yml", "docs/profile.json", "docs/standard/dependencies.json", "src/lib/env.ts", "src/server/auth/session.ts"]) {
      assert.ok(found.includes(f), f);
    }
  });

  test("--head を指定するとコミット同士を比べる（作業ツリーの未追跡のファイルは含めない）", () => {
    const files = templateFiles();
    const dir = makeProject(files);
    try {
      const base = gitInit(dir);
      write(dir, "src/server/auth/permissions.ts", `${read(dir, "src/server/auth/permissions.ts")}\n`);
      const head = commitAll(dir, "permissions");
      write(dir, "src/lib/untracked.ts", 'export const U = "https://untracked.vendor.io/";\n');
      const r = run(dir, ["--base", base, "--head", head]);
      assert.equal(flagsOf(r, "ESC-03").length, 1);
      assert.deepEqual(flagsOf(r, "ESC-02"), []);
    } finally {
      remove(dir);
    }
  });

  test("--head のときは比べる先のコミットの内容で個人情報を判定する", () => {
    const r = diffCheck((dir) => addColumn(dir, '  ownerName: text("owner_name"),'), { commit: true });
    assert.ok(items(r, "SEC-08").some((i) => i.startsWith("todos.owner_name")));
  });
});

describe("OPS-04 リリース済みのマイグレーションの変更（--base）", () => {
  const setup = (f) => (f["docs/profile.json"] = json({ ...PROFILE, released: true, releasedMigration: "0000_init" }));
  test("リリース済みのファイルを変えると違反（終了コード 1）", () => {
    const r = diffCheck((dir) => write(dir, "drizzle/0000_init.sql", `${read(dir, "drizzle/0000_init.sql")}\nCREATE INDEX "x" ON "todos" ("title");\n`), { setup });
    assert.equal(r.code, 1);
    const v = r.result.violations.filter((x) => x.rule === "OPS-04");
    assert.equal(v.length, 1);
    assert.equal(v[0].file, "drizzle/0000_init.sql");
  });
  test("リリース済みのファイルを消しても違反。新しいマイグレーションの追加は可", () => {
    const deleted = diffCheck((dir) => rmSync(path.join(dir, "drizzle", "0000_init.sql")), { setup });
    assert.ok(deleted.result.violations.some((x) => x.rule === "OPS-04" && /削除/.test(x.message)));
    const added = diffCheck((dir) => write(dir, "drizzle/0001_note.sql", 'ALTER TABLE "todos" ADD COLUMN "note" text;\n'), { setup });
    assert.equal(added.code, 0, JSON.stringify(added.result.violations));
    assert.deepEqual(items(added, "DATA"), ["drizzle/0001_note.sql"]);
  });
});

describe("差分が取れないときは SEC-12 に倒す", () => {
  const cases = [
    ["--base の値がない（末尾）", (base) => ["--base"]],
    ["--base の値がない（次が別の引数）", () => ["--base", "--json"]],
    ["--base が空", () => ["--base", ""]],
    ["--base=（空）", () => ["--base="]],
    ["--base がコミットでない", () => ["--base", "0123456789abcdef0123456789abcdef01234567"]],
    ["--base がオプションの形", () => ["--base", "-p"]],
    ["--head が見つからない", (base) => ["--base", base, "--head", "nope"]],
    ["--head だけ", (base) => ["--head", base]],
  ];
  for (const [name, args] of cases) {
    test(name, () => {
      const dir = makeProject();
      try {
        const base = gitInit(dir);
        const r = run(dir, args(base));
        assert.equal(r.code, 0, r.stderr);
        const f = flagsOf(r, "SEC-12");
        assert.equal(f.length, 1, JSON.stringify(r.result.flags));
        assert.equal(f[0].role, "technical");
        assert.match(f[0].message, /差分を正しく取得できませんでした/);
        assert.ok(r.result.checked.includes("SEC-12"));
      } finally {
        remove(dir);
      }
    });
  }

  test("git のリポジトリの外で --base", () => {
    const dir = makeProject();
    try {
      const r = run(dir, ["--base", "HEAD"]);
      assert.match(flagsOf(r, "SEC-12")[0]?.message ?? "", /git のリポジトリ/);
    } finally {
      remove(dir);
    }
  });
});
