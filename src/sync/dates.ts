/** 로컬 날짜 유틸 (YYYY-MM-DD). */

export function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return fmt(new Date());
}

/** 날짜에 n일 더하기 (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + n);
  return fmt(d);
}

/** all-day 이벤트 end.date는 배타적이므로 due + 1일. */
export function addDay(date: string): string {
  return addDays(date, 1);
}

/** YYYY-MM-DD 모양만 본다(존재하는 날짜인지는 isValidDate 가 따로 본다). */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * YYYY-MM-DD 형식이며 실제 존재하는 날짜인지 검증.
 * rollover("2026-02-31"→3/3)·NaN·undefined를 모두 거른다.
 */
export function isValidDate(s: string | undefined | null): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  return !isNaN(d.getTime()) && fmt(d) === s;
}

/** 두 날짜(YYYY-MM-DD) 사이 일수 차 (b - a). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}

/** RFC3339 dateTime의 날짜 부분만 n일 이동(시각·오프셋 유지). 예: 2026-07-05T14:00+09:00 → +5일 */
export function shiftDateTime(dt: string, deltaDays: number): string {
  const i = dt.indexOf("T");
  if (i < 0) return dt;
  return addDays(dt.slice(0, i), deltaDays) + dt.slice(i);
}

/** N일 전의 RFC3339 타임스탬프 (timeMin 초기 동기화용). */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// 시각 범위 헬퍼는 공유 모듈로 옮겼다(0.12.1) — 기존 import 경로를 깨지 않게 다시 내보낸다.
import { padTime } from "../shared/tasks/timeRange";
export {
  timeToMinutes,
  padTime,
  minutesToTime,
  isValidTimeRange,
  normalizeTimeRange,
} from "../shared/tasks/timeRange";

/** 이 기기의 IANA 타임존. 못 얻으면 Asia/Seoul. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
  } catch {
    return "Asia/Seoul";
  }
}

/** RFC3339 dateTime 의 벽시계 시각 "HH:MM". 오프셋은 그대로 둔 채 자리만 읽는다. */
export function timeOfDateTime(dt: string): string | undefined {
  const m = dt.match(/T([01]\d|2[0-3]):([0-5]\d)/);
  return m ? m[1] + ":" + m[2] : undefined;
}

/** 날짜 + "HH:MM" → GCal 이 받는 로컬 dateTime 문자열(오프셋 없이 timeZone 과 함께 보낸다). */
export function toDateTime(date: string, hhmm: string): string {
  return `${date}T${padTime(hhmm)}:00`;
}

const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Tasks 호환 6자리 영숫자 ID 생성(볼트 내 중복 회피). */
export function genId(existing: Set<string>): string {
  let id = "";
  do {
    id = "";
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    for (const b of a) id += ID_CHARS[b % ID_CHARS.length];
  } while (existing.has(id));
  return id;
}
