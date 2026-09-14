/* @shared taskline v1.0.0 sha256:6ae703764de647a9b109c00498bc6a3b31ddb582b8df028ce22dc305a17c431c
 * 정본: tasks-gcal-sync-plugin/src/shared/tasks/timeRange.ts — 이 파일은 두 저장소에 **그대로** 복사된다.
 * 고칠 때: 정본 저장소에서만 고치고 → 헤더 버전을 올리고 → `node scripts/check-shared.mjs --write` → 복사. */
/*
 * 시각 범위(⏰ HH:MM-HH:MM) 헬퍼 — TaskLine 과 함께 두 플러그인이 공유한다.
 * 원래 src/sync/dates.ts 에 있던 것을 그대로 옮겼다(0.12.1). import 가 없어야 복사만으로 돈다.
 */

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
