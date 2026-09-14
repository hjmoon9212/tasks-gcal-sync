/* @shared taskline v1.0.0 sha256:76b1c1fa3198584f5b9e6228554a63303928f7dc7fe1a5c7108e26ff7f922e76
 * 정본: tasks-gcal-sync-plugin/scripts/check-shared.mjs — 이 파일은 두 저장소에 **그대로** 복사된다.
 * 고칠 때: 정본 저장소에서만 고치고 → 헤더 버전을 올리고 → `node scripts/check-shared.mjs --write` → 복사. */
/*
 * 공유 파일 검사 — tasks-gcal-sync 와 gcal-calendar-view 가 같은 TaskLine 을 쓰는지 확인한다.
 *
 * 두 플러그인은 BRAT 으로 따로 배포되므로 코드를 패키지로 묶지 않고 **파일을 복사**한다.
 * 복사는 조용히 갈라진다(한쪽만 고치고 잊는다). 그래서 세 겹으로 막는다:
 *
 *   1. 헤더 해시 = 본문 해시      — 헤더를 안 고치고 본문만 고치면 실패
 *   2. (버전, 해시) = lock 기록   — 본문을 고쳤는데 버전을 안 올리면 실패(lock 은 append-only)
 *   3. --peer <다른 저장소>       — 두 저장소의 버전·본문이 바이트 동일한가
 *
 * 사용:
 *   node scripts/check-shared.mjs                    # 1·2 (CI)
 *   node scripts/check-shared.mjs --peer ../gcal-calendar-view-plugin   # + 3 (릴리스 전 로컬)
 *   node scripts/check-shared.mjs --write            # 정본 저장소에서만: 헤더 해시 갱신 + lock 추가
 *
 * 해시는 헤더 주석(첫 `*\/` 까지) 뒤의 본문을 LF 로 맞춘 바이트에 대해 계산한다 —
 * autocrlf 로 작업 사본이 CRLF 여도 결과가 같다.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const GROUP = "taskline";
const FILES = [
  "src/shared/tasks/TaskLine.ts",
  "src/shared/tasks/timeRange.ts",
  "tests/taskline.shared.test.ts",
  "scripts/check-shared.mjs",
];
const LOCK = "shared.lock.json";
const HEADER_RE = /^\/\* @shared (\S+) v(\d+\.\d+\.\d+) sha256:([0-9a-f]{64}|PENDING)\n/;

const args = process.argv.slice(2);
const write = args.includes("--write");
const peerIdx = args.indexOf("--peer");
const peer = peerIdx >= 0 ? args[peerIdx + 1] : null;

const errors = [];
const fail = (msg) => errors.push(msg);

function load(root, file) {
  const full = path.join(root, file);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  const m = text.match(HEADER_RE);
  if (!m) return { file, text, header: null };
  const end = text.indexOf("*/\n");
  if (end < 0) return { file, text, header: null };
  const headerText = text.slice(0, end + 3);
  const body = text.slice(end + 3);
  return {
    file,
    text,
    headerText,
    body,
    header: { group: m[1], version: m[2], hash: m[3] },
    actual: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

function readLock() {
  if (!existsSync(LOCK)) return { canonical: "tasks-gcal-sync", groups: {} };
  return JSON.parse(readFileSync(LOCK, "utf8"));
}

const lock = readLock();
const pkgName = existsSync("package.json")
  ? JSON.parse(readFileSync("package.json", "utf8")).name
  : "";
const entries = FILES.map((f) => load(".", f));

// ── 형식 · 그룹 · 버전 일치 ──
for (let i = 0; i < FILES.length; i++) {
  const e = entries[i];
  if (!e) fail(`${FILES[i]}: 파일이 없다`);
  else if (!e.header) fail(`${e.file}: @shared 헤더가 없다(첫 줄이 "/* @shared ${GROUP} vX.Y.Z sha256:…")`);
  else if (e.header.group !== GROUP) fail(`${e.file}: 그룹이 ${e.header.group} (기대 ${GROUP})`);
}
const present = entries.filter((e) => e && e.header);
const versions = [...new Set(present.map((e) => e.header.version))];
if (versions.length > 1) fail(`버전이 섞여 있다: ${present.map((e) => `${e.file}=${e.header.version}`).join(", ")}`);
const version = versions[0];

if (write) {
  if (pkgName !== lock.canonical) {
    console.error(`--write 는 정본 저장소(${lock.canonical})에서만 쓴다. 여기는 ${pkgName || "?"} — 정본에서 고쳐 복사할 것.`);
    process.exit(2);
  }
  if (errors.length) {
    for (const m of errors) console.error("✗ " + m);
    process.exit(1);
  }
  const recorded = lock.groups[GROUP]?.[version];
  const next = Object.fromEntries(present.map((e) => [e.file, e.actual]));
  // lock 충돌은 **아무것도 쓰기 전에** 판정한다 — 실패하면서 헤더만 고쳐 두면 다음 검사가 헷갈린다
  if (recorded) {
    const changed = Object.keys(next).filter((f) => recorded[f] !== next[f]);
    if (changed.length) {
      console.error(
        `✗ v${version} 은 이미 lock 에 다른 내용으로 기록돼 있다(${changed.join(", ")}).\n` +
          `  본문을 바꿨으면 헤더의 버전을 올린 뒤 다시 --write 할 것 — lock 은 고쳐 쓰지 않는다.`
      );
      process.exit(1);
    }
  }
  for (const e of present) {
    if (e.header.hash !== e.actual) {
      const newHeader = e.headerText.replace(HEADER_RE, `/* @shared ${GROUP} v${version} sha256:${e.actual}\n`);
      const orig = readFileSync(e.file, "utf8");
      const crlf = orig.includes("\r\n");
      const out = newHeader + e.body;
      writeFileSync(e.file, crlf ? out.replace(/\n/g, "\r\n") : out);
      console.log(`헤더 갱신: ${e.file}`);
    }
  }
  if (recorded) {
    console.log(`lock: v${version} 이미 기록됨(변경 없음)`);
  } else {
    lock.groups[GROUP] = { ...(lock.groups[GROUP] ?? {}), [version]: next };
    writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
    console.log(`lock: v${version} 추가`);
  }
  process.exit(0);
}

// ── 1. 헤더 해시 = 본문 ──
for (const e of present) {
  if (e.header.hash !== e.actual) {
    fail(`${e.file}: 헤더 해시가 본문과 다르다 — 본문을 고쳤다면 정본에서 버전을 올리고 --write`);
  }
}

// ── 2. lock 기록과 일치 ──
if (version) {
  const recorded = lock.groups?.[GROUP]?.[version];
  if (!recorded) fail(`${LOCK}: ${GROUP} v${version} 기록이 없다`);
  else {
    for (const e of present) {
      if (recorded[e.file] !== e.actual) {
        fail(`${e.file}: v${version} 의 lock 해시와 다르다 — 같은 버전에 다른 내용(버전을 올려야 한다)`);
      }
    }
  }
}

// ── 3. 다른 저장소와 바이트 동일 ──
if (peer) {
  for (let i = 0; i < FILES.length; i++) {
    const mine = entries[i];
    const theirs = load(peer, FILES[i]);
    if (!theirs) fail(`peer ${FILES[i]}: 파일이 없다`);
    else if (mine && theirs.text !== mine.text) {
      const tv = theirs.header?.version ?? "?";
      const mv = mine.header?.version ?? "?";
      fail(`peer ${FILES[i]}: 내용이 다르다(여기 v${mv} / ${peer} v${tv})`);
    }
  }
}

if (errors.length) {
  for (const m of errors) console.error("✗ " + m);
  process.exit(1);
}
console.log(`shared ${GROUP} v${version}: ${present.length}개 파일 일치${peer ? ` · peer ${peer} 와 동일` : ""}`);
