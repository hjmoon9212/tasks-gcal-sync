/**
 * 동기화 로그의 포맷/선별.
 *
 * 로그는 사고 후에 읽는 물건이라, 깨진 줄 하나가 곧 "그때 무슨 일이 있었는지 모름"이 된다.
 * 파일 I/O는 어댑터가 하고 여기서는 **문자열로 굳는 부분**만 본다 —
 *  - 식별 정보(🆔·제목·캘린더·위치)가 항상 상세보다 앞에 온다(훑기 위해).
 *  - 개행이 섞여도 목록 한 줄이 유지된다.
 *  - 조용한 run(남길 항목 없음)은 빈 블록을 만들지 않는다.
 */
import { TFile } from "obsidian";
import {
  LogAction,
  SyncLogEntry,
  SyncLogWriter,
  changeGist,
  extendBlock,
  formatBlock,
  formatEntry,
  isQuiet,
  lastDaySection,
  newBlock,
  renderBlock,
  selectEntries,
  targetLabel,
  withDeviceTag,
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

// --- 변경 run 블록 ---
//
// 제목은 **Outline 으로 순간이동하는 데 쓰인다.** 그래서 시각 다음에 오는 것이 "무엇이
// 바뀌었나 · 무엇에" 여야 한다. 예전 제목은 `+0 ~0 ↔0 -0 ⬇0 (skip 1) · 보류 해제 후속`
// 이었고 실측 파일의 97%가 정확히 그 모양이라(360블록 중 350) 서로 구분되지 않았다.
const block = formatBlock(
  "+1 ~0 ↔0 -1 ⬇0",
  "주기(5분)",
  [created, { action: "DELETE", id: "c2", detail: "task 줄이 사라짐" }],
  new Date(2026, 7, 16, 9, 5, 3)
);
ok(
  block.startsWith('\n### 09:05:03 · +1 -1 "논문 초고 마감" 외 1 · 주기(5분)\n'),
  "run 제목: 시각 · 변경 요지 · 대상 · 계기"
);
ok(!block.includes("↔0"), "0 인 계수기는 제목에 안 적는다 ★");
ok(!/^## /m.test(block), "블록은 날짜 절 제목을 스스로 적지 않는다 ★ (rewriteTail 열쇠)");
eq(block.trimEnd().split("\n").length, 4, "제목 1줄 + 항목 2줄 (앞 빈 줄 포함)");
ok(block.endsWith("\n"), "블록은 개행으로 끝난다(다음 append와 안 붙는다)");

// --- 연속 중복 접기 (보류뿐인 run → 제목 없는 묶음) ---
// 볼트가 Sync 중이면 run 이 통째로 보류되는데, 편집이 잦으면 같은 SKIP 한 줄이
// 십수 초마다 쌓여 파일을 채웠다(2026-08-16). 접어도 정보는 안 잃어야 한다.
{
  const skip: SyncLogEntry[] = [{ action: "SKIP", detail: "볼트 동기화 중" }];
  let b = newBlock("+0 ~0 (skip 1)", "편집 자동", skip, new Date(2026, 7, 16, 4, 0, 26));
  b = extendBlock(b, "편집 자동", new Date(2026, 7, 16, 4, 0, 39));
  b = extendBlock(b, "주기(5분)", new Date(2026, 7, 16, 4, 1, 50));
  const r = renderBlock(b);
  ok(r.includes("04:00:26 ~ 04:01:50"), "머리 줄에 첫 시각~끝 시각(날짜는 절 제목이 갖는다)");
  ok(r.includes("×3회"), "관측 횟수");
  ok(r.includes("편집 자동 외 1종"), "계기가 섞이면 종류 수를 밝힌다");
  eq(r.trimEnd().split("\n").length, 3, "항목 줄은 한 벌만 (머리 줄 + 1줄 + 앞 빈 줄)");
  eq(b.signature, newBlock("다른 요약", "다른 계기", skip).signature, "접기 기준은 항목 줄뿐");
  // 제목을 만들지 않는 것이 이 포맷의 핵심이다 — Outline 은 제목만 보여준다.
  ok(r.startsWith("\n- ⏸ "), "보류뿐인 run 은 제목을 안 만든다 ★");
  ok(!/^#/m.test(r), "그래서 Outline 에 안 뜬다 ★");
  ok(r.includes("\n  - SKIP"), "항목 줄은 자식으로 들여써 보존된다");
  ok(r.includes("— +0 ~0 (skip 1)"), "summary(계수기)는 묶음 줄에 남는다");
}

// --- 제목용 파생값 ---
{
  eq(
    changeGist([{ action: "CREATE" }, { action: "CREATE" }, { action: "PULL" }]),
    "+2 ⬇1",
    "같은 동작은 세고, 0 은 안 적는다"
  );
  eq(changeGist([{ action: "PULL" }, { action: "CREATE" }]), "+1 ⬇1", "기호 순서는 고정");
  eq(changeGist([{ action: "DROP" }, { action: "DELETE" }]), "-2", "DROP 도 삭제 쪽 기호");
  eq(changeGist([{ action: "FAIL" }]), "⚠1", "실패도 제목을 갖는다");
  eq(changeGist([{ action: "HOLD" }, { action: "SKIP" }]), "", "보류·건너뜀은 요지가 없다");

  // ★ 새 동작을 GIST 표에 안 넣으면 그 변경이 제목 없이 묶음에 묻혀 Outline 에서 영영
  //   안 보인다. 조용한 것은 HOLD·SKIP 둘뿐이어야 한다.
  const all: LogAction[] = [
    "CREATE", "UPDATE", "MOVE", "DELETE", "PULL", "UNSCHEDULE",
    "DROP", "ADOPT", "HOLD", "SKIP", "REPAIR", "FAIL",
  ];
  eq(
    all.filter((a) => isQuiet([{ action: a }])),
    ["HOLD", "SKIP"],
    "조용한 동작은 HOLD·SKIP 뿐 ★"
  );

  eq(targetLabel([{ action: "CREATE", title: "빨래" }]), '"빨래"', "제목을 쓴다");
  eq(targetLabel([{ action: "CREATE", id: "a1" }]), "`a1`", "제목이 없으면 🆔");
  eq(targetLabel([{ action: "HOLD", title: "안 바뀐 것" }]), "", "보류 제목은 안 쓴다 ★");
  eq(
    targetLabel([
      { action: "UPDATE", title: "빨래" },
      { action: "UPDATE", title: "빨래" },
    ]),
    '"빨래"',
    "같은 제목은 한 번만 센다"
  );
  eq(
    targetLabel([
      { action: "UPDATE", title: "빨래" },
      { action: "PULL", title: "설거지" },
      { action: "PULL", title: "청소" },
    ]),
    '"빨래" 외 2',
    "여러 대상이면 첫 제목 + 나머지 개수"
  );
  ok(
    targetLabel([{ action: "CREATE", title: "가".repeat(60) }]).includes("…"),
    "긴 제목은 끊는다(제목 줄이 화면을 넘기면 훑기가 안 된다)"
  );

  // 제목도 🆔도 없는 run(FAIL 경로: main 이 "동기화 중단" 을 summary 로 넘긴다)
  const fb = newBlock("동기화 중단", "수동(리본)", [
    { action: "FAIL", detail: "run 전체 실패: 401" },
  ]);
  eq(fb.label, "동기화 중단", "대상이 없으면 summary 로 메운다");
}

// --- 날짜 절 판정 ---
{
  eq(lastDaySection(""), null, "빈 파일엔 절이 없다");
  eq(lastDaySection("# 로그\n\n## 2026-09-12 (토)\n\n### 09:00:00 · +1 · 주기(5분)\n"), "2026-09-12", "마지막 절의 날짜");
  eq(
    lastDaySection("## 2026-09-11 (금)\n\n## 2026-09-12 (토)\n"),
    "2026-09-12",
    "절이 여러 개면 마지막"
  );
  // ★ 0.11 이전 블록이 파일 끝이면 그 밑에 `###` 를 넣으면 안 된다 — 그 시각 블록에
  //   딸린 하위 항목처럼 읽힌다. null 을 돌려 새 절을 열게 한다.
  eq(
    lastDaySection("## 2026-09-12 (토)\n\n## 2026-08-16 09:05:03 · +1 ~0 · 주기(5분)\n"),
    null,
    "옛 포맷 블록이 끝이면 모른다고 답한다 ★"
  );
}

// --- 파일에 실제로 쓰이는 모양 ---
/**
 * 볼트 스텁 — **Vault API** 를 흉내낸다(`adapter` 가 아니라).
 *
 * ⛔ 로그 파일은 볼트 안 파일이라 볼트 API 로 다뤄야 한다. 어댑터로 직접 쓰면 Obsidian 이
 *    파일을 제대로 등록하지 못해 Dataview 가 *"Cannot index file, since it has no Obsidian
 *    file metadata"* 로 터진다(2026-09-10 실측) → SyncLogWriter.file
 */
function fakeVault(seed: Record<string, string> = {}) {
  const files: Record<string, string> = { ...seed };
  const folders = new Set<string>();
  /** TFile 흉내 — `stat.size` 는 **바이트**다. 문자 수를 돌려주면 한국어(UTF-8 3바이트)에서
   *  트림이 안 도는 버그가 테스트에 안 잡힌다(2026-09-07 까지 실제로 그랬다). */
  // ⚠️ **진짜 TFile 인스턴스여야 한다** — SyncLogWriter.file 이 `instanceof TFile` 로 거른다.
  //    평범한 객체를 주면 "파일 없음"으로 읽혀 매번 새로 만들어 버린다.
  const handles: Record<string, TFile> = {};
  const tfile = (p: string): TFile | undefined => {
    if (!(p in files)) return undefined;
    if (!handles[p]) {
      const f = new TFile();
      f.path = p;
      Object.defineProperty(f, "stat", {
        get: () => ({ size: new TextEncoder().encode(files[p] ?? "").length }),
      });
      handles[p] = f;
    }
    return handles[p];
  };
  const vault = {
    getAbstractFileByPath: (p: string) =>
      tfile(p) ?? (folders.has(p) ? { path: p } : null),
    createFolder: async (p: string) => {
      folders.add(p);
    },
    create: async (p: string, d: string) => {
      files[p] = d;
      return tfile(p);
    },
    read: async (f: any) => files[f.path],
    modify: async (f: any, d: string) => {
      files[f.path] = d;
    },
    append: async (f: any, d: string) => {
      files[f.path] = (files[f.path] ?? "") + d;
    },
    process: async (f: any, fn: (t: string) => string) => {
      files[f.path] = fn(files[f.path] ?? "");
      return files[f.path];
    },
  };
  return { app: { vault } as any, files };
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
  eq((once.match(/^## /gm) ?? []).length, 1, "날짜 절 1개");
  eq((once.match(/^- ⏸ /gm) ?? []).length, 1, "조용한 묶음 1개");

  // ★★ 반복은 **파일을 건드리지 않는다.** 로그 파일은 볼트 안에 있어서, 쓰면 Obsidian
  //    Sync 가 그것을 업로드하고 그 동안 vaultBehind() 가 참이 된다 → 보류 → 또 로그
  //    쓰기. 2026-09-10 에 이 되먹임으로 볼트가 15~30초마다 "따라잡는 중"으로 깜빡여
  //    vaultUnsettled 가 안 풀렸고, 🆔 재발급이 3분을 기다렸다.
  await w.append("+0 ~0 (skip 1)", skip, "편집 자동");
  eq(files["Logs/log.md"], once, "같은 내용이 이어지면 파일을 안 건드린다 ★★");
  await w.append("+0 ~0 (skip 1)", skip, "주기(5분)");
  eq(files["Logs/log.md"], once, "몇 번을 반복해도 마찬가지 ★★");

  // 접힌 내용은 사라지지 않는다 — flush 하면 그대로 반영된다.
  await w.flush();
  const thrice = files["Logs/log.md"];
  eq((thrice.match(/^- ⏸ /gm) ?? []).length, 1, "같은 내용은 묶음을 늘리지 않는다");
  eq((thrice.match(/- SKIP/g) ?? []).length, 1, "항목 줄도 한 벌만 남는다");
  eq((thrice.match(/^## /gm) ?? []).length, 1, "날짜 절도 그대로 하나");
  ok(thrice.includes("×3회"), "대신 횟수로 센다");

  // 내용이 달라지면 새 블록 — 그리고 이건 실제 변경이라 **제목**을 받는다
  await w.append("+1 ~0", [{ action: "CREATE", id: "a1" }], "편집 자동");
  const after = files["Logs/log.md"];
  eq((after.match(/^### /gm) ?? []).length, 1, "다른 내용은 새 run");
  eq((after.match(/^## /gm) ?? []).length, 1, "같은 날이면 절 제목은 한 줄뿐 ★");
  ok(after.includes("×3회"), "접힌 블록은 그대로 보존된다");

  // 같은 SKIP 이 다시 와도 이전 접힌 블록에 합치지 않는다(사이에 다른 일이 있었다)
  await w.append("+0 ~0 (skip 1)", skip, "편집 자동");
  await w.flush(); // 보류 전용 블록은 쌓였다가 나간다
  eq(
    (files["Logs/log.md"].match(/^- ⏸ /gm) ?? []).length,
    2,
    "끊긴 뒤의 반복은 새 묶음에서 다시 센다"
  );
  eq((files["Logs/log.md"].match(/^## /gm) ?? []).length, 1, "날짜 절은 여전히 하나");
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
  await w.flush(); // 반복은 메모리에 접히므로, 파일 반영은 flush 가 한다
  ok(
    files["Logs/log.md"].includes("사용자가 직접 적은 메모"),
    "남의 텍스트를 덮어쓰지 않는다"
  );
  eq((files["Logs/log.md"].match(/^- ⏸ /gm) ?? []).length, 2, "대신 새 묶음으로 붙인다");
  eq((files["Logs/log.md"].match(/^## /gm) ?? []).length, 1, "절 제목을 다시 적지는 않는다");
}

// --- 기기별 로그 파일 이름 ---
//
// 한 파일에 두 기기가 쓰면 Obsidian Sync의 텍스트 병합이 블록을 중복·재정렬하고 일부를
// 잃는다(2026-09-07 실측: 한 볼트 로그의 11%가 완전 중복, 시각 역전 6곳). 감지로 풀
// 문제가 아니라 **기록자를 하나로** 두는 문제다.
{
  eq(
    withDeviceTag("Logs/GCal 동기화 로그.md", "HJMoon"),
    "Logs/GCal 동기화 로그 (HJMoon).md",
    "확장자 앞에 태그를 붙인다"
  );
  eq(
    withDeviceTag("Logs/log", "집PC"),
    "Logs/log (집PC)",
    "확장자가 없으면 끝에 붙인다"
  );
  eq(
    withDeviceTag("a.b/log", "PC"),
    "a.b/log (PC)",
    "점이 폴더명에만 있으면 확장자로 보지 않는다"
  );
  eq(
    withDeviceTag("log.md", "DESKTOP-8RL6HT9"),
    "log (DESKTOP-8RL6HT9).md",
    "루트 경로도 된다"
  );
  // 태그는 사람이 고칠 수 있는 값이다 — 경로 구분자나 금지문자가 들어오면 파일이 엉뚱한
  // 곳에 생기거나 쓰기가 실패한다.
  eq(
    withDeviceTag("Logs/log.md", "a/b:c*?"),
    "Logs/log (a-b-c--).md",
    "파일명에 못 쓰는 문자는 치환한다"
  );
  eq(withDeviceTag("Logs/log.md", "   "), "Logs/log.md", "빈 태그면 그대로 둔다");
  ok(
    withDeviceTag("Logs/log.md", "x".repeat(80)).length < 60,
    "지나치게 긴 태그는 자른다"
  );
  // 두 기기는 반드시 서로 다른 파일에 쓴다 — 이게 이 함수의 존재 이유다.
  ok(
    withDeviceTag("Logs/log.md", "A") !== withDeviceTag("Logs/log.md", "B"),
    "기기가 다르면 파일도 다르다 ★"
  );
}

// --- 크기 상한: 바이트 기준으로 잘린다 ---
//
// 상한은 바이트(adapter.stat)인데 자를 위치는 문자 인덱스다. 예전엔 이 둘을 섞어서
// 한국어 로그가 상한을 33% 넘겨도 아무것도 안 잘린 채 "잘라냈다" 안내만 찍혔다
// (2026-09-07 실측: 512KB 상한에 563KB 파일). 이 블록이 그 회귀 감지선이다.
{
  const { app, files } = fakeVault();
  const LIMIT_KB = 1;
  const w = new SyncLogWriter(app, () => ({
    enabled: true,
    path: "Logs/log.md",
    maxKB: LIMIT_KB,
    logSkips: true,
  }));
  // 내용을 매번 다르게 해야 접기(× N회)가 아니라 새 블록이 쌓인다. 트림은 flush 안에서 돈다.
  for (let n = 0; n < 40; n++) {
    await w.append("+0 ~0", [{ action: "SKIP", detail: `볼트 동기화 중 ${n}번째 보류` }], "주기(5분)");
  }
  await w.flush(); // 보류 전용은 쌓이므로, 파일에 반영해야 트림이 돈다
  const text = files["Logs/log.md"];
  const bytes = new TextEncoder().encode(text).length;
  ok(bytes <= LIMIT_KB * 1024, `상한(바이트) 이하로 잘린다 — 실제 ${bytes}B ★`);
  ok(bytes > text.length, "한국어라 바이트가 문자 수보다 크다(전제 확인)");
  ok(!text.includes("0번째 보류"), "오래된 앞부분이 실제로 사라졌다");
  ok(text.includes("39번째 보류"), "최근 기록은 남는다");
  eq((text.match(/KB 상한/g) ?? []).length, 1, "트림 안내는 하나만 남는다");
  // 항목 중간에서 끊기면 반쪽 기록이 오해를 만든다 → 블록 경계에서만 자른다.
  // (`## ` 를 본문에서 찾지 말 것 — 범례가 구조 설명으로 그 문자열을 품고 있다.)
  const afterNotice = text.slice(text.indexOf("KB 상한"));
  ok(
    (afterNotice.split("\n").find((l) => l.startsWith("## ")) ?? "").startsWith("## 2"),
    "잘린 지점이 블록 경계다"
  );
  // ★ 이 40개는 전부 조용하고 전부 같은 날이다 → 남은 구간에 날짜 경계가 없다.
  //   그래서 묶음 경계에서 자르고 **품고 있던 날짜 제목을 되살리는** 폴백 경로를 탄다.
  //   되살리지 않으면 살아남은 기록이 "언제 것인지 알 수 없는" 고아가 된다.
  ok(
    /\n## \d{4}-\d{2}-\d{2} \([일월화수목금토]\)\n\n- ⏸ /.test(text),
    "하루가 예산보다 크면 날짜 제목을 되살리고 묶음 경계에서 자른다 ★"
  );
  eq((text.match(/^## /gm) ?? []).length, 1, "되살린 제목은 하나뿐(중복 안 만든다)");
}

// 상한 안이면 손대지 않는다 — 안 잘랐는데 "잘라냈다"고 적으면 로그를 못 믿게 된다.
{
  const { app, files } = fakeVault();
  const w = new SyncLogWriter(app, () => ({
    enabled: true,
    path: "Logs/log.md",
    maxKB: 512,
    logSkips: true,
  }));
  await w.append("+0 ~0", [{ action: "SKIP", detail: "볼트 동기화 중" }], "편집 자동");
  ok(!files["Logs/log.md"].includes("KB 상한"), "상한 안이면 트림 안내가 없다");
}

// --- 날짜 절: 하루에 한 줄 ---
//
// Outline 의 1단은 날짜뿐이어야 날짜로 접어 훑을 수 있다. 절 제목이 두 번 열리면
// 같은 날이 두 덩이로 갈라져 "그날 무슨 일이 있었나"를 한눈에 못 본다.
{
  const { app, files } = fakeVault();
  const clock = { t: new Date(2026, 8, 11, 14, 2, 7) }; // 2026-09-11 (금)
  const cfg = () => ({
    enabled: true,
    path: "Logs/log.md",
    maxKB: 512,
    logSkips: true,
  });
  const w = new SyncLogWriter(app, cfg, () => clock.t);

  await w.append("+1", [{ action: "CREATE", id: "a1", title: "빨래" }], "편집 자동");
  clock.t = new Date(2026, 8, 11, 14, 3, 10);
  await w.append("+0 ~1", [{ action: "UPDATE", id: "a2", title: "설거지" }], "수동(리본)");
  clock.t = new Date(2026, 8, 11, 16, 24, 8);
  await w.append("-1", [{ action: "DELETE", id: "a3", title: "우유" }], "보류 해제 후속");
  const sameDay = files["Logs/log.md"];
  eq((sameDay.match(/^## /gm) ?? []).length, 1, "같은 날 run 셋 → 절 제목 하나 ★");
  eq((sameDay.match(/^### /gm) ?? []).length, 3, "run 은 셋 다 제목을 받는다");
  ok(sameDay.includes("## 2026-09-11 (금)"), "절 제목에 요일까지 적는다");
  ok(
    sameDay.indexOf("## 2026-09-11") < sameDay.indexOf("### 14:02:07"),
    "절 제목이 그날 첫 run 보다 앞에 온다"
  );

  clock.t = new Date(2026, 8, 12, 21, 16, 21);
  await w.append("+1", [{ action: "CREATE", id: "a4", title: "재활용" }], "보류 해제 후속");
  const nextDay = files["Logs/log.md"];
  eq((nextDay.match(/^## /gm) ?? []).length, 2, "날짜가 바뀌면 절이 하나 더");
  ok(nextDay.includes("## 2026-09-12 (토)"), "요일도 날짜대로");

  // ★ 로드 직후엔 tail 도 절 제목도 모른다 → **파일이 답해야 한다.** 기억으로 때우면
  //   재시작마다 같은 날 절이 다시 열린다(하루가 두 덩이로 갈라진다).
  const w2 = new SyncLogWriter(app, cfg, () => clock.t);
  clock.t = new Date(2026, 8, 12, 22, 0, 0);
  await w2.append("+0 ~1", [{ action: "UPDATE", id: "a5", title: "청소" }], "편집 자동");
  eq(
    (files["Logs/log.md"].match(/^## /gm) ?? []).length,
    2,
    "재시작 후 같은 날에 써도 절은 안 늘어난다 ★★"
  );
  clock.t = new Date(2026, 8, 13, 9, 0, 0);
  await w2.append("+1", [{ action: "CREATE", id: "a6", title: "장보기" }], "시작 시");
  eq(
    (files["Logs/log.md"].match(/^## /gm) ?? []).length,
    3,
    "그 뒤 날짜가 바뀌면 제대로 새 절"
  );
}

// --- 접기는 자정을 넘지 않는다 ---
//
// 접힌 블록은 날짜 절 하나 안에 산다. 예전엔 `19:36:10 ~ 02:41:57 ×356회`(실측) 가
// 나왔는데 어느 절에 넣어도 거짓이다.
{
  const { app, files } = fakeVault();
  const clock = { t: new Date(2026, 8, 11, 23, 59, 50) };
  const w = new SyncLogWriter(
    app,
    () => ({ enabled: true, path: "Logs/log.md", maxKB: 512, logSkips: true }),
    () => clock.t
  );
  const skip: SyncLogEntry[] = [{ action: "SKIP", detail: "볼트 동기화 중" }];
  await w.append("+0 ~0 (skip 1)", skip, "주기(5분)");
  clock.t = new Date(2026, 8, 12, 0, 0, 10);
  await w.append("+0 ~0 (skip 1)", skip, "주기(5분)");
  await w.flush();
  const text = files["Logs/log.md"];
  eq((text.match(/^- ⏸ /gm) ?? []).length, 2, "자정을 넘으면 접지 않는다 ★");
  eq((text.match(/^## /gm) ?? []).length, 2, "각자 제 날짜 절 밑에 있다");
  ok(!text.includes("×2회"), "그래서 한 묶음으로 세지 않는다");
}

// --- 접기 연장이 절 제목을 다시 적지 않는다 ---
//
// 절 제목이 블록 렌더에 들어가면 rewriteTail 의 endsWith 열쇠가 어긋나 접기가
// "중복 블록 append" 로 폴백한다 — 0.8.0 이 없앤 바로 그 손상이다. 이 테스트가 감지선.
{
  const { app, files } = fakeVault();
  const clock = { t: new Date(2026, 8, 12, 10, 0, 0) };
  const w = new SyncLogWriter(
    app,
    () => ({ enabled: true, path: "Logs/log.md", maxKB: 512, logSkips: true }),
    () => clock.t
  );
  const hold: SyncLogEntry[] = [{ action: "HOLD", id: "z9", detail: "⏸ 콜드 스타트" }];
  await w.append("+0 ~0 (skip 1)", hold, "시작 시");
  clock.t = new Date(2026, 8, 12, 10, 0, 25);
  await w.append("+0 ~0 (skip 1)", hold, "주기(5분)");
  await w.flush();
  const text = files["Logs/log.md"];
  eq((text.match(/^## /gm) ?? []).length, 1, "절 제목은 하나 ★★");
  eq((text.match(/^- ⏸ /gm) ?? []).length, 1, "묶음도 하나(접혔다)");
  ok(text.includes("×2회"), "횟수로 센다");
  ok(text.includes("  - HOLD `z9`"), "보류 사유는 자식 줄로 남는다(진단 경로)");
  eq((text.match(/^### /gm) ?? []).length, 0, "조용한 run 은 Outline 에 안 뜬다 ★");
}

// --- 트림은 날짜 경계를 우선한다 ---
//
// `### ` 에서 자르면 살아남은 run 이 날짜 없는 고아가 된다 — "언제 것인지 알 수 없는
// 변경"은 이 파일의 존재 이유(사후 추적)를 무너뜨린다.
{
  const { app, files } = fakeVault();
  const LIMIT_KB = 1;
  const clock = { t: new Date(2026, 8, 10, 9, 0, 0) };
  const w = new SyncLogWriter(
    app,
    () => ({ enabled: true, path: "Logs/log.md", maxKB: LIMIT_KB, logSkips: true }),
    () => clock.t
  );
  for (let d = 0; d < 4; d++) {
    for (let n = 0; n < 8; n++) {
      clock.t = new Date(2026, 8, 10 + d, 9 + n, 0, 0);
      await w.append(
        "+1",
        [{ action: "CREATE", id: `k${d}${n}`, title: `${d}일차 ${n}번째 할 일 제목` }],
        "주기(5분)"
      );
    }
  }
  const text = files["Logs/log.md"];
  ok(
    new TextEncoder().encode(text).length <= LIMIT_KB * 1024,
    "상한 이하로 잘린다"
  );
  ok(!text.includes("0일차"), "오래된 날이 실제로 사라졌다");
  ok(text.includes("3일차 7번째"), "최근 기록은 남는다");
  // 날짜 없는 고아 run 이 하나도 없어야 한다.
  let day = "";
  let orphans = 0;
  for (const line of text.split("\n")) {
    if (/^## \d{4}-\d{2}-\d{2} /.test(line)) day = line;
    else if (line.startsWith("### ") && !day) orphans++;
  }
  eq(orphans, 0, "잘린 뒤에도 모든 run 이 제 날짜 절 밑에 있다 ★");
  const afterNotice = text.slice(text.indexOf("KB 상한"));
  ok(
    /^## \d{4}-\d{2}-\d{2} \([일월화수목금토]\)$/m.test(
      afterNotice.split("\n").find((l) => l.startsWith("## ")) ?? ""
    ),
    "잘린 지점이 날짜 절 경계다 ★"
  );
}

// --- 옛 포맷 파일에 새 포맷으로 덧붙인다 ---
//
// 마이그레이션을 하지 않는다(이름 바꾸기·다시 쓰기가 곧 Sync 이벤트다). 옛 블록은
// 그대로 두고 새 기록만 새 모양으로 쌓이며, 트림으로 늙어 나간다.
{
  const oldBlock = "\n## 2026-08-10 09:00:00 · +1 ~0 ↔0 -0 ⬇0 · 주기(5분)\n- CREATE `x1` \"옛 것\"\n";
  const { app, files } = fakeVault({
    "Logs/log.md": "# Tasks ⇄ GCal 동기화 로그\n" + oldBlock,
  });
  const clock = { t: new Date(2026, 8, 12, 9, 0, 0) };
  const w = new SyncLogWriter(
    app,
    () => ({ enabled: true, path: "Logs/log.md", maxKB: 512, logSkips: true }),
    () => clock.t
  );
  await w.append("+1", [{ action: "CREATE", id: "n1", title: "새 것" }], "편집 자동");
  const text = files["Logs/log.md"];
  ok(text.includes(oldBlock), "옛 블록은 한 글자도 안 건드린다 ★");
  ok(
    text.indexOf("## 2026-09-12 (토)") < text.indexOf("### 09:00:00"),
    "새 run 앞에 날짜 절을 새로 연다 ★ (옛 블록의 하위 항목처럼 읽히면 안 된다)"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
})();
