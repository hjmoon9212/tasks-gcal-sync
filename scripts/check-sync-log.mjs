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
 *   3) 구조 (0.11.0~)
 *      로그는 `## 날짜` 절 · `### 시각` run · `- ⏸` 조용한 묶음 3단이 됐다. 날짜가 절
 *      제목으로 올라갔으니 **날짜 없는 고아 run · 같은 날짜 절이 두 번 · 자정을 넘긴
 *      접기**는 전부 코드 회귀다. 셋 다 0 이어야 한다.
 *
 * **0.11.0 이전 블록(`## 2026-08-16 09:05:03 · …`)과 새 포맷은 한 파일에 공존한다.**
 * 마이그레이션을 하지 않기 때문이다(옛 기록은 트림으로 늙어 나간다) → 둘 다 읽는다.
 *
 * 사용:
 *   node scripts/check-sync-log.mjs "<볼트>/Logs/GCal 동기화 로그 (HJMoon).md" [...]
 *   → 문제가 하나라도 있으면 exit 1
 */
import { readFileSync } from "node:fs";

/** 날짜 절 제목 — Outline 의 1단은 이것뿐이어야 한다. */
const DAY = /^## (\d{4}-\d{2}-\d{2}) \([일월화수목금토]\)$/;
/** 0.11.0 이전 run 블록(제목이 스스로 날짜를 갖는다). */
const OLD = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?: ~ (\d{2}:\d{2}:\d{2}))? · (.*)$/;
/** 실제로 뭔가 바꾼 run — **날짜는 위의 절 제목에 있다.** */
const RUN = /^### (\d{2}:\d{2}:\d{2})(?: ~ (\d{2}:\d{2}:\d{2}))? · (.*)$/;
/** 보류·건너뜀만 있던 run — 제목이 없고 목록 항목으로 남는다. */
const QUIET = /^- ⏸ (\d{2}:\d{2}:\d{2})(?: ~ (\d{2}:\d{2}:\d{2}))?(?: · ×(\d+)회)? · (.*)$/;
/** `due(노트 A→B / GCal C→D)` — B와 D가 같으면 충돌이 아니다. */
const PAIR = /(due|start|time|title)\(노트 (.*?)→(.*?) \/ GCal (.*?)→(.*?)\)(?=, (?:due|start|time|title)\(|$)/g;

function parse(text) {
  const blocks = [];
  const days = [];
  let day = null; // 현재 절의 날짜 — run 의 시각에 붙여 절대 시각을 만든다
  let cur = null;
  let orphans = 0; // 절 제목 없이 뜬 run = 트림이 고아를 남겼다
  const open = (b) => {
    if (cur) blocks.push(cur);
    cur = b;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = DAY.exec(line))) {
      open(null);
      day = m[1];
      days.push(m[1]);
      continue;
    }
    if ((m = OLD.exec(line))) {
      // 옛 블록의 조용함은 계수기가 전부 0 인 것으로 알아본다(아래 시각 역전 면제용).
      const quiet = /\+0 ~0 ↔0 -0 ⬇0/.test(m[3]);
      open({ kind: "old", quiet, start: m[1], end: m[2] ?? "", rest: m[3], body: [] });
      day = m[1].slice(0, 10);
      continue;
    }
    if ((m = RUN.exec(line))) {
      if (!day) orphans++;
      open({
        kind: "run",
        quiet: false,
        start: `${day ?? "????-??-??"} ${m[1]}`,
        end: m[2] ?? "",
        rest: m[3],
        body: [],
      });
      continue;
    }
    if ((m = QUIET.exec(line))) {
      if (!day) orphans++;
      open({
        kind: "quiet",
        quiet: true,
        start: `${day ?? "????-??-??"} ${m[1]}`,
        end: m[2] ?? "",
        rest: `×${m[3] ?? 1} · ${m[4]}`,
        body: [],
      });
      continue;
    }
    // 조용한 묶음의 항목 줄은 들여쓰여 있다 → trim 해서 담아야 충돌 검사가 그대로 돈다.
    if (cur && line.trim()) cur.body.push(line.trim());
  }
  if (cur) blocks.push(cur);
  return { blocks, days, orphans };
}

function check(path) {
  const text = readFileSync(path, "utf8");
  const { blocks, days, orphans } = parse(text);
  const bytes = Buffer.byteLength(text, "utf8");

  // 1a) 머리 줄과 본문이 통째로 같은 블록 = 병합이 복제한 것
  const seen = new Map();
  let duplicates = 0;
  for (const b of blocks) {
    const key = `${b.kind}|${b.start}|${b.end}|${b.rest}|${b.body.join("\n")}`;
    if (seen.has(key)) duplicates++;
    else seen.set(key, true);
  }

  // 1b) 앞 블록이 더 나중 = 병합이 오래된 구간을 끼워 넣은 것.
  //     날짜가 절 제목으로 옮겨갔으므로 **절대 시각으로 복원해서** 비교한다
  //     (`YYYY-MM-DD HH:MM:SS` 는 문자열 비교가 곧 시각 비교다).
  //
  // ⚠️ **지연 쓰기(0.9.3)가 만드는 작은 역전은 손상이 아니다.** 보류·건너뜀뿐인 run 은
  //    쌓여 있다가 실제 사건이 생길 때 함께 나가므로, 실행이 겹치면 늦게 적힌 조용한
  //    블록이 앞 블록보다 몇십 초 이르게 찍힌다(2026-09-10 실측: ew70 파일에 3건, 모두
  //    30초 이내 · 전부 조용한 블록). 병합 손상은 분·일 단위로 벌어지므로, **조용한
  //    블록이 2분 안쪽으로 이른 경우만 면제**하면 원래 잡으려던 신호는 그대로 남는다.
  const ms = (s) => Date.parse(s.replace(" ", "T"));
  const DEFERRED_SLACK_MS = 120_000;
  let outOfOrder = 0;
  let deferred = 0;
  for (let i = 1; i < blocks.length; i++) {
    const cur = blocks[i];
    const prev = blocks[i - 1];
    if (cur.start.startsWith("?") || prev.start.startsWith("?")) continue;
    if (cur.start >= prev.start) continue;
    // 접힌 블록은 **끝 시각**이 "마지막으로 관측된 순간"이다 — 지연 쓰기 면제는 그걸 본다.
    const curLast = cur.end ? `${cur.start.slice(0, 10)} ${cur.end}` : cur.start;
    if (cur.quiet && ms(prev.start) - ms(curLast) <= DEFERRED_SLACK_MS) {
      deferred++;
      continue;
    }
    outOfOrder++;
  }

  // 3a) 같은 날짜 절이 두 번 열렸다 / 절 순서가 역전됐다
  let dayDupes = 0;
  let dayOutOfOrder = 0;
  const seenDays = new Set();
  for (let i = 0; i < days.length; i++) {
    if (i && days[i] < days[i - 1]) dayOutOfOrder++;
    if (seenDays.has(days[i])) dayDupes++;
    else seenDays.add(days[i]);
  }

  // 3b) 자정을 넘긴 접기 = 하루 절 안에 살 수 없는 블록(끝 시각이 첫 시각보다 이르다)
  let midnight = 0;
  for (const b of blocks) {
    if (b.kind !== "old" && b.end && b.end < b.start.slice(11)) midnight++;
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

  const bad =
    duplicates > 0 ||
    outOfOrder > 0 ||
    fakeConflicts > 0 ||
    orphans > 0 ||
    dayDupes > 0 ||
    dayOutOfOrder > 0 ||
    midnight > 0;
  const runs = blocks.filter((b) => b.kind === "run").length;
  const quiets = blocks.filter((b) => b.kind === "quiet").length;
  const olds = blocks.filter((b) => b.kind === "old").length;
  console.log(`\n${path}`);
  console.log(
    `  날짜 절 ${days.length} · run ${runs} · 조용한 묶음 ${quiets} · 옛 블록 ${olds} · ${(bytes / 1024).toFixed(1)}KB`
  );
  console.log(`  ${duplicates === 0 ? "✓" : "✗"} 완전 중복 블록: ${duplicates}`);
  console.log(
    `  ${outOfOrder === 0 ? "✓" : "✗"} 시각 역전: ${outOfOrder}` +
      (deferred ? ` (지연 쓰기로 설명되는 ${deferred}건은 제외)` : "")
  );
  console.log(`  ${fakeConflicts === 0 ? "✓" : "✗"} 가짜 충돌: ${fakeConflicts}`);
  console.log(`  ${orphans === 0 ? "✓" : "✗"} 날짜 없는 고아 run: ${orphans}`);
  console.log(
    `  ${dayDupes === 0 && dayOutOfOrder === 0 ? "✓" : "✗"} 날짜 절 중복/역전: ${dayDupes}/${dayOutOfOrder}`
  );
  console.log(`  ${midnight === 0 ? "✓" : "✗"} 자정 넘긴 접기: ${midnight}`);
  console.log(`  · 진짜 충돌: ${realConflicts} (0이 아니어도 정상 — 값이 실제로 갈린 것)`);
  if (duplicates || outOfOrder) {
    console.log(
      "  → 두 기기가 같은 파일에 쓰고 있다. 각 기기 설정 § 5 의 「이 기기 이름」이 서로 다른지 확인할 것."
    );
  }
  if (fakeConflicts) {
    console.log("  → 값이 같은데 충돌로 적혔다. reconcile.ts 의 합의 판정이 회귀했다.");
  }
  if (orphans) {
    console.log("  → 트림이 날짜 절 제목 없이 run 을 남겼다. SyncLog.trim 의 폴백 경로가 회귀했다.");
  }
  if (dayDupes || dayOutOfOrder) {
    console.log("  → 같은 날짜 절이 두 번 열렸다. SyncLog 의 lastDaySection/dayOnDisk 판정이 회귀했다.");
  }
  if (midnight) {
    console.log("  → 접기가 자정을 넘었다. SyncLog.enqueue 의 날짜 비교가 회귀했다.");
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
