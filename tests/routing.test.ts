/*
 * 라우팅(#gcal/캘린더명)과 이 저장소 전용 날짜 헬퍼.
 * TaskLine 공유 테스트(taskline.shared.test.ts)에서 떼어 냈다 — 여기는 gcal-calendar-view 로 복사되지 않는다.
 */
import { resolveCalendar } from "../src/settings/Settings";
import {
  addDays,
  daysBetween,
  shiftDateTime,
  timeOfDateTime,
  toDateTime,
} from "../src/sync/dates";
import { eq, done } from "./helpers/assert";

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

eq(timeOfDateTime("2026-08-20T14:00:00+09:00"), "14:00", "timeOfDateTime");
eq(timeOfDateTime("2026-08-20"), undefined, "timeOfDateTime 날짜만이면 undefined");
eq(toDateTime("2026-08-20", "9:05"), "2026-08-20T09:05:00", "toDateTime 패딩");

done();
