/*
 * 테스트 파일 하나만 번들해 실행한다: `npm run test:one -- tests/engine.golden.test.ts`
 *
 * esbuild.test.mjs 는 전부를 한 번에 돌린다. 한 파일을 고치는 동안 매번 전체를 기다리지
 * 않으려고 둔다. 번들 설정(obsidian → 스텁 alias)은 esbuild.test.mjs 와 같아야 한다.
 */
import esbuild from "esbuild";
import { spawnSync } from "child_process";
import path from "path";

const entry = process.argv[2];
if (!entry) {
  console.error("사용법: npm run test:one -- tests/<파일>.test.ts");
  process.exit(2);
}
const out = path.join(".test-build-one", path.basename(entry).replace(/\.ts$/, ".js"));
await esbuild.build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: "inline",
  logLevel: "warning",
  alias: { obsidian: path.resolve("tests/obsidian-stub.ts") },
});
const r = spawnSync(process.execPath, ["--enable-source-maps", out], { stdio: "inherit" });
process.exit(r.status ?? 1);
