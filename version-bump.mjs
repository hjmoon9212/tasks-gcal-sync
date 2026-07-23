// 버전 일괄 관리 스크립트.
// 사용법:
//   node version-bump.mjs 0.2.1   → manifest/package/versions.json 을 0.2.1로 통일
//   node version-bump.mjs         → 인자 없으면 manifest.json의 현재 version 기준으로
//                                    package.json/versions.json만 맞춰 동기화
// (이 플러그인은 수동 배포라 git 태그/커밋 없이 파일만 갱신한다.)
import { readFileSync, writeFileSync } from "fs";

const write = (f, obj) => writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.argv[2] ?? manifest.version;

// 1) manifest.json — Obsidian이 읽는 실제 버전
manifest.version = target;
write("manifest.json", manifest);

// 2) package.json — 개발용 버전(동기화만)
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = target;
write("package.json", pkg);

// 3) versions.json — 버전 → 최소 Obsidian 버전(minAppVersion) 매핑(이력 유지)
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = manifest.minAppVersion;
write("versions.json", versions);

console.log(`[version-bump] ${target} (minAppVersion ${manifest.minAppVersion})`);
