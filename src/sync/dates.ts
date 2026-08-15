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

/**
 * YYYY-MM-DD 형식이며 실제 존재하는 날짜인지 검증.
 * rollover("2026-02-31"→3/3)·NaN·undefined를 모두 거른다.
 */
export function isValidDate(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
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

/*
 * ── 시각(타임블록) ───────────────────────────────────────────────────────────
 * 노트의 `⏰ HH:MM-HH:MM` 과 GCal 의 dateTime 사이를 오간다.
 * 스냅샷·비교는 전부 정규화된 "HH:MM-HH:MM" 문자열 하나로 다룬다("" = 종일).
 * 그래야 due/title 과 똑같은 필드 비교 경로를 타고 판정에 새 분기가 생기지 않는다.
 */
const RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" → 분. 형식은 호출 전에 검증돼 있다고 본다. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** "9:05" 처럼 한 자리 시도 "09:05" 로 맞춘다. */
export function padTime(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return h.padStart(2, "0") + ":" + m;
}

export function minutesToTime(min: number): string {
  const x = Math.max(0, Math.min(1439, Math.round(min)));
  return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
}

/** 정규화된 "HH:MM-HH:MM" 인가. 같은 날 기준 start < end 까지 본다. */
export function isValidTimeRange(s: string | undefined | null): s is string {
  if (!s || !RANGE_RE.test(s)) return false;
  const [a, b] = s.split("-");
  return timeToMinutes(a) < timeToMinutes(b);
}

/**
 * 시작(+선택적 종료)을 정규화된 범위로. 종료가 없거나 시작보다 앞서면 +1시간으로 본다.
 * 23:30 처럼 자정을 넘길 값은 23:59 로 잘라 같은 날 안에 둔다 —
 * 종료가 다음 날이 되면 GCal 이벤트가 이틀에 걸쳐 그려진다.
 */
export function normalizeTimeRange(start: string, end?: string): string {
  const s = timeToMinutes(padTime(start));
  let e = end ? timeToMinutes(padTime(end)) : s + 60;
  if (e <= s) e = s + 60;
  if (e > 1439) e = 1439;
  return minutesToTime(s) + "-" + minutesToTime(e);
}

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
