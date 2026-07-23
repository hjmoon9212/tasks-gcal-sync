import {
  parseTaskLine,
  setDue,
  removeDue,
  setId,
  setStatusChar,
  setDoneDate,
  removeDone,
  cleanTitle,
} from "../src/data/TaskLine";
import { resolveCalendar } from "../src/settings/Settings";
import { addDays, daysBetween, shiftDateTime } from "../src/sync/dates";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${msg}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
  }
}

const F = "#task";

// 사용자의 실제 task 줄 샘플
const L1 = "- [x] #task 민감정보 로컬 파일로 관리 🆔 AhynA8 📅 2026-05-04 ✅ 2026-05-04";
const L2 = "- [/] #task/sheet #865 월보고 관련 이슈 🆔 TYk4UP ➕ 2026-05-06 🛫 2026-05-15";
const L3 = "- [ ] #task 주간(월간)보고 🔁 every week 🛫 2026-07-02 📅 2026-07-03 🆔 KRBgwN";
const L4 = "- [ ] #task EMAIL - 일일보고 🔁 every weekday 📅 2026-06-29 🆔 r5jO71";

// --- 파싱 ---
const p1 = parseTaskLine(L1, F)!;
eq(p1.checked, true, "L1 checked");
eq(p1.statusChar, "x", "L1 status");
eq(p1.id, "AhynA8", "L1 id");
eq(p1.due, "2026-05-04", "L1 due");
eq(p1.done, "2026-05-04", "L1 done");
eq(p1.title, "민감정보 로컬 파일로 관리", "L1 title cleaned");

const p2 = parseTaskLine(L2, F)!;
eq(p2.statusChar, "/", "L2 in-progress status");
eq(p2.checked, false, "L2 not checked");
eq(p2.id, "TYk4UP", "L2 id");
eq(p2.start, "2026-05-15", "L2 start");
eq(p2.created, "2026-05-06", "L2 created");
eq(p2.due, undefined, "L2 no due");
eq(p2.title, "#865 월보고 관련 이슈", "L2 title keeps #865 tag, strips #task/sheet");

const p3 = parseTaskLine(L3, F)!;
eq(p3.recurrence, "every week", "L3 recurrence");
eq(p3.due, "2026-07-03", "L3 due");
eq(p3.start, "2026-07-02", "L3 start");
eq(p3.id, "KRBgwN", "L3 id");
eq(p3.title, "주간(월간)보고", "L3 title strips recurrence");

const p4 = parseTaskLine(L4, F)!;
eq(p4.recurrence, "every weekday", "L4 recurrence");
eq(p4.due, "2026-06-29", "L4 due");
eq(p4.title, "EMAIL - 일일보고", "L4 title");

// globalFilter 미일치 → null
eq(parseTaskLine("- [ ] 그냥 메모", F), null, "non-task filtered");

// --- 수술적 재작성: due만 바뀌고 나머지 보존 ---
const L3moved = setDue(L3, "2026-07-10");
eq(
  L3moved,
  "- [ ] #task 주간(월간)보고 🔁 every week 🛫 2026-07-02 📅 2026-07-10 🆔 KRBgwN",
  "setDue replaces only 📅, preserves 🔁🛫🆔"
);
const p3b = parseTaskLine(L3moved, F)!;
eq(p3b.recurrence, "every week", "after setDue recurrence intact");
eq(p3b.id, "KRBgwN", "after setDue id intact");
eq(p3b.start, "2026-07-02", "after setDue start intact");

// due 없는 줄에 setDue → 끝에 추가
const L2due = setDue(L2, "2026-08-01");
eq(parseTaskLine(L2due, F)!.due, "2026-08-01", "setDue appends when missing");
eq(parseTaskLine(L2due, F)!.id, "TYk4UP", "append keeps id");

// removeDue
const L4nodue = removeDue(L4);
eq(parseTaskLine(L4nodue, F)!.due, undefined, "removeDue clears due");
eq(parseTaskLine(L4nodue, F)!.recurrence, "every weekday", "removeDue keeps recurrence");

// setId: 없을 때만 추가
const noId = "- [ ] #task 신규 할일 📅 2026-09-01";
const withId = setId(noId, "Zz9Yy8");
eq(parseTaskLine(withId, F)!.id, "Zz9Yy8", "setId adds id");
eq(setId(L1, "XXXXXX"), L1, "setId no-op when id exists");

// setStatusChar
eq(
  setStatusChar("- [ ] #task 할일 📅 2026-09-01", "x"),
  "- [x] #task 할일 📅 2026-09-01",
  "setStatusChar to done"
);

// --- 완료/취소 (Phase 2 pull) ---
const open = "- [ ] #task 보고서 작성 📅 2026-07-05 🆔 Aa1234";
const completed = setDoneDate(setStatusChar(open, "x"), "2026-07-05");
eq(
  completed,
  "- [x] #task 보고서 작성 📅 2026-07-05 🆔 Aa1234 ✅ 2026-07-05",
  "complete: 상태 x + ✅ 추가, 나머지 보존"
);
const reopened = removeDone(setStatusChar(completed, " "));
eq(
  reopened,
  "- [ ] #task 보고서 작성 📅 2026-07-05 🆔 Aa1234",
  "uncomplete: 상태 공백 + ✅ 제거, 나머지 보존"
);
eq(setDoneDate(completed, "2026-08-01"), completed, "setDoneDate no-op when ✅ exists");

// --- 태그 파싱 ---
eq(parseTaskLine(L1, F)!.tags, ["#task"], "L1 tags");
eq(parseTaskLine(L2, F)!.tags, ["#task/sheet", "#865"], "L2 tags");
const Lg = "- [ ] #task #gcal/Growth 운동하기 📅 2026-07-01 🆔 Gg1234";
eq(parseTaskLine(Lg, F)!.tags, ["#task", "#gcal/Growth"], "gcal tag parsed");

// --- resolveCalendar 라우팅 (#gcal/캘린더명) ---
const settings: any = {
  routingTagPrefix: "#gcal/",
  rules: [
    // 보정 규칙: 태그명(개인)과 실제 캘린더명(개인 일정)이 다른 경우
    { tag: "개인", calendarId: "personal@cal", calendarName: "개인 일정" },
  ],
  calendars: [
    { id: "growth@cal", name: "Growth" },
    { id: "works@cal", name: "Works" },
  ],
  defaultCalendarId: "default@cal",
  defaultCalendarName: "Default",
};
eq(resolveCalendar(["#task", "#gcal/Growth"], settings)?.id, "growth@cal", "auto-match by name");
eq(resolveCalendar(["#task", "#gcal/works"], settings)?.id, "works@cal", "auto-match case-insensitive");
eq(resolveCalendar(["#task", "#gcal/개인"], settings)?.id, "personal@cal", "rule override by name");
eq(resolveCalendar(["#task"], settings)?.id, "default@cal", "no gcal tag → default");
eq(resolveCalendar(["#task", "#gcal/Unknown"], settings)?.id, "default@cal", "unknown name → default");
eq(
  resolveCalendar(["#task", "#gcal/Growth"], {
    routingTagPrefix: "#gcal/",
    rules: [],
    calendars: [],
    defaultCalendarId: "",
    defaultCalendarName: "",
  } as any),
  null,
  "no match, no default → null"
);

// --- 날짜 헬퍼 (타임블록 보존) ---
eq(addDays("2026-07-05", 5), "2026-07-10", "addDays +5");
eq(addDays("2026-07-31", 1), "2026-08-01", "addDays 월넘김");
eq(daysBetween("2026-07-05", "2026-07-10"), 5, "daysBetween");
eq(daysBetween("2026-07-10", "2026-07-05"), -5, "daysBetween 음수");
eq(
  shiftDateTime("2026-07-05T14:00:00+09:00", 5),
  "2026-07-10T14:00:00+09:00",
  "shiftDateTime 시각·오프셋 유지하며 날짜만 이동"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
