// 버전 일괄 관리 스크립트.
// 사용법:
//   node version-bump.mjs 0.2.1   → manifest/package/versions.json 을 0.2.1로 통일
//   node version-bump.mjs         → 인자 없으면 manifest.json의 현재 version 기준으로
//                                    package.json/versions.json만 맞춰 동기화
//
// 이 스크립트는 "버전 파일 3종만" 갱신한다. 실제 배포는 별도 단계:
//   1) node version-bump.mjs <버전>   # 이 스크립트
//   2) git commit & push              # 소스 커밋 (main.js는 gitignore)
//   3) git tag <버전> && git push origin <버전>   # v 접두사 없이 manifest.version 과 동일
// 태그 push → .github/workflows/release.yml 이 빌드 후 main.js/manifest.json/versions.json 을
// 첨부한 GitHub Release 를 생성 → BRAT/커뮤니티 스토어가 그 Release 에서 내려받는다.
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
