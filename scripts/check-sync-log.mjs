#!/usr/bin/env node
/*
 * 동기화 로그 건강 검사.
 *
 * 2026-09-07 에 실제 로그 두 개(941 / 1,136 블록, 3주치)를 분석하다 서로 다른 두 문제가
 * 드러났고, 0.8.0 이 그 둘을 고쳤다. 이 스크립트는 **고쳐진 상태가 유지되는지**를 실기기
 * 로그로 확인하는 도구다 — 단위 테스트가 흉내 낼 수 없는 것(여러 기기 · 실제 Sync 타이밍)
 * 이라 여기서만 잡힌다.
 *
 *   1) 중복 블록 · 시각 역전
 *      한 파일에 두 기기가 쓰면 Obsidian Sync 의 텍스트 병합이 블록을 복제하고 순서를
 *      뒤섞는다. 0.8.0 부터 파일마다 기록자가 하나이므로 **둘 다 0 이어야 한다.**
 *      (수정 전 실측: 한 볼트에서 완전 중복 52건 = 파일의 11%, 시각 역전 6곳)
 *
 *   2) 가짜 충돌
 *      양쪽 값이 **같은데** 충돌로 적힌 줄. 기준선만 뒤처졌을 뿐이라 폐기된 것이 없다.
 *      0.8.0 부터 충돌로 세지 않으므로 **0 이어야 한다.**
 *      (수정 전 실측: 충돌 127건 중 122건 = 96%)
 *
 * 사용:
 *   node scripts/check-sync-log.mjs "<볼트>/Logs/GCal 동기화 로그 (HJMoon).md" [...]
 *   → 문제가 하나라도 있으면 exit 1
 */
import { readFileSync } from "node:fs";

const HDR = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?: ~ (\d{2}:\d{2}:\d{2}))? · (.*)$/;
/** `due(노트 A→B / GCal C→D)` — B와 D가 같으면 충돌이 아니다. */
const PAIR = /(due|start|time|title)\(노트 (.*?)→(.*?) \/ GCal (.*?)→(.*?)\)(?=, (?:due|start|time|title)\(|$)/g;

function parse(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = HDR.exec(line);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { start: m[1], end: m[2], rest: m[3], body: [] };
    } else if (cur && line.trim()) {
      cur.body.push(line.trimEnd());
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function check(path) {
  const text = readFileSync(path, "utf8");
  const blocks = parse(text);
  const bytes = Buffer.byteLength(text, "utf8");

  // 1a) 헤더와 본문이 통째로 같은 블록 = 병합이 복제한 것
  const seen = new Map();
  let duplicates = 0;
  for (const b of blocks) {
    const key = `${b.start}|${b.end}|${b.rest}|${b.body.join("\n")}`;
    if (seen.has(key)) duplicates++;
    else seen.set(key, true);
  }

  // 1b) 앞 블록이 더 나중 = 병합이 오래된 구간을 끼워 넣은 것
  let outOfOrder = 0;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start < blocks[i - 1].start) outOfOrder++;
  }

  // 2) 충돌 줄을 진짜/가짜로 가른다
  let realConflicts = 0;
  let fakeConflicts = 0;
  for (const b of blocks) {
    for (const line of b.body) {
      if (!line.startsWith("- ") || !line.includes("⚔️")) continue;
      const seg = line.split("⚔️ 충돌 ")[1];
      if (!seg) continue;
      const pairs = [...seg.split(" → ")[0].matchAll(PAIR)];
      if (!pairs.length) continue;
      if (pairs.some((p) => p[3].trim() !== p[5].trim())) realConflicts++;
      else fakeConflicts++;
    }
  }

  const bad = duplicates > 0 || outOfOrder > 0 || fakeConflicts > 0;
  console.log(`\n${path}`);
  console.log(`  블록 ${blocks.length}개 · ${(bytes / 1024).toFixed(1)}KB`);
  console.log(`  ${duplicates === 0 ? "✓" : "✗"} 완전 중복 블록: ${duplicates}`);
  console.log(`  ${outOfOrder === 0 ? "✓" : "✗"} 시각 역전: ${outOfOrder}`);
  console.log(`  ${fakeConflicts === 0 ? "✓" : "✗"} 가짜 충돌: ${fakeConflicts}`);
  console.log(`  · 진짜 충돌: ${realConflicts} (0이 아니어도 정상 — 값이 실제로 갈린 것)`);
  if (duplicates || outOfOrder) {
    console.log(
      "  → 두 기기가 같은 파일에 쓰고 있다. 각 기기 설정 § 5 의 「이 기기 이름」이 서로 다른지 확인할 것."
    );
  }
  if (fakeConflicts) {
    console.log("  → 값이 같은데 충돌로 적혔다. reconcile.ts 의 합의 판정이 회귀했다.");
  }
  return !bad;
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('사용: node scripts/check-sync-log.mjs "<로그 파일>" [...]');
  process.exit(2);
}
const allOk = paths.map(check).every(Boolean);
console.log(allOk ? "\n전부 정상" : "\n문제 있음");
process.exit(allOk ? 0 : 1);
