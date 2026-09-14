/*
 * 테스트 번들러. tests/*.test.ts 를 .test-build/ 로 번들해 node로 실행할 수 있게 만든다.
 * (레포에 tsx/ts-node를 넣지 않고, 이미 쓰던 "esbuild로 묶어 node로 돌리는" 방식을 고정한 것)
 *
 * obsidian 모듈은 tests/obsidian-stub.ts 로 alias 한다. SyncEngine·main·SyncLog 가 obsidian 의
 * 값(Notice·Platform·TFile·Plugin)을 쓰므로 스텁 없이는 번들 자체가 안 된다. 스텁은 실제 계약을
 * 흉내내야 한다 — 느슨한 만큼이 검증되지 않는다.
 */
import esbuild from "esbuild";
import { readdirSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

const OUT = ".test-build";
const entryPoints = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("tests", f));

if (entryPoints.length === 0) {
  console.error("테스트 파일이 없습니다 (tests/*.test.ts)");
  process.exit(1);
}

await esbuild.build({
  entryPoints,
  outdir: OUT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: "inline",
  logLevel: "info",
  alias: { obsidian: path.resolve("tests/obsidian-stub.ts") },
});

// 번들된 순서대로 실행. 하나라도 실패하면 그 자리에서 멈춘다(테스트가 process.exit(1)).
for (const entry of entryPoints) {
  const out = path.join(OUT, path.basename(entry).replace(/\.ts$/, ".js"));
  console.log(`
=== ${entry} ===`);
  const r = spawnSync(process.execPath, [out], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
