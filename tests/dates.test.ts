/**
 * src/sync/dates.ts 의 특성 고정 — taskline.test.ts 가 이미 보는 함수
 * (addDays·daysBetween·isValidTimeRange·normalizeTimeRange·shiftDateTime·timeOfDateTime·toDateTime)
 * 는 제외하고 나머지를 **지금 동작 그대로** 고정한다.
 */
import {
  fmt,
  todayStr,
  addDay,
  isValidDate,
  isoDaysAgo,
  timeToMinutes,
  padTime,
  minutesToTime,
  localTimeZone,
  genId,
} from "../src/sync/dates";
import { installFakeEnv, resetClock, advanceClock, FIXED_NOW } from "./helpers/fakeEnv";
import { eq, ok, done } from "./helpers/assert";

installFakeEnv();
resetClock();

// ── fmt ──
{
  eq(fmt(new Date(2026, 0, 5)), "2026-01-05", "fmt: 월·일 0 채움");
  eq(fmt(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31", "fmt: 로컬 날짜만(시각 무시)");
  eq(fmt(new Date(2026, 1, 31)), "2026-03-03", "fmt: Date 가 굴린 날짜를 그대로 적는다");
  const early = new Date(2026, 0, 1);
  early.setFullYear(999);
  eq(fmt(early), "999-01-01", "fmt: 연도는 0 채움 안 함(4자리 미만 그대로) — 특성 고정");
}

// ── todayStr (가짜 시계) ──
{
  eq(todayStr(), "2026-08-06", "todayStr: 고정 시계 2026-08-06 12:00 local");
  advanceClock(11 * 3600_000 + 59 * 60_000); // 23:59
  eq(todayStr(), "2026-08-06", "todayStr: 같은 날 23:59");
  advanceClock(60_000); // 다음날 00:00
  eq(todayStr(), "2026-08-07", "todayStr: 자정 넘으면 다음 날");
  resetClock();
}

// ── addDay ──
{
  eq(addDay("2026-08-06"), "2026-08-07", "addDay: +1일");
  eq(addDay("2026-12-31"), "2027-01-01", "addDay: 연 넘김");
  eq(addDay("2026-02-28"), "2026-03-01", "addDay: 평년 2월 말");
  eq(addDay("2028-02-28"), "2028-02-29", "addDay: 윤년 2월 말");
  eq(addDay("2026-02-31"), "2026-03-04", "addDay: 존재하지 않는 날짜는 굴려서 +1 (검증 안 함)");
  eq(addDay("garbage"), "NaN-NaN-NaN", "addDay: 형식이 깨지면 NaN-NaN-NaN — 특성 고정");
}

// ── isValidDate ──
{
  eq(isValidDate("2026-08-06"), true, "isValidDate: 정상");
  eq(isValidDate("2026-02-28"), true, "isValidDate: 2월 28일");
  eq(isValidDate("2026-02-29"), false, "isValidDate: 평년 2/29 → rollover 로 거름");
  eq(isValidDate("2028-02-29"), true, "isValidDate: 윤년 2/29");
  eq(isValidDate("2026-02-31"), false, "isValidDate: 2/31 rollover");
  eq(isValidDate("2026-04-31"), false, "isValidDate: 4/31 rollover");
  eq(isValidDate("2026-13-01"), false, "isValidDate: 13월");
  eq(isValidDate("2026-00-10"), false, "isValidDate: 0월");
  eq(isValidDate("2026-01-00"), false, "isValidDate: 0일");
  eq(isValidDate("2026-8-6"), false, "isValidDate: 0 채움 안 된 형식");
  eq(isValidDate("2026-08-6"), false, "isValidDate: 일만 한 자리");
  eq(isValidDate(" 2026-08-06"), false, "isValidDate: 앞 공백");
  eq(isValidDate("2026-08-06T00:00"), false, "isValidDate: 시각 붙음");
  eq(isValidDate("2026/08/06"), false, "isValidDate: 구분자 다름");
  eq(isValidDate(undefined), false, "isValidDate: undefined");
  eq(isValidDate(null), false, "isValidDate: null");
  eq(isValidDate(""), false, "isValidDate: 빈 문자열");
  eq(isValidDate("0999-01-01"), false, "isValidDate: 1000년 미만은 fmt 가 0 채움을 안 해 거짓 — 특성 고정");
  eq(isValidDate("1000-01-01"), true, "isValidDate: 1000년은 참");
}

// ── isoDaysAgo (가짜 시계) ──
{
  const expected = (days: number) => {
    const d = new Date(FIXED_NOW);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  };
  const r = isoDaysAgo(30);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r), "isoDaysAgo: toISOString 형식(UTC, 밀리초, Z)");
  eq(r, expected(30), "isoDaysAgo(30): 로컬 달력으로 30일 전");
  eq(isoDaysAgo(0), new Date(FIXED_NOW).toISOString(), "isoDaysAgo(0): 지금");
  eq(isoDaysAgo(3), expected(3), "isoDaysAgo(3)");
  eq(Date.parse(isoDaysAgo(3)), FIXED_NOW - 3 * 86400_000, "isoDaysAgo(3): 8월엔 DST 전환 없음 → 정확히 72시간 전");
  eq(isoDaysAgo(-1), expected(-1), "isoDaysAgo(-1): 음수는 미래");
}

// ── timeToMinutes ──
{
  eq(timeToMinutes("00:00"), 0, "timeToMinutes: 자정");
  eq(timeToMinutes("09:30"), 570, "timeToMinutes: 09:30");
  eq(timeToMinutes("23:59"), 1439, "timeToMinutes: 23:59");
  eq(timeToMinutes("9:05"), 545, "timeToMinutes: 한 자리 시");
  eq(timeToMinutes("24:00"), 1440, "timeToMinutes: 범위 검증 안 함");
  ok(Number.isNaN(timeToMinutes("abc")), "timeToMinutes: 형식이 깨지면 NaN");
  ok(Number.isNaN(timeToMinutes("09")), "timeToMinutes: 분 없으면 NaN");
}

// ── padTime ──
{
  eq(padTime("9:05"), "09:05", "padTime: 한 자리 시 채움");
  eq(padTime("09:05"), "09:05", "padTime: 이미 두 자리");
  eq(padTime("0:0"), "00:0", "padTime: 분은 채우지 않는다");
  eq(padTime("123:4"), "123:4", "padTime: 긴 시는 그대로");
  eq(padTime("9"), "09:undefined", "padTime: 콜론 없으면 ':undefined' — 특성 고정");
}

// ── minutesToTime ──
{
  eq(minutesToTime(0), "00:00", "minutesToTime: 0");
  eq(minutesToTime(570), "09:30", "minutesToTime: 570");
  eq(minutesToTime(1439), "23:59", "minutesToTime: 1439");
  eq(minutesToTime(1440), "23:59", "minutesToTime: >1439 클램프");
  eq(minutesToTime(99999), "23:59", "minutesToTime: 큰 값 클램프");
  eq(minutesToTime(-1), "00:00", "minutesToTime: <0 클램프");
  eq(minutesToTime(-999), "00:00", "minutesToTime: 큰 음수 클램프");
  eq(minutesToTime(90.4), "01:30", "minutesToTime: 반올림(내림쪽)");
  eq(minutesToTime(90.5), "01:31", "minutesToTime: .5 는 올림");
  eq(minutesToTime(1439.6), "23:59", "minutesToTime: 반올림 후 클램프");
  eq(minutesToTime(-0.4), "00:00", "minutesToTime: -0.4 → 00:00");
  eq(minutesToTime(NaN), "NaN:NaN", "minutesToTime: NaN 은 클램프를 통과한다 — 특성 고정");
}

// ── localTimeZone ──
{
  const tz = localTimeZone();
  eq(typeof tz, "string", "localTimeZone: 문자열");
  ok(tz.length > 0, "localTimeZone: 비어 있지 않음");
  eq(tz, Intl.DateTimeFormat().resolvedOptions().timeZone, "localTimeZone: Intl 의 값 그대로");

  const realDTF = Intl.DateTimeFormat;
  try {
    (Intl as any).DateTimeFormat = function () {
      throw new Error("no Intl");
    };
    eq(localTimeZone(), "Asia/Seoul", "localTimeZone: Intl 이 던지면 Asia/Seoul");

    (Intl as any).DateTimeFormat = function () {
      return { resolvedOptions: () => ({ timeZone: "" }) };
    };
    eq(localTimeZone(), "Asia/Seoul", "localTimeZone: 빈 timeZone 이면 Asia/Seoul");

    (Intl as any).DateTimeFormat = function () {
      return { resolvedOptions: () => ({}) };
    };
    eq(localTimeZone(), "Asia/Seoul", "localTimeZone: timeZone 없음 → Asia/Seoul");

    (Intl as any).DateTimeFormat = function () {
      return { resolvedOptions: () => ({ timeZone: "Europe/Berlin" }) };
    };
    eq(localTimeZone(), "Europe/Berlin", "localTimeZone: 주어진 값을 그대로");
  } finally {
    (Intl as any).DateTimeFormat = realDTF;
  }
  eq(localTimeZone(), tz, "localTimeZone: 원복 확인");
}

// ── genId (결정적 crypto) ──
{
  installFakeEnv(); // 난수 seed 를 1로 되돌린다
  const first = genId(new Set());
  const second = genId(new Set());
  eq(first.length, 6, "genId: 6자리");
  ok(/^[A-Za-z0-9]{6}$/.test(first), "genId: 영숫자만");
  ok(first !== second, "genId: 호출마다 다른 값");

  installFakeEnv();
  eq(genId(new Set()), first, "genId: 같은 seed → 같은 첫 id (결정적)");

  installFakeEnv();
  eq(genId(new Set([first])), second, "genId: existing 에 있으면 다시 뽑는다 → 두 번째 id");

  installFakeEnv();
  const third = (() => {
    genId(new Set());
    genId(new Set());
    return genId(new Set());
  })();
  installFakeEnv();
  eq(genId(new Set([first, second])), third, "genId: 연속 충돌도 계속 다시 뽑는다");

  // 바이트 → 문자 매핑: b % 62. 0 → 'A', 61 → '9', 62 → 'A', 255 → 255%62=7 → 'H'
  const realCrypto = (globalThis as any).crypto;
  const bytes = [0, 25, 26, 51, 61, 62, 255];
  let pos = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(a: Uint8Array) {
        for (let i = 0; i < a.length; i++) a[i] = bytes[pos++ % bytes.length];
        return a;
      },
    },
  });
  try {
    eq(genId(new Set()), "AZaz9A", "genId: 바이트 % 62 로 ID_CHARS 인덱싱");
    eq(genId(new Set()), "HAZaz9", "genId: 255 → 'H' (모듈로 편향 있음 — 특성 고정)");
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: realCrypto });
  }

  const many = new Set<string>();
  installFakeEnv();
  let collided = 0;
  for (let i = 0; i < 200; i++) {
    const id = genId(many);
    if (many.has(id) || !/^[A-Za-z0-9]{6}$/.test(id)) collided++;
    many.add(id);
  }
  eq([collided, many.size], [0, 200], "genId: 200번 뽑아도 existing 과 겹치지 않고 모두 형식이 맞다");
}

done();
