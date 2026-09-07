/**
 * 캘린더 뷰에 그릴 외부 일정 — 판별·변환·창 계산, 그리고 피드의 캐시 규칙.
 *
 * 여기서 지키는 것 셋:
 *  - **동기화 커서를 건드리지 않는다.** 표시용 조회가 syncToken 을 공유하면 그 자리에서
 *    동기화가 망가진다. 첫 테스트가 그 감지선이다.
 *  - **task 이벤트가 일정으로 새지 않는다.** 새면 자기 task 가 막대+일정으로 두 번 그려진다.
 *  - **날짜가 조용히 하루 틀리지 않는다.** 종일의 배타적 end 와 남의 타임존이 그 두 경로다.
 */
import { GCalEvent } from "../src/gcal/CalendarClient";
import { FeedCalendar } from "../src/settings/Settings";
import { EventFeed } from "../src/gcal/EventFeed";
import {
  UID_SEP,
  WallClock,
  eventsSignature,
  isExternalEvent,
  isStale,
  mergeBuckets,
  monthKeysFor,
  shiftISO,
  toExternalEvent,
  windowForMonthKey,
} from "../src/gcal/externalEvent";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.error(
      `✗ ${msg}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`
    );
  }
}
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}

const CAL: FeedCalendar = { id: "work@x.com", name: "회사", color: "#3366cc" };

function ev(over: Partial<GCalEvent> = {}): GCalEvent {
  return {
    id: "ev1",
    summary: "주간 회의",
    start: { date: "2026-03-05" },
    end: { date: "2026-03-06" },
    ...over,
  };
}
const priv = (p: Record<string, string>): Partial<GCalEvent> => ({
  extendedProperties: { private: p },
});

(async () => {

// ── isExternalEvent — 중복 판별표 ──
eq(isExternalEvent(ev({ status: "cancelled" })), false, "취소된 이벤트는 제외");
eq(
  isExternalEvent(ev(priv({ tgsTaskId: "abc123", tgsVault: "ob_Moon_P" }))),
  false,
  "우리 볼트의 task 이벤트는 제외"
);
eq(
  isExternalEvent(ev(priv({ tgsTaskId: "abc123", tgsVault: "ob_Moon" }))),
  false,
  "★ 다른 볼트의 task 이벤트도 제외 — 클릭해도 열 노트가 없다"
);
eq(
  isExternalEvent(ev(priv({ tgsTaskId: "abc123" }))),
  false,
  "tgsVault 이전 버전이 만든 task 이벤트도 제외"
);
eq(
  isExternalEvent(ev(priv({ tgsSource: "tasks-gcal-sync" }))),
  false,
  "tgsTaskId 가 없어도 tgsSource 가 우리면 제외(이중 안전장치)"
);
eq(isExternalEvent(ev()), true, "extendedProperties 가 없으면 진짜 일정");
eq(
  isExternalEvent(ev({ extendedProperties: { private: {} } })),
  true,
  "빈 private 도 진짜 일정"
);
eq(isExternalEvent(ev({ id: undefined })), false, "id 없으면 제외");
eq(isExternalEvent(ev({ start: undefined })), false, "start 없으면 제외");
eq(
  isExternalEvent(ev({ start: { date: null, dateTime: null } })),
  false,
  "start 에 date/dateTime 둘 다 없으면 제외"
);

// ── toExternalEvent — 종일 (배타적 end → 포함) ──
{
  const e = toExternalEvent(ev(), CAL)!;
  eq(e.startISO, "2026-03-05", "종일 하루: 시작");
  eq(e.endISO, "2026-03-05", "★ 종일 하루: end.date 는 배타적이므로 -1일");
  eq(e.allDay, true, "종일 플래그");
  eq(e.multiDay, false, "하루짜리는 multiDay 아님");
  eq(e.tStart, null, "종일은 시각 없음");
  eq(e.uid, "work@x.com" + UID_SEP + "ev1", "uid 는 캘린더+이벤트 id");
  eq(e.color, "#3366cc", "색은 로컬 설정값");
}
{
  const e = toExternalEvent(
    ev({ start: { date: "2026-03-05" }, end: { date: "2026-03-08" } }),
    CAL
  )!;
  eq(e.endISO, "2026-03-07", "종일 다일: 03-08(배타) → 03-07");
  eq(e.multiDay, true, "여러 날이면 multiDay");
}
{
  const e = toExternalEvent(ev({ end: undefined }), CAL)!;
  eq(e.endISO, "2026-03-05", "end 가 없으면 하루짜리로 — 버리지 않는다(fail open)");
}
{
  const e = toExternalEvent(ev({ end: { date: "쓰레기" } }), CAL)!;
  eq(e.endISO, "2026-03-05", "end 형식이 깨져도 하루짜리로");
}
{
  const e = toExternalEvent(
    ev({ start: { date: "2026-03-05" }, end: { date: "2026-03-01" } }),
    CAL
  )!;
  eq(e.endISO, "2026-03-05", "end 가 start 보다 앞서면 start 로 클램프");
}
eq(
  toExternalEvent(ev({ summary: undefined }), CAL)!.title,
  "(제목 없음)",
  "제목이 없으면 대체 문구"
);
eq(
  toExternalEvent(ev({ summary: "   " }), CAL)!.title,
  "(제목 없음)",
  "공백뿐인 제목도 대체 문구"
);

// ── toExternalEvent — 시간 지정 ──
// 타임존을 러너 환경에 맡기지 않으려고 벽시계 변환을 주입한다.
// (esbuild.test.mjs 에 TZ 를 심으면 모든 테스트가 지나는 공용 러너를 건드리게 된다)
function wallAt(offsetMin: number) {
  return (s: string): WallClock => {
    const d = new Date(new Date(s).getTime() + offsetMin * 60_000);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      hh: d.getUTCHours(),
      mi: d.getUTCMinutes(),
    };
  };
}
const KST = wallAt(9 * 60);

const timed = (s: string, e?: string) =>
  ev({ start: { dateTime: s }, end: e ? { dateTime: e } : undefined });

{
  const e = toExternalEvent(
    timed("2026-03-05T14:00:00+09:00", "2026-03-05T15:30:00+09:00"),
    CAL,
    KST
  )!;
  eq(e.startISO, "2026-03-05", "시간지정 같은 날: 날짜");
  eq([e.tStart, e.tEnd], [840, 930], "14:00~15:30 → 분");
  eq(e.allDay, false, "시간지정은 종일 아님");
}
{
  // ★ 남이 만든 초대. 문자열에서 자리만 읽으면 03-05 14:00 로 보이지만
  //   KST 로는 03-06 07:00 이다. 진짜 변환을 하는지 보는 케이스.
  const e = toExternalEvent(timed("2026-03-05T14:00:00-08:00"), CAL, KST)!;
  eq(e.startISO, "2026-03-06", "★ 타임존: -08:00 초대가 KST 로는 다음 날");
  eq(e.tStart, 7 * 60, "★ 타임존: 07:00 로 변환");
  eq(e.tEnd, 8 * 60, "end 가 없으면 +1시간");
}
{
  const e = toExternalEvent(
    timed("2026-03-05T23:00:00+09:00", "2026-03-06T01:00:00+09:00"),
    CAL,
    KST
  )!;
  eq(e.startISO, "2026-03-05", "자정 넘김: 시작일");
  eq(e.endISO, "2026-03-06", "자정 넘김: 종료일");
  eq([e.tStart, e.tEnd], [1380, 1440], "자정 넘김: 첫날 몫만 그린다(23:00~24:00)");
  eq(e.multiDay, true, "자정 넘기면 multiDay");
}
{
  const e = toExternalEvent(
    timed("2026-03-05T14:00:00+09:00", "2026-03-05T14:00:00+09:00"),
    CAL,
    KST
  )!;
  eq(e.tEnd, 900, "길이 0이면 1시간으로 (막대 폭이 음수가 되지 않게)");
}
eq(
  toExternalEvent(ev(priv({ tgsTaskId: "x" })), CAL),
  null,
  "판별에서 걸리면 변환도 null"
);

// ── 반복(🔁) 표시 ──
eq(toExternalEvent(ev(), CAL)!.recurring, false, "보통 일정은 반복 아님");
eq(
  toExternalEvent(ev({ recurringEventId: "src_1" } as any), CAL)!.recurring,
  true,
  "★ singleEvents=true 로 받은 반복 회차는 recurringEventId 를 갖는다"
);
eq(
  toExternalEvent(ev({ recurrence: ["RRULE:FREQ=WEEKLY"] } as any), CAL)!.recurring,
  true,
  "recurrence 규칙만 있어도 반복(폴백)"
);
eq(
  toExternalEvent(ev({ recurrence: [] } as any), CAL)!.recurring,
  false,
  "빈 recurrence 는 반복 아님"
);

// ── shiftISO / 월 키 / 창 ──
eq(shiftISO("2026-03-01", -1), "2026-02-28", "월 경계 넘기기");
eq(shiftISO("2024-03-01", -1), "2024-02-29", "윤년 2월");
eq(shiftISO("2026-12-31", 1), "2027-01-01", "해 경계 넘기기");

eq(monthKeysFor("2026-03-05", "2026-03-05"), ["2026-03"], "하루 → 월 1개");
eq(
  monthKeysFor("2026-02-23", "2026-03-01"),
  ["2026-02", "2026-03"],
  "두 달에 걸친 주 → 월 2개"
);
eq(
  monthKeysFor("2026-01-25", "2026-03-07"),
  ["2026-01", "2026-02", "2026-03"],
  "월간 그리드가 석 달을 건드릴 수 있다"
);
eq(
  monthKeysFor("2026-12-28", "2027-01-03"),
  ["2026-12", "2027-01"],
  "해를 넘겨도 이어진다"
);
eq(monthKeysFor("2026-03-10", "2026-03-01"), [], "범위가 뒤집혔으면 빈 배열");
eq(monthKeysFor("쓰레기", "2026-03-01"), [], "형식이 깨졌으면 빈 배열");

{
  const w = windowForMonthKey("2026-03");
  eq(w.timeMin, "2026-02-28T00:00:00Z", "창은 앞으로 하루 넓다(오프셋 때문에)");
  eq(w.timeMax, "2026-04-02T00:00:00Z", "창은 뒤로도 하루 넓다");
}
eq(
  windowForMonthKey("2026-12").timeMax,
  "2027-01-02T00:00:00Z",
  "12월 → 1월 롤오버"
);
eq(
  windowForMonthKey("2024-02").timeMax,
  "2024-03-02T00:00:00Z",
  "윤년 2월도 다음 달 1일 기준"
);

// ── mergeBuckets ──
const mk = (uid: string, s: string, e: string, t: number | null = null) =>
  ({ uid, startISO: s, endISO: e, tStart: t } as any);
{
  const a = [mk("u1", "2026-02-27", "2026-03-02"), mk("u2", "2026-02-10", "2026-02-10")];
  const b = [mk("u1", "2026-02-27", "2026-03-02"), mk("u3", "2026-03-20", "2026-03-20")];
  const merged = mergeBuckets([a, b], "2026-02-25", "2026-03-25");
  eq(
    merged.map((e) => e.uid),
    ["u1", "u3"],
    "★ 월 경계를 넘는 건은 양쪽 버킷에 오지만 uid 로 한 번만 (u2 는 범위 밖)"
  );
}
eq(
  mergeBuckets([[mk("z", "2026-03-01", "2026-03-01", 600), mk("a", "2026-03-01", "2026-03-01", null)]], "2026-03-01", "2026-03-01").map((e) => e.uid),
  ["a", "z"],
  "같은 날이면 종일이 먼저, 그 다음 시각순"
);

// ── isStale ──
eq(isStale(0, 1000, 500), true, "fetchedAt 0 은 무효");
eq(isStale(1000, 1400, 500), false, "TTL 안이면 신선");
eq(isStale(1000, 1500, 500), true, "TTL 지나면 낡음");

// ── eventsSignature — "다시 그릴 만큼 달라졌는가" 의 판단 근거 ──
{
  const mk = (o: Record<string, unknown> = {}) =>
    toExternalEvent(ev(o as Partial<GCalEvent>), CAL)!;
  const a = mk();
  const b = mk({ id: "ev2" });
  eq(
    eventsSignature([a, b]),
    eventsSignature([b, a]),
    "★ 순서만 다르면 같은 서명 — Google 은 orderBy 없이 순서를 보장하지 않는다"
  );
  ok(
    eventsSignature([a]) !== eventsSignature([mk({ summary: "제목이 바뀜" })]),
    "제목이 바뀌면 다른 서명"
  );
  ok(
    eventsSignature([a]) !==
      eventsSignature([mk({ start: { date: "2026-03-06" }, end: { date: "2026-03-07" } })]),
    "날짜가 바뀌면 다른 서명"
  );
  ok(
    eventsSignature([a]) !== eventsSignature([mk({ location: "3층 회의실" })]),
    "장소가 바뀌면 다른 서명(툴팁에 나온다)"
  );
  ok(eventsSignature([a]) !== eventsSignature([a, b]), "일정이 늘면 다른 서명");
  ok(eventsSignature([a]) !== eventsSignature([]), "일정이 사라지면 다른 서명");
  eq(
    eventsSignature([a]),
    eventsSignature([mk({ htmlLink: "https://calendar.google.com/다름" })]),
    "htmlLink 만 다르면 같은 서명 — 그림이 같으므로 다시 그릴 이유가 없다"
  );
  eq(eventsSignature([]), eventsSignature([]), "빈 목록끼리는 같은 서명");
}

// ─────────────────────── EventFeed — 스텁 client 로 ───────────────────────

interface Call {
  cal: string;
  params: Record<string, string>;
}
function stubClient(items: GCalEvent[] | (() => GCalEvent[])) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async listEvents(cal: string, params: Record<string, string>) {
        calls.push({ cal, params });
        const got = typeof items === "function" ? items() : items;
        return { items: got };
      },
    } as any,
  };
}
const feedOf = (client: any, cals: FeedCalendar[] = [CAL]) =>
  new EventFeed(client, () => cals, () => true);

// ★ 동기화 커서를 건드리지 않는다 — 이 파일에서 가장 중요한 단언
{
  const state = { records: {}, syncTokens: { "work@x.com": "TOKEN_ABC" } };
  const before = JSON.stringify(state.syncTokens);
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  await feed.requestEvents("2026-03-01", "2026-03-31");
  eq(JSON.stringify(state.syncTokens), before, "★ syncTokens 가 그대로다");
  ok(
    calls.every((c) => !("syncToken" in c.params)),
    "★ 어떤 호출에도 syncToken 이 실리지 않는다"
  );
  ok(
    calls.every((c) => !!c.params.timeMin && !!c.params.timeMax),
    "표시용 조회는 항상 명시적인 창으로 한다"
  );
}

// 캐시 · in-flight 합치기
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  await Promise.all([
    feed.requestEvents("2026-03-05", "2026-03-05"),
    feed.requestEvents("2026-03-05", "2026-03-05"),
  ]);
  eq(calls.length, 1, "★ 같은 버킷을 두 위젯이 요청해도 호출은 한 번");
  eq(feed.peekEvents("2026-03-05", "2026-03-05").length, 1, "받아온 일정이 보인다");
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(calls.length, 1, "TTL 안이면 다시 받지 않는다");
}

// peek 은 네트워크를 타지 않는다
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  eq(feed.peekEvents("2026-03-05", "2026-03-05"), [], "캐시가 비면 빈 배열");
  eq(calls.length, 0, "★ peek 은 호출을 만들지 않는다 (렌더 루프에서 매번 불린다)");
}

// task 이벤트는 캐시에 들어가지 않는다
{
  const { client } = stubClient([
    ev(),
    ev({ id: "ev2", ...priv({ tgsTaskId: "abc123", tgsVault: "ob_Moon_P" }) }),
    ev({ id: "ev3", ...priv({ tgsTaskId: "def456", tgsVault: "ob_Moon" }) }),
  ]);
  const feed = feedOf(client);
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(
    feed.peekEvents("2026-03-05", "2026-03-05").map((e) => e.uid.split(UID_SEP)[1]),
    ["ev1"],
    "★ 어느 볼트의 task 이벤트든 일정으로 새지 않는다"
  );
}

// 실패해도 reject 하지 않고, 있던 것을 지우지 않는다
{
  let mode: "ok" | "boom" = "ok";
  const calls: Call[] = [];
  const client = {
    async listEvents(cal: string, params: Record<string, string>) {
      calls.push({ cal, params });
      if (mode === "boom") throw new Error("GCal list 503");
      return { items: [ev()] };
    },
  } as any;
  const feed = new EventFeed(client, () => [CAL], () => true);

  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(feed.peekEvents("2026-03-05", "2026-03-05").length, 1, "먼저 한 번 받아둔다");

  mode = "boom";
  (feed as any).buckets.forEach((b: any, k: string) =>
    (feed as any).buckets.set(k, { ...b, fetchedAt: 1 })
  ); // 낡은 것으로 만든다
  let threw = false;
  await feed.requestEvents("2026-03-05", "2026-03-05").catch(() => (threw = true));
  eq(threw, false, "★ 실패해도 reject 하지 않는다");
  eq(
    feed.peekEvents("2026-03-05", "2026-03-05").length,
    1,
    "★ 빈 화면보다 낡은 화면이 낫다 — 있던 것을 지우지 않는다"
  );

  const n = calls.length;
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(calls.length, n, "실패 직후에는 다시 때리지 않는다(FAIL_TTL)");
}

// 인증 전 · 고른 캘린더 없음
{
  const { client, calls } = stubClient([ev()]);
  const noCal = new EventFeed(client, () => [], () => true);
  eq(noCal.isReady(), false, "고른 캘린더가 없으면 준비 안 됨");
  await noCal.requestEvents("2026-03-01", "2026-03-31");
  eq(calls.length, 0, "준비가 안 됐으면 호출하지 않는다");
  eq(noCal.peekEvents("2026-03-01", "2026-03-31"), [], "peek 도 빈 배열");

  const noAuth = new EventFeed(client, () => [CAL], () => false);
  eq(noAuth.isReady(), false, "인증 전이면 준비 안 됨");
  await noAuth.requestEvents("2026-03-01", "2026-03-31");
  eq(calls.length, 0, "인증 전에는 호출하지 않는다");
}

// ★ 갱신은 화면을 비우지 않는다 — v0.7.3 회귀 감지선
//
// 예전 invalidateAll() 은 fetchedAt 을 0으로 만들었고, peek 의 게이트가 바로 그
// fetchedAt 이라 재조회가 끝날 때까지 일정 막대가 통째로 사라졌다. 동기화가 5분마다
// 돌았으므로 5분마다 깜빡였다. 이 블록이 그게 돌아오는 것을 막는다.
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  let fired = 0;
  const off = feed.onChange(() => fired++);
  const range = ["2026-03-05", "2026-03-05"] as const;

  await feed.requestEvents(...range);
  eq(calls.length, 1, "처음 한 번");
  eq(fired, 1, "첫 페인트는 알린다");

  const inFlight = feed.refreshAll(); // 아직 await 하지 않는다 = 재조회가 도는 중
  eq(
    feed.peekEvents(...range).length,
    1,
    "★ 재조회가 도는 동안에도 이전 일정을 계속 준다 (화면이 비지 않는다)"
  );
  await inFlight;
  eq(calls.length, 2, "강제 재조회는 TTL 을 무시한다");
  eq(feed.peekEvents(...range).length, 1, "재조회 뒤에도 그대로 보인다");
  eq(fired, 1, "★ 내용이 같으면 다시 그리라고 하지 않는다");

  off();
}

// 달라졌을 때만, 정확히 한 번 알린다
{
  let items: GCalEvent[] = [ev()];
  const { client } = stubClient(() => items);
  const feed = feedOf(client);
  let fired = 0;
  feed.onChange(() => fired++);
  const range = ["2026-03-05", "2026-03-05"] as const;

  await feed.requestEvents(...range);
  eq(fired, 1, "첫 페인트");

  await feed.refreshAll();
  eq(fired, 1, "같은 내용 → 알림 없음");

  items = [ev({ summary: "주간 회의(장소 변경)" })];
  await feed.refreshAll();
  eq(fired, 2, "★ 제목이 바뀌면 정확히 한 번 알린다");
  eq(feed.peekEvents(...range)[0].title, "주간 회의(장소 변경)", "새 제목이 반영된다");

  items = [];
  await feed.refreshAll();
  eq(fired, 3, "회의가 취소돼도 알린다");
  eq(feed.peekEvents(...range).length, 0, "실제로 사라진 것은 사라진다");
}

// 보는 사람이 없으면 폴링하지 않는다
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  const off = feed.onChange(() => {});
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(calls.length, 1, "처음 한 번");

  off();
  await feed.refreshTracked({ force: true });
  eq(calls.length, 1, "★ 구독자가 0명이면 주기 갱신은 아무것도 하지 않는다");
  eq((feed as any).windows.size, 0, "기억해 둔 창도 버린다");
}

// 열려 있는 창을 전부 다시 받는다 (월 뷰 + 다른 달을 보는 두 번째 위젯)
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  feed.onChange(() => {});
  await feed.requestEvents("2026-03-01", "2026-03-31");
  await feed.requestEvents("2026-06-01", "2026-06-30");
  eq(calls.length, 2, "창 둘을 각각 받아온다");

  await feed.refreshAll();
  eq(calls.length, 4, "★ 기억해 둔 창을 전부 다시 받는다");
}

// ★★ 조용하다고 폴링을 멈추지 않는다 — 2026-09-07 회귀 감지선
//
// 예전엔 30분간 요청이 없던 창을 잊었다. 그런데 뷰는 자기 캐시가 맞는 동안 우리를 부르지
// 않으므로, 조용한 30분이 한 번 지나가면 창이 사라지고 → 폴링이 멈추고 → 달라질 일이
// 없으니 뷰의 캐시도 영영 유효하다. 그날 GCal 에서 지운 일정이 **Obsidian 재시작
// 전까지** 화면에 남았다. 이 블록이 그 교착이 돌아오는 것을 막는다.
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  feed.onChange(() => {});
  await feed.requestEvents("2026-03-01", "2026-03-31");
  eq(calls.length, 1, "처음 한 번");

  (feed as any).windows.forEach((w: any, k: string) =>
    (feed as any).windows.set(k, { ...w, at: Date.now() - 24 * 60 * 60 * 1000 })
  );
  await feed.refreshTracked({ force: true });
  eq(calls.length, 2, "★ 하루를 조용히 있어도 보고 있는 창은 계속 다시 받는다");
  eq((feed as any).windows.size, 1, "창을 시간으로 버리지 않는다");
}

// 창은 시간이 아니라 **개수**로 끊는다 (열어 둔 채 여러 달을 돌아다닌 경우)
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  feed.onChange(() => {});
  for (const mo of ["01", "02", "03", "04", "05"]) {
    await feed.requestEvents(`2026-${mo}-01`, `2026-${mo}-28`);
  }
  eq(calls.length, 5, "다섯 달을 각각 받아온다");
  eq((feed as any).windows.size, 4, "★ 창은 최근 4개까지만 기억한다");
  ok(
    ![...(feed as any).windows.keys()].some((k: string) => k.startsWith("2026-01")),
    "가장 오래 전에 본 창부터 나간다"
  );
}

// ★★ 수동 새로 고침은 무동작이 될 수 없다 — "삭제 → 동기화 → 그대로" 의 나머지 절반
//
// refreshAll 이 refreshTracked 한 줄이던 시절엔, 구독자가 0명(=캘린더 노트를 닫아 둠)이면
// 창을 비우고 그냥 돌아왔다. 사람이 "지금 맞춰라" 를 눌렀는데 일정은 하나도 갱신되지 않았다.
{
  const { client, calls } = stubClient([ev()]);
  const feed = feedOf(client);
  const off = feed.onChange(() => {});
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(calls.length, 1, "처음 한 번");

  off(); // 캘린더 노트를 닫았다
  await feed.refreshAll();
  eq(calls.length, 2, "★ 구독자가 없어도 수동 새로 고침은 가진 것을 다시 받는다");
}

// 조회 실패가 흔적을 남긴다 — 낡은 사본을 계속 내주는 설계의 대가는 보여야 한다
{
  const boom = {
    async listEvents() {
      throw new Error("403 rate limit");
    },
  } as any;
  const feed = feedOf(boom);
  await feed.requestEvents("2026-03-01", "2026-03-31");
  eq(
    feed.lastError?.includes("403 rate limit") ?? false,
    true,
    "★ 실패 사유가 lastError 에 남는다"
  );

  const good = stubClient([ev()]);
  const feed2 = feedOf(good.client);
  await feed2.requestEvents("2026-03-01", "2026-03-31");
  eq(feed2.lastError, null, "성공한 조회는 흔적을 남기지 않는다");
}

// 구독 해제
{
  const { client } = stubClient([ev()]);
  const feed = feedOf(client);
  let fired = 0;
  const off = feed.onChange(() => fired++);
  await feed.requestEvents("2026-03-05", "2026-03-05");
  eq(fired, 1, "구독 중에는 온다");
  off();
  feed.dropUnselected();
  eq(fired, 1, "구독 해제하면 더 안 온다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
})();
