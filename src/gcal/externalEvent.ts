/**
 * 캘린더 뷰에 **읽기 전용으로 그릴** 외부 일정(회의·약속·초대)의 순수 변환.
 *
 * I/O 는 EventFeed 가 하고 여기는 값만 다룬다 — reconcile.ts(순수) / SyncEngine.ts(실행)
 * 분리와 같은 이유다. 조용히 틀리기 쉬운 곳(배타/포함 날짜, 타임존)이 전부 여기 모여
 * 있으므로 테스트도 여기 붙는다.
 */

import { GCalEvent } from "./CalendarClient";
import { FeedCalendar } from "../settings/Settings";
import { ExternalEvent } from "../api/PublicApi";

/** 로컬 벽시계로 분해한 순간. 타임존 변환을 테스트에서 통제하려고 값으로 뽑았다. */
export interface WallClock {
  y: number;
  mo: number; // 1~12
  d: number;
  hh: number;
  mi: number;
}

export type ToWall = (rfc3339: string) => WallClock;

/**
 * 기본 구현 — 이 기기의 로컬 벽시계.
 *
 * ⚠️ `dates.ts` 의 `timeOfDateTime()` 을 여기 쓰면 안 된다. 그건 문자열에서 자리만
 * 읽으므로(오프셋 무시) **우리가 쓴 이벤트**에만 맞다. 남이 만든 초대는 임의의
 * 오프셋(`...T14:00:00-08:00`)으로 오기 때문에, 자리만 읽으면 일정이 엉뚱한 날·시각에
 * 그려진다. 여기서는 반드시 진짜 변환을 한다.
 */
export const localWall: ToWall = (s) => {
  const d = new Date(s);
  return {
    y: d.getFullYear(),
    mo: d.getMonth() + 1,
    d: d.getDate(),
    hh: d.getHours(),
    mi: d.getMinutes(),
  };
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const wallISO = (w: WallClock) => `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
const wallMin = (w: WallClock) => w.hh * 60 + w.mi;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MIN = 60;

/** uid 구분자. 캘린더 id 는 이메일이라 무엇이든 들어갈 수 있어 보이지 않는 문자를 쓴다. */
export const UID_SEP = String.fromCharCode(0);

/** YYYY-MM-DD 에 n일 더하기. Date 로만 계산해 월말·윤년을 스스로 처리한다. */
export function shiftISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 우리(어느 볼트든)가 만든 task 이벤트가 아니라, 사람이 만든 **진짜 일정**인가.
 *
 * ⚠️ `SyncEngine.isOurs()` 를 쓰면 안 된다. 계약이 정반대다 — `tgsVault` 가 **없으면**
 * true 를 돌려주므로 "남의 볼트 record 를 입양하지 마라" 테스트이지 "진짜 회의인가"
 * 테스트가 아니다. 그걸 쓰면 tgsVault 이전에 만들어진 task 이벤트가 전부 가짜 회의로
 * 새어 들어온다.
 *
 * 판별자는 `tgsTaskId` 존재 여부 하나이고 **`tgsVault` 는 보지 않는다.** 다른 볼트의
 * task 이벤트까지 빼야, (a) 자기 task 가 막대+일정으로 두 번 그려지지 않고
 * (b) 클릭해도 열 노트가 없는 막대가 안 생긴다.
 */
export function isExternalEvent(ev: GCalEvent): boolean {
  if (!ev) return false;
  if (ev.status === "cancelled") return false;
  const p = ev.extendedProperties?.private;
  if (p?.tgsTaskId) return false;
  if (p?.tgsSource === "tasks-gcal-sync") return false; // 이중 안전장치
  if (!ev.id) return false;
  if (!ev.start || (!ev.start.date && !ev.start.dateTime)) return false;
  return true;
}

/**
 * GCal 이벤트 → 캘린더 뷰가 그릴 수 있는 값. 못 읽으면 null(그 건만 빠진다).
 *
 * 날짜는 **포함(inclusive)** 으로 바꿔서 내보낸다. GCal 종일 이벤트의 `end.date` 는
 * 배타적이라 3/5 하루짜리가 `03-05 ~ 03-06` 으로 오는데, 그대로 두면 위젯이 이틀짜리
 * 막대를 그린다.
 */
export function toExternalEvent(
  ev: GCalEvent,
  cal: FeedCalendar,
  toWall: ToWall = localWall
): ExternalEvent | null {
  if (!isExternalEvent(ev)) return null;
  const raw = ev as GCalEvent & {
    location?: string;
    htmlLink?: string;
    recurringEventId?: string;
    recurrence?: string[];
  };

  const title = (ev.summary ?? "").trim() || "(제목 없음)";
  // singleEvents=true 로 받으므로 반복 일정은 회차마다 따로 오고, 각 회차가 원본을
  // recurringEventId 로 가리킨다. recurrence 는 singleEvents 없이 받았을 때의 폴백.
  const recurring = !!raw.recurringEventId || (raw.recurrence?.length ?? 0) > 0;
  const base = {
    uid: cal.id + UID_SEP + ev.id,
    calendarId: cal.id,
    calendarName: cal.name,
    color: cal.color,
    title,
    recurring,
    location: raw.location || undefined,
    htmlLink: raw.htmlLink || undefined,
  };

  // ── 종일 ──
  if (ev.start?.date) {
    const startISO = ev.start.date;
    if (!DATE_RE.test(startISO)) return null;
    const rawEnd = ev.end?.date;
    // end 가 없거나 형식이 깨졌으면 하루짜리로 본다 — 버리지 않는다(fail open)
    let endISO =
      rawEnd && DATE_RE.test(rawEnd) ? shiftISO(rawEnd, -1) : startISO;
    if (endISO < startISO) endISO = startISO;
    return {
      ...base,
      startISO,
      endISO,
      tStart: null,
      tEnd: null,
      allDay: true,
      multiDay: endISO > startISO,
    };
  }

  // ── 시간 지정 ──
  const sdt = ev.start?.dateTime;
  if (!sdt) return null;
  const sw = toWall(sdt);
  if (!Number.isFinite(sw.y) || !Number.isFinite(sw.hh)) return null;
  const startISO = wallISO(sw);
  const tStart = wallMin(sw);

  const edt = ev.end?.dateTime;
  let endISO = startISO;
  let tEnd = Math.min(tStart + DEFAULT_MIN, 1440);
  if (edt) {
    const ew = toWall(edt);
    if (Number.isFinite(ew.y) && Number.isFinite(ew.hh)) {
      endISO = wallISO(ew);
      if (endISO < startISO) endISO = startISO;
      // 자정을 넘기면 첫날 몫만 그린다. 24시간 그리드에 걸치려면 종료가 그 날 안에
      // 있어야 하고, 여러 날짜에 같은 시간대를 그리는 건 GCal 에서도 반복 이벤트다.
      tEnd = endISO > startISO ? 1440 : Math.min(wallMin(ew), 1440);
      if (tEnd <= tStart) tEnd = Math.min(tStart + DEFAULT_MIN, 1440);
    }
  }

  return {
    ...base,
    startISO,
    endISO,
    tStart,
    tEnd,
    allDay: false,
    multiDay: endISO > startISO,
  };
}

// ────────────────────────────── 창(window) 계산 ──────────────────────────────

/** "YYYY-MM" 월 키. 캐시 버킷의 단위다. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** [fromISO, toISO] 가 걸치는 월 키들. 범위가 뒤집혔으면 []. */
export function monthKeysFor(fromISO: string, toISO: string): string[] {
  if (!DATE_RE.test(fromISO) || !DATE_RE.test(toISO)) return [];
  if (toISO < fromISO) return [];
  const keys: string[] = [];
  let y = Number(fromISO.slice(0, 4));
  let m = Number(fromISO.slice(5, 7));
  const endKey = monthKey(toISO);
  for (let guard = 0; guard < 120; guard++) {
    const k = `${y}-${pad2(m)}`;
    keys.push(k);
    if (k >= endKey) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return keys;
}

/**
 * 월 키 → GCal `timeMin`/`timeMax`.
 *
 * 앞뒤로 하루씩 넓힌다. 경계를 UTC(`Z`)로 보내는데 로컬은 UTC 가 아니므로, 딱 맞추면
 * 월 첫날/마지막날 일정이 오프셋만큼 잘려 나간다. 넉넉히 받고 `mergeBuckets` 에서
 * 자르는 쪽이 싸다.
 */
export function windowForMonthKey(key: string): { timeMin: string; timeMax: string } {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const first = `${y}-${pad2(m)}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const next = `${nextY}-${pad2(nextM)}-01`;
  return {
    timeMin: shiftISO(first, -1) + "T00:00:00Z",
    timeMax: shiftISO(next, 1) + "T00:00:00Z",
  };
}

/**
 * 여러 버킷을 합쳐 [fromISO, toISO] 에 걸치는 일정만 준다.
 *
 * Google 은 창에 **겹치는** 이벤트를 주므로 월 경계를 넘는 회의는 양쪽 버킷에 들어온다 →
 * `uid` 로 중복을 없앤다. 특수 처리가 따로 필요 없는 이유다.
 */
export function mergeBuckets(
  buckets: ExternalEvent[][],
  fromISO: string,
  toISO: string
): ExternalEvent[] {
  const seen = new Set<string>();
  const out: ExternalEvent[] = [];
  for (const b of buckets) {
    for (const e of b) {
      if (e.endISO < fromISO || e.startISO > toISO) continue; // 범위 밖
      if (seen.has(e.uid)) continue;
      seen.add(e.uid);
      out.push(e);
    }
  }
  out.sort((a, b) => {
    if (a.startISO !== b.startISO) return a.startISO < b.startISO ? -1 : 1;
    const at = a.tStart ?? -1;
    const bt = b.tStart ?? -1;
    if (at !== bt) return at - bt;
    return a.uid < b.uid ? -1 : 1;
  });
  return out;
}

/** 이 버킷을 다시 받아와야 하는가. `fetchedAt === 0` 은 "무효" 를 뜻한다. */
export function isStale(fetchedAt: number, now: number, ttlMs: number): boolean {
  if (!fetchedAt) return true;
  return now - fetchedAt >= ttlMs;
}

/**
 * 버킷 내용이 **실제로 달라졌는지** 판단하기 위한 서명.
 *
 * 재조회 대부분은 똑같은 내용을 받아온다. 그때마다 `onChange` 를 쏘면 뷰가 DOM 을
 * 통째로 교체하므로(호버·포커스가 날아간다) 서명이 같으면 아무 일도 없던 것으로 친다.
 *
 * uid 로 정렬한 뒤 만든다 — Google 은 `orderBy` 없이는 순서를 보장하지 않으므로,
 * 순서만 뒤바뀐 같은 목록이 "변경" 으로 보이면 안 된다. 화면에 드러나는 필드만 넣는다
 * (`htmlLink` 는 제외 — 바뀌어도 그림이 같다).
 */
export function eventsSignature(events: ExternalEvent[]): string {
  const rows = events.map((e) =>
    JSON.stringify([
      e.uid,
      e.startISO,
      e.endISO,
      e.tStart,
      e.tEnd,
      e.allDay,
      e.multiDay,
      e.recurring,
      e.title,
      e.location ?? "",
      e.color,
      e.calendarName,
    ])
  );
  rows.sort();
  return rows.join("\n");
}
