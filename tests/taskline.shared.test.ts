/* @shared taskline v1.0.0 sha256:de4231fee605eebf13b41e181e98851de91172d7d20f0bbd162e17078e38c11f
 * 정본: tasks-gcal-sync-plugin/tests/taskline.shared.test.ts — 이 파일은 두 저장소에 **그대로** 복사된다.
 * 고칠 때: 정본 저장소에서만 고치고 → 헤더 버전을 올리고 → `node scripts/check-shared.mjs --write` → 복사. */
/*
 * TaskLine 공유 테스트 — tasks-gcal-sync 와 gcal-calendar-view 가 **같은 파일을 그대로** 돌린다.
 *
 * 두 플러그인이 같은 노트 쓰기 규칙(⏰ 삽입 위치 · 📅/🛫 치환 · 제목 정리)을 쓰는지 여기서 판정한다.
 * 그래서 이 파일은 공유 모듈(TaskLine · timeRange) 말고는 아무것도 import 하지 않고,
 * 단언 헬퍼도 인라인으로 둔다(tests/helpers 는 저장소마다 다르다).
 */
import {
  cleanTitle,
  isTaskLine,
  parseTaskLine,
  removeDone,
  removeDue,
  removeId,
  removeStart,
  removeTime,
  replaceTitle,
  setDoneDate,
  setDue,
  setId,
  setStart,
  setStatusChar,
  setTime,
} from "../src/shared/tasks/TaskLine";
import { isValidTimeRange, normalizeTimeRange } from "../src/shared/tasks/timeRange";

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

// --- 하드닝: 손상된 날짜 자가 치유 (날짜 뒤 잉여 숫자/하이픈 소거) ---
eq(
  setDue("- [ ] #task 데모 📅 2026-08-038-03 🆔 pgDvAD", "2026-08-03"),
  "- [ ] #task 데모 📅 2026-08-03 🆔 pgDvAD",
  "setDue: 손상된 날짜(2026-08-038-03)의 잉여까지 정리"
);
eq(
  removeDue("- [ ] #task 데모 📅 2026-08-038-03 🆔 pgDvAD"),
  "- [ ] #task 데모 🆔 pgDvAD",
  "removeDue: 손상 날짜도 통째로 제거"
);

// --- removeId: 반복 새 회차에 복사된 🆔 제거(중복 id 방지의 핵심) ---
eq(
  removeId("- [ ] #task 데모 📅 2026-08-10 🆔 abc123"),
  "- [ ] #task 데모 📅 2026-08-10",
  "removeId: 🆔 필드 제거, 나머지 보존"
);
eq(
  removeId("- [ ] #task 데모 📅 2026-08-10"),
  "- [ ] #task 데모 📅 2026-08-10",
  "removeId: 🆔 없으면 무변화"
);

// --- 미일정화 = removeId(removeDue(raw)) — TaskWriter.unschedule 이 쓰는 합성 (0.9.0~) ---
//
// GCal 에서 이벤트가 지워지면 매핑도 함께 폐기되므로 줄에 남은 🆔 는 아무것도 가리키지
// 않는 찌꺼기가 된다. 둘을 **한 번의 쓰기**로 떼어 modify 이벤트가 두 번 나지 않게 한다.
eq(
  removeId(removeDue("- [ ] #task 데모 📅 2026-08-10 🆔 abc123")),
  "- [ ] #task 데모",
  "미일정화: 📅 와 🆔 를 함께 뗀다 ★"
);
// 🛫·⏰ 는 남긴다 — 플러그인이 단독 소유한 적 없는 사용자 값이고,
// 날짜를 다시 주면 그대로 살아난다.
eq(
  removeId(removeDue("- [ ] #task 데모 ⏰ 09:00-10:00 🛫 2026-08-08 📅 2026-08-10 🆔 abc123")),
  "- [ ] #task 데모 ⏰ 09:00-10:00 🛫 2026-08-08",
  "미일정화: 🛫·⏰ 는 보존한다 ★"
);
// 순서가 반대여도(🆔 가 📅 앞) 같은 결과여야 한다.
eq(
  removeId(removeDue("- [ ] #task 데모 🆔 abc123 📅 2026-08-10")),
  "- [ ] #task 데모",
  "미일정화: 필드 순서와 무관"
);
// 정상 날짜는 그대로(잉여 없음)
eq(
  setDue(L3, "2026-07-24"),
  "- [ ] #task 주간(월간)보고 🔁 every week 🛫 2026-07-02 📅 2026-07-24 🆔 KRBgwN",
  "setDue: 정상 날짜는 잉여 없이 교체(하드닝 회귀 없음)"
);

// --- ⏰ 타임블록 ---
// 삽입 위치가 핵심이다: Tasks 는 필드 정규식을 "$" 앵커로 만들고 줄 끝에서부터 벗겨내므로,
// 모르는 토큰이 줄 끝에 있으면 그 앞의 📅🛫 까지 통째로 설명으로 흡수된다.
const T0 = "- [ ] #task 보고서 작성 📅 2026-08-20 🆔 ab12cd";
const T1 = setTime(T0, "14:00-15:00");
eq(
  T1,
  "- [ ] #task 보고서 작성 ⏰ 14:00-15:00 📅 2026-08-20 🆔 ab12cd",
  "setTime: 첫 필드 이모지(📅) 앞에 삽입 — 줄 끝 append 금지"
);
eq(parseTaskLine(T1, F)!.time, "14:00-15:00", "parse: 범위");
eq(parseTaskLine(T1, F)!.due, "2026-08-20", "⏰ 가 있어도 due 파싱 정상");
eq(parseTaskLine(T1, F)!.id, "ab12cd", "⏰ 가 있어도 id 파싱 정상");
eq(parseTaskLine(T1, F)!.title, "보고서 작성", "cleanTitle: ⏰ 제거");

eq(removeTime(T1), T0, "removeTime: 원본으로 되돌아감");
eq(
  setTime(T1, "09:30-10:00"),
  "- [ ] #task 보고서 작성 ⏰ 09:30-10:00 📅 2026-08-20 🆔 ab12cd",
  "setTime: 교체 시 중복 생성 안 함"
);

// 파싱 정규화 (손으로 적힌 값도 안전하게 읽는다)
eq(parseTaskLine("- [ ] #task 데모 ⏰ 14:00 📅 2026-08-20", F)!.time, "14:00-15:00", "parse: 종료 생략 → +1시간");
eq(parseTaskLine("- [ ] #task 데모 ⏰ 14:00-13:00 📅 2026-08-20", F)!.time, "14:00-15:00", "parse: 역전 범위 보정");
eq(parseTaskLine("- [ ] #task 데모 ⏰ 9:05-9:35 📅 2026-08-20", F)!.time, "09:05-09:35", "parse: 한 자리 시 정규화");
eq(parseTaskLine("- [ ] #task 데모 ⏰ 23:30 📅 2026-08-20", F)!.time, "23:30-23:59", "parse: 자정 넘김은 23:59 로 자름");
eq(parseTaskLine(T0, F)!.time, undefined, "parse: ⏰ 없으면 undefined");

// 필드가 없는 줄 / 🛫만 있는 줄
eq(setTime("- [ ] #task 메모", "07:00-08:00"), "- [ ] #task 메모 ⏰ 07:00-08:00", "setTime: 필드 없으면 줄 끝");
eq(
  setTime("- [ ] #task 준비 🛫 2026-08-01", "10:00-11:00"),
  "- [ ] #task 준비 ⏰ 10:00-11:00 🛫 2026-08-01",
  "setTime: 🛫 앞에 삽입"
);

// 🔁 반복 문장이 ⏰ 를 삼키지 않는다 (FIELD_LOOKAHEAD 에 ⏰ 를 넣은 효과)
const Trec = "- [ ] #task 청소 ⏰ 07:45-08:45 🔁 every week 📅 2026-08-15";
eq(parseTaskLine(Trec, F)!.recurrence, "every week", "🔁 파싱: ⏰ 와 공존");
eq(parseTaskLine(Trec, F)!.time, "07:45-08:45", "⏰ 파싱: 🔁 와 공존");
eq(parseTaskLine(Trec, F)!.title, "청소", "제목: ⏰·🔁 모두 제거");
// 반대 순서(🔁 가 앞)에서도 반복 문장이 ⏰ 앞에서 끊긴다
const Trec2 = "- [ ] #task 청소 🔁 every week ⏰ 07:45-08:45 📅 2026-08-15";
eq(parseTaskLine(Trec2, F)!.recurrence, "every week", "🔁 문장이 ⏰ 앞에서 끊긴다");
eq(parseTaskLine(Trec2, F)!.time, "07:45-08:45", "⏰ 가 🔁 뒤에 있어도 파싱");

// --- 시각 헬퍼 ---
eq(isValidTimeRange("14:00-15:00"), true, "isValidTimeRange 정상");
eq(isValidTimeRange("15:00-14:00"), false, "isValidTimeRange 역전 거부");
eq(isValidTimeRange("14:00"), false, "isValidTimeRange 범위 아님 거부");
eq(isValidTimeRange("24:00-25:00"), false, "isValidTimeRange 24시 거부");
eq(isValidTimeRange(undefined), false, "isValidTimeRange undefined");
eq(normalizeTimeRange("9:05"), "09:05-10:05", "normalizeTimeRange 기본 1시간");
// --- isTaskLine: 체크박스 줄 모양만 본다(필터 태그와 무관) ---
eq(isTaskLine("- [ ] 아무 일"), true, "isTaskLine: 기본");
eq(isTaskLine("    * [x] 들여쓴 완료"), true, "isTaskLine: 들여쓰기 · * 불릿");
eq(isTaskLine("+ [/] 진행 중"), true, "isTaskLine: + 불릿 · 임의 상태 문자");
eq(isTaskLine("- [] 빈 괄호"), false, "isTaskLine: 상태 문자 없음 거부");
eq(isTaskLine("-[ ] 공백 없음"), false, "isTaskLine: 불릿 뒤 공백 필수");
eq(isTaskLine("그냥 문장"), false, "isTaskLine: 체크박스 아님");

// --- 🛫 start 재작성 ---
eq(
  setStart("- [ ] #task 준비 📅 2026-08-20 🆔 ab12cd", "2026-08-18"),
  "- [ ] #task 준비 📅 2026-08-20 🆔 ab12cd 🛫 2026-08-18",
  "setStart: 없으면 줄 끝에 추가"
);
eq(
  setStart("- [ ] #task 준비 🛫 2026-08-01 📅 2026-08-20", "2026-08-18"),
  "- [ ] #task 준비 🛫 2026-08-18 📅 2026-08-20",
  "setStart: 있으면 제자리 교체"
);
eq(
  setStart("- [ ] #task 준비 🛫 2026-08-018-01 📅 2026-08-20", "2026-08-18"),
  "- [ ] #task 준비 🛫 2026-08-18 📅 2026-08-20",
  "setStart: 손상 날짜 잉여까지 정리"
);
eq(
  removeStart("- [ ] #task 준비 🛫 2026-08-01 📅 2026-08-20"),
  "- [ ] #task 준비 📅 2026-08-20",
  "removeStart: 🛫 만 제거"
);
eq(removeStart("- [ ] #task 준비 📅 2026-08-20"), "- [ ] #task 준비 📅 2026-08-20", "removeStart: 없으면 무변화");

// --- replaceTitle: 정확히 1회 매칭될 때만 ---
eq(
  replaceTitle("- [ ] #task 보고서 작성 📅 2026-08-20", "보고서 작성", "  주간 보고  "),
  "- [ ] #task 주간 보고 📅 2026-08-20",
  "replaceTitle: 1회 매칭 교체 · 새 제목 trim"
);
eq(replaceTitle("- [ ] #task 보고서 📅 2026-08-20", "회의", "x"), null, "replaceTitle: 0회 → null");
eq(replaceTitle("- [ ] #task 보고 보고 📅 2026-08-20", "보고", "x"), null, "replaceTitle: 2회 이상 → null");
eq(replaceTitle("- [ ] #task 보고 📅 2026-08-20", "   ", "x"), null, "replaceTitle: 빈 제목 → null");

// --- cleanTitle: ⛔ 의존 · 우선순위 · ⏳ ---
eq(
  cleanTitle("#task 배포 ⛔ abc123,def456 🔺 ⏳ 2026-08-19 📅 2026-08-20", F),
  "배포",
  "cleanTitle: ⛔ 목록 · 우선순위 · ⏳ 제거"
);
eq(cleanTitle("#task/sheet 시트 정리 ⏬", F), "시트 정리", "cleanTitle: 필터 하위태그 · 낮은 우선순위 제거");
eq(cleanTitle("#task 필터 없음 모드", ""), "#task 필터 없음 모드", "cleanTitle: 필터가 비면 태그를 남긴다");

// --- ★ 정본 규칙: 📆 🗓 ⌛ 는 필드 이모지가 아니다 ---
// gcal-calendar-view 의 옛 쓰기 경로는 셋을 필드로 봐서 ⏰ 삽입 위치가 달랐다.
// 정본을 바꾸는 것은 공유 버전 major 이고 리팩토링 릴리스가 할 일이 아니다 — 지금 규칙을 못 박는다.
eq(
  setTime("- [ ] #task 회의 📆 2026-08-20", "09:00-10:00"),
  "- [ ] #task 회의 📆 2026-08-20 ⏰ 09:00-10:00",
  "📆 는 필드가 아니다 → ⏰ 를 줄 끝에"
);
eq(
  setTime("- [ ] #task 회의 🗓 2026-08-20 📅 2026-08-21", "09:00-10:00"),
  "- [ ] #task 회의 🗓 2026-08-20 ⏰ 09:00-10:00 📅 2026-08-21",
  "🗓 는 건너뛰고 📅 앞에"
);
eq(
  setTime("- [ ] #task 회의 ⌛ 2026-08-20", "09:00-10:00"),
  "- [ ] #task 회의 ⌛ 2026-08-20 ⏰ 09:00-10:00",
  "⌛ 는 필드가 아니다 → ⏰ 를 줄 끝에"
);
eq(parseTaskLine("- [ ] #task 회의 📆 2026-08-20", F)!.due, undefined, "📆 는 due 로 읽지 않는다");

// --- 완료 필드 헬퍼: 들여쓰기·이미 있는 값 ---
eq(setStatusChar("    - [ ] 하위 일", "x"), "    - [x] 하위 일", "setStatusChar: 들여쓰기 보존");
eq(
  setDoneDate("- [x] #task 끝 ✅ 2026-08-01", "2026-08-20"),
  "- [x] #task 끝 ✅ 2026-08-01",
  "setDoneDate: 이미 있으면 무변화"
);
eq(removeDone("- [x] #task 끝"), "- [x] #task 끝", "removeDone: 없으면 무변화");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
