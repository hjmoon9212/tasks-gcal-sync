/**
 * 노트 task ↔ GCal 이벤트의 **날짜·시각 매핑**. 순수 함수 — 파일도 네트워크도 설정도 안 본다.
 *
 * SyncEngine 에서 그대로 옮겼다(0.12.3). ⛔ `taskTime` 은 시각의 **단일 관문**이다 —
 * push(timedDates) · 스냅샷(tgsTime) · 비교(localView.time)가 전부 이 값을 본다.
 */
import { GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import {
  addDay,
  addDays,
  daysBetween,
  isValidTimeRange,
  localTimeZone,
  shiftDateTime,
  timeOfDateTime,
  toDateTime,
} from "../dates";

/** 마지막으로 합의한 날짜·시각(record 의 일부). datePatch 가 "무엇이 바뀌었나" 의 기준으로 쓴다. */
export interface DatesSnapshot {
  due: string;
  start?: string;
  time?: string;
}

/** 이벤트 시작일: 🛫 start가 있고 due보다 같거나 앞이면 start, 아니면 due. (다중일 블록 시작) */
export function spanStart(t: VaultTask): string {
  if (t.start && t.due && t.start <= t.due) return t.start;
  return t.due!;
}

/** 종일/시간지정 모두에서 시작 날짜(YYYY-MM-DD) 추출. */
export function eventStartDate(ev: GCalEvent): string | undefined {
  if (ev.start?.date) return ev.start.date;
  if (ev.start?.dateTime) return ev.start.dateTime.slice(0, 10);
  return undefined;
}

/** 이벤트에서 due(마감일) 추출: all-day는 end.date(배타적)−1, 시간지정은 end 날짜(없으면 start). */
export function eventDueDate(ev: GCalEvent): string | undefined {
  if (ev.end?.date) return addDays(ev.end.date, -1);
  if (ev.end?.dateTime) return ev.end.dateTime.slice(0, 10);
  return eventStartDate(ev);
}

/**
 * 이벤트의 타임블록 "HH:MM-HH:MM". 종일이면 "", 판정 불가면 undefined.
 *
 * 양끝이 모두 dateTime 일 때만 시각으로 인정한다. 한쪽만 dateTime 인 혼합형은
 * (iPhone 기본 캘린더 등이 만든다) 애초에 patch 하면 400 이 나는 모양이라 손대지 않는다.
 * 자정을 넘기거나 여러 날에 걸친 시간지정 이벤트도 "HH:MM-HH:MM" 한 줄로는 표현할 수
 * 없으므로 판정 불가로 둔다 — 억지로 접으면 노트의 ⏰ 를 엉뚱한 값으로 덮어쓴다.
 */
export function eventTimeRange(ev: GCalEvent): string | undefined {
  if (ev.start?.date && ev.end?.date) return "";
  const s = ev.start?.dateTime;
  const e = ev.end?.dateTime;
  if (!s || !e) return undefined;
  const st = timeOfDateTime(s);
  const et = timeOfDateTime(e);
  if (!st || !et) return undefined;
  const range = `${st}-${et}`;
  return isValidTimeRange(range) ? range : undefined;
}

/** 🛫 가 📅 보다 앞서 이벤트가 여러 날에 걸치는가. (같은 날이면 하루짜리) */
export function isMultiDay(t: VaultTask): boolean {
  return !!(t.start && t.due && t.start < t.due);
}

/**
 * 노트의 타임블록("" = 종일). 유효하지 않은 값은 종일로 본다.
 *
 * **다중일(🛫 < 📅)이면 ⏰ 가 있어도 종일로 본다.** GCal 의 시간지정 이벤트는
 * "첫날 시작시각 → 마지막날 종료시각" 한 덩어리라, ⏰ 09:00-11:00 에 🛫/📅 가 3일이면
 * 매일 09-11시가 아니라 50시간짜리 통짜 블록이 된다. "여러 날 · 매일 같은 시간대"는
 * 반복 이벤트라야 표현되므로, 표현 못 하는 것을 억지로 만들지 않고 종일 다중일 블록으로 둔다.
 *
 * 노트의 ⏰ 는 지우지 않는다 — 🛫 를 떼거나 📅 를 당겨 하루짜리로 돌아오면 시각이 그대로
 * 살아난다. 이 함수가 시각의 **단일 관문**이라 여기서 "" 를 주면 push(timedDates) ·
 * 스냅샷(tgsTime) · 비교(local.time)가 모두 같은 값을 보고, 노트와 이벤트가 서로 밀지 않는다.
 */
export function taskTime(t: VaultTask): string {
  if (isMultiDay(t)) return "";
  return isValidTimeRange(t.time) ? t.time : "";
}

/**
 * ⏰ 가 있으면 시간지정 이벤트의 start/end 를, 없으면 null.
 * timeZone 을 반드시 함께 보낸다 — 안 보내면 캘린더 기본 타임존으로 해석돼
 * 기기 타임존이 다를 때 시각이 밀린다(DST 포함).
 */
export function timedDates(t: VaultTask): Partial<GCalEvent> | null {
  const range = taskTime(t);
  if (!range) return null;
  const [st, et] = range.split("-");
  const tz = localTimeZone();
  return {
    start: { dateTime: toDateTime(spanStart(t), st), timeZone: tz },
    end: { dateTime: toDateTime(t.due!, et), timeZone: tz },
  };
}

/** 노트의 날짜·시각이 마지막 스냅샷과 달라졌나 — 그때만 이벤트를 다시 읽고 날짜를 싣는다. */
export function datesChanged(rec: DatesSnapshot, task: VaultTask): boolean {
  return (
    task.due !== rec.due ||
    spanStart(task) !== (rec.start ?? rec.due) ||
    taskTime(task) !== (rec.time ?? "")
  );
}

/**
 * 날짜가 바뀐 push 에 실을 start/end. `cur` 는 방금 읽은 이벤트(못 읽었으면 undefined → 종일).
 * 결과는 아직 exclusiveDates 를 거치지 않은 모양이다.
 */
export function datePatch(
  rec: DatesSnapshot,
  task: VaultTask,
  cur?: GCalEvent
): Partial<GCalEvent> {
  // 노트에 ⏰ 가 있으면 그 값이 이긴다 — 시각도 노트가 소유하는 필드가 됐다.
  const timed = timedDates(task);
  // 노트에서 ⏰ 를 **뗀** 경우인가. 기준은 마지막 동기화 스냅샷이다:
  //   rec.time 이 비어 있음  = 우리가 시각을 올린 적이 없다 → 이벤트의 시각은 GCal 에서
  //                            사람이 지정한 것이므로 보존한다(0.5.0 설계).
  //   rec.time 이 차 있음    = 우리가 올렸던 시각이 노트에서 사라졌다 → 종일로 되돌린다.
  // 이 구분이 없으면 아래 보존 분기가 "⏰ 제거" 까지 삼켜, 노트에서 지워도 GCal 은
  // 계속 시간지정으로 남는다(2026-08-16).
  const timeRemoved = !taskTime(task) && !!(rec.time ?? "");
  if (timed) return timed;
  // ⏰ 가 없고 제거된 것도 아니면 예전 동작을 유지한다: GCal 에서 사람이 지정해 둔 시각을
  // 날짜만 밀어 보존한다. 순수 timed(양끝 모두 dateTime)일 때만 — 한쪽만 dateTime 인
  // 혼합형을 그대로 patch 하면 타입 불일치로 GCal 400 → 종일로 정규화.
  if (!timeRemoved && cur?.start?.dateTime && cur?.end?.dateTime) {
    const oldDate = cur.start.dateTime.slice(0, 10);
    const delta = daysBetween(oldDate, task.due!);
    return {
      start: {
        dateTime: shiftDateTime(cur.start.dateTime, delta),
        timeZone: cur.start.timeZone,
      },
      end: {
        dateTime: shiftDateTime(cur.end.dateTime, delta),
        timeZone: cur.end.timeZone,
      },
    };
  }
  return {
    start: { date: spanStart(task) },
    end: { date: addDay(task.due!) },
  };
}

/**
 * PATCH 용 start/end 를 **한 가지 표현만 남게** 만든다.
 *
 * PATCH 는 객체를 병합한다. 종일 이벤트(`start.date`)에 시각 표현(`start.dateTime`)만
 * 보내면 서버 쪽 start 에는 date 와 dateTime 이 **함께** 남고, Google 은 그걸
 * `400 Invalid start time` 으로 거절한다 — 노트에 ⏰ 를 새로 붙인 task 가 매 sync 마다
 * 이 400 을 반복했다(2026-08-16). 반대 방향(시간 → 종일)도 같은 이유로 깨진다.
 * 그래서 쓰지 않는 쪽을 null 로 명시해 지운다.
 */
export function exclusiveDates(d: Partial<GCalEvent>): Partial<GCalEvent> {
  const one = (v: GCalEvent["start"]): GCalEvent["start"] => {
    if (!v) return v;
    return v.dateTime
      ? { ...v, date: null } // 시간지정 → 종일 표현 제거
      : { ...v, dateTime: null, timeZone: null }; // 종일 → 시간 표현 제거
  };
  const out: Partial<GCalEvent> = { ...d };
  if (d.start) out.start = one(d.start);
  if (d.end) out.end = one(d.end);
  return out;
}
