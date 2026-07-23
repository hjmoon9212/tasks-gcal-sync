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
