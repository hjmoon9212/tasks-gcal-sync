/**
 * 동기화 로그의 포맷/선별.
 *
 * 로그는 사고 후에 읽는 물건이라, 깨진 줄 하나가 곧 "그때 무슨 일이 있었는지 모름"이 된다.
 * 파일 I/O는 어댑터가 하고 여기서는 **문자열로 굳는 부분**만 본다 —
 *  - 식별 정보(🆔·제목·캘린더·위치)가 항상 상세보다 앞에 온다(훑기 위해).
 *  - 개행이 섞여도 목록 한 줄이 유지된다.
 *  - 조용한 run(남길 항목 없음)은 빈 블록을 만들지 않는다.
 */
import {
  SyncLogEntry,
  SyncLogWriter,
  extendBlock,
  formatBlock,
  formatEntry,
  newBlock,
  renderBlock,
  selectEntries,
} from "../src/sync/SyncLog";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.error(
      `✗ ${msg}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`
    );
  }
}
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}

// --- 한 줄 포맷 ---
const created: SyncLogEntry = {
  action: "CREATE",
  id: "a3f9k2",
  title: "논문 초고 마감",
  calendar: "Growth",
  eventId: "ev_88f1",
  where: "Projects/논문.md:14",
  detail: "due=2026-08-20 time=09:00-10:00",
};
eq(
  formatEntry(created),
  '- CREATE `a3f9k2` "논문 초고 마감" cal=Growth ev=ev_88f1 @Projects/논문.md:14 — due=2026-08-20 time=09:00-10:00',
  "CREATE 한 줄"
);

eq(
  formatEntry({ action: "FAIL", detail: "run 전체 실패: 401" }),
  "- FAIL — run 전체 실패: 401",
  "식별 정보가 없어도 형식 유지"
);

eq(
  formatEntry({ action: "SKIP", id: "b1" }),
  "- SKIP `b1`",
  "상세가 없으면 구분자(—)를 붙이지 않는다"
);

// 상세는 항상 맨 뒤 — 길이가 들쭉날쭉해도 앞쪽 식별 정보의 자리가 안 밀린다.
const long = formatEntry({
  action: "PULL",
  id: "d4",
  title: "세미나",
  calendar: "Work",
  where: "Inbox.md:7",
  detail: "⚔️ 충돌 due(노트 08-18→08-19 / GCal 08-18→08-21) → GCal 채택",
});
ok(
  long.indexOf("@Inbox.md:7") < long.indexOf("⚔️"),
  "위치가 상세보다 앞에 온다"
);

// 개행이 섞인 오류 메시지가 들어와도 목록 한 줄을 유지한다.
const multiline = formatEntry({
  action: "FAIL",
  id: "x1",
  detail: "GCal POST 400:\n  Invalid start date\n  (bad request)",
});
ok(!multiline.includes("\n"), "개행은 한 줄로 접힌다");
ok(multiline.includes("⏎"), "접힌 자리는 ⏎ 로 표시된다");

// --- 선별 ---
const mixed: SyncLogEntry[] = [
  { action: "CREATE", id: "a" },
  { action: "SKIP", id: "b" },
  { action: "HOLD", id: "c" },
  { action: "FAIL", id: "d" },
  { action: "DELETE", id: "e" },
];
eq(
  selectEntries(mixed, true).map((e) => e.id),
  ["a", "b", "c", "d", "e"],
  "logSkips=on 이면 전부 남긴다"
);
eq(
  selectEntries(mixed, false).map((e) => e.id),
  ["a", "e"],
  "logSkips=off 면 실제 변경만 남긴다"
);
eq(
  selectEntries([{ action: "SKIP" }, { action: "HOLD" }], false),
  [],
  "보류뿐인 run은 남길 게 없다 → 빈 배열(파일에 안 씀)"
);

// --- 블록 ---
const block = formatBlock(
  "+1 ~0 ↔0 -1 ⬇0",
  "주기(5분)",
  [created, { action: "DELETE", id: "c2", detail: "task 줄이 사라짐" }],
  new Date(2026, 7, 16, 9, 5, 3)
);
ok(
  block.startsWith("\n## 2026-08-16 09:05:03 · +1 ~0 ↔0 -1 ⬇0 · 주기(5분)\n"),
  "블록 헤더: 시각 · 요약 · 계기"
);
eq(block.trimEnd().split("\n").length, 4, "헤더 1줄 + 항목 2줄 (앞 빈 줄 포함)");
ok(block.endsWith("\n"), "블록은 개행으로 끝난다(다음 append와 안 붙는다)");

// --- 연속 중복 접기 ---
// 볼트가 Sync 중이면 run 이 통째로 보류되는데, 편집이 잦으면 같은 SKIP 한 줄이
// 십수 초마다 쌓여 파일을 채웠다(2026-08-16). 접어도 정보는 안 잃어야 한다.
{
  const skip: SyncLogEntry[] = [{ action: "SKIP", detail: "볼트 동기화 중" }];
  let b = newBlock("+0 ~0 (skip 1)", "편집 자동", skip, new Date(2026, 7, 16, 4, 0, 26));
  b = extendBlock(b, "편집 자동", new Date(2026, 7, 16, 4, 0, 39));
  b = extendBlock(b, "주기(5분)", new Date(2026, 7, 16, 4, 1, 50));
  const r = renderBlock(b);
  ok(r.includes("2026-08-16 04:00:26 ~ 04:01:50"), "헤더에 첫 시각~끝 시각");
  ok(r.includes("×3회"), "관측 횟수");
  ok(r.includes("편집 자동 외 1종"), "계기가 섞이면 종류 수를 밝힌다");
  eq(r.trimEnd().split("\n").length, 3, "항목 줄은 한 벌만 (헤더 + 1줄 + 앞 빈 줄)");
  eq(b.signature, newBlock("다른 요약", "다른 계기", skip).signature, "접기 기준은 항목 줄뿐");
}

// --- 파일에 실제로 쓰이는 모양 ---
function fakeVault(seed: Record<string, string> = {}) {
  const files: Record<string, string> = { ...seed };
  const adapter = {
    exists: async (p: string) => p in files,
    read: async (p: string) => files[p],
    write: async (p: string, d: string) => {
      files[p] = d;
    },
    append: async (p: string, d: string) => {
      files[p] = (files[p] ?? "") + d;
    },
    mkdir: async () => {},
    stat: async (p: string) => ({ size: files[p]?.length ?? 0 }),
  };
  return { app: { vault: { adapter } } as any, files };
}

(async () => {
{
  const { app, files } = fakeVault();
  const w = new SyncLogWriter(app, () => ({
    enabled: true,
    path: "Logs/log.md",
    maxKB: 512,
    logSkips: true,
  }));
  const skip: SyncLogEntry[] = [{ action: "SKIP", detail: "볼트 동기화 중" }];

  await w.append("+0 ~0 (skip 1)", skip, "편집 자동");
  const once = files["Logs/log.md"];
  ok(once.startsWith("# Tasks ⇄ GCal 동기화 로그"), "첫 기록에 헤더를 만든다");
  eq((once.match(/^## /gm) ?? []).length, 1, "블록 1개");

  await w.append("+0 ~0 (skip 1)", skip, "편집 자동");
  await w.append("+0 ~0 (skip 1)", skip, "주기(5분)");
  const thrice = files["Logs/log.md"];
  eq((thrice.match(/^## /gm) ?? []).length, 1, "같은 내용은 블록을 늘리지 않는다");
  eq((thrice.match(/- SKIP/g) ?? []).length, 1, "항목 줄도 한 벌만 남는다");
  ok(thrice.includes("×3회"), "대신 횟수로 센다");

  // 내용이 달라지면 새 블록
  await w.append("+1 ~0", [{ action: "CREATE", id: "a1" }], "편집 자동");
  const after = files["Logs/log.md"];
  eq((after.match(/^## /gm) ?? []).length, 2, "다른 내용은 새 블록");
  ok(after.includes("×3회"), "접힌 블록은 그대로 보존된다");

  // 같은 SKIP 이 다시 와도 이전 접힌 블록에 합치지 않는다(사이에 다른 일이 있었다)
  await w.append("+0 ~0 (skip 1)", skip, "편집 자동");
  eq(
    (files["Logs/log.md"].match(/^## /gm) ?? []).length,
    3,
    "끊긴 뒤의 반복은 새 블록에서 다시 센다"
  );
}

{
  // 파일 끝이 우리가 아는 모양이 아니면(사용자 편집 등) 덮어쓰지 않고 append 로 폴백
  const { app, files } = fakeVault();
  const w = new SyncLogWriter(app, () => ({
    enabled: true,
    path: "Logs/log.md",
    maxKB: 512,
    logSkips: true,
  }));
  const skip: SyncLogEntry[] = [{ action: "SKIP", detail: "볼트 동기화 중" }];
  await w.append("+0 ~0", skip, "편집 자동");
  files["Logs/log.md"] += "\n사용자가 직접 적은 메모\n";
  await w.append("+0 ~0", skip, "편집 자동");
  ok(
    files["Logs/log.md"].includes("사용자가 직접 적은 메모"),
    "남의 텍스트를 덮어쓰지 않는다"
  );
  eq((files["Logs/log.md"].match(/^## /gm) ?? []).length, 2, "대신 새 블록으로 붙인다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
})();
