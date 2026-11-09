// `node --test tests/standard/` の入口。Node.js 22 の node --test はディレクトリを受け取ると
// そのディレクトリをモジュールとして読み込む（index.js）ので、ここで同じディレクトリの *.test.mjs をすべて読み込む。
// `node --test tests/standard/*.test.mjs` でも同じテストが動く。
// CommonJS でも ES モジュールでも動くように、require・__dirname・import.meta を使わない。
(async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const target = path.resolve(process.argv[1]);
  const dir = statSync(target).isDirectory() ? target : path.dirname(target);
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()) {
    await import(pathToFileURL(path.join(dir, name)).href);
  }
})();
