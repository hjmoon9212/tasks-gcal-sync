/**
 * 공개 API 계약 — `gcal-calendar-view` 가 **덕 타이핑**으로 부르는 모양을 고정한다.
 *
 * 뷰 플러그인은 BRAT 로 따로 갱신되므로 두 버전이 섞여 도는 구간이 반드시 생긴다.
 * 여기 적힌 모양(버전 번호·메서드 이름·인자 개수·반환 타입·"절대 throw/reject 안 함")
 * 중 하나라도 바뀌면 뷰가 조용히 깨진다. 동작 세부는 eventfeed.test.ts 가 본다.
 */
import { EventFeed } from "../src/gcal/EventFeed";
import { ExternalEvent, FeedCalendarInfo, GcalReadApi } from "../src/api/PublicApi";
import { FeedCalendar } from "../src/settings/Settings";
import { GCalEvent } from "../src/gcal/CalendarClient";
import { eq, ok, done } from "./helpers/assert";

const CAL: FeedCalendar = { id: "work@x.com", name: "회사", color: "#3366cc" };

function okClient(items: GCalEvent[]) {
  let n = 0;
  return {
    calls: () => n,
    client: {
      async listEvents(_cal: string, _params: Record<string, string>) {
        n++;
        return { items };
      },
    } as any,
  };
}

const throwingClient = {
  async listEvents() {
    throw new Error("GCal list 500: boom");
  },
} as any;

const syncThrowingClient = {
  listEvents() {
    throw new Error("sync boom");
  },
} as any;

/** console.warn/debug 소음을 막고 테스트 동안 모은다. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const w = console.warn;
  const d = console.debug;
  console.warn = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.warn = w;
    console.debug = d;
  }
}

(async () => {
  // ── 모양: 버전 · 메서드 · 인자 개수 ──
  {
    const { client } = okClient([]);
    const feed = new EventFeed(client, () => [CAL], () => true);

    // 컴파일 타임 계약: EventFeed 는 GcalReadApi 에 그대로 대입된다(main.ts 의 `this.api = this.feed`).
    const _api: GcalReadApi = feed;
    void _api;

    eq(feed.version, 1, "version === 1");
    eq(typeof feed.version, "number", "version 은 숫자");
    ok(Object.prototype.hasOwnProperty.call(feed, "version"), "version 은 인스턴스 자기 속성(클래스 필드)");

    const methods = ["isReady", "listSelectedCalendars", "peekEvents", "requestEvents", "onChange"] as const;
    for (const m of methods) {
      eq(typeof (feed as any)[m], "function", `${m} 는 함수`);
    }
    eq(
      methods.map((m) => Object.prototype.hasOwnProperty.call(EventFeed.prototype, m)),
      [true, true, true, true, true],
      "메서드는 프로토타입에 있다(바인딩 안 됨 — 뷰는 api.method() 로 불러야 한다)"
    );
    eq(
      methods.map((m) => (feed as any)[m].length),
      [0, 0, 2, 3, 1],
      "메서드 인자 개수(Function.length) — requestEvents 는 선택 opts 까지 3"
    );
    eq(EventFeed.length, 3, "EventFeed 생성자 인자 3개 (client, getCalendars, isAuthed)");
  }

  // ── isReady: 인증 + 캘린더 1개 이상, 절대 throw 안 함 ──
  {
    const { client } = okClient([]);
    eq(new EventFeed(client, () => [CAL], () => true).isReady(), true, "isReady: 인증됨 + 캘린더 있음 → true");
    eq(new EventFeed(client, () => [], () => true).isReady(), false, "isReady: feedCalendars 없음 → false");
    eq(new EventFeed(client, () => [CAL], () => false).isReady(), false, "isReady: 미인증 → false");
    eq(new EventFeed(client, () => [], () => false).isReady(), false, "isReady: 둘 다 없음 → false");
    const boomAuth = new EventFeed(client, () => [CAL], () => {
      throw new Error("x");
    });
    eq(boomAuth.isReady(), false, "isReady: isAuthed 가 던져도 false");
    const boomCals = new EventFeed(client, () => {
      throw new Error("x");
    }, () => true);
    eq(boomCals.isReady(), false, "isReady: getCalendars 가 던져도 false");
    const nullCals = new EventFeed(client, () => null as any, () => true);
    eq(nullCals.isReady(), false, "isReady: getCalendars 가 null 이어도 false");
    eq(typeof boomAuth.isReady(), "boolean", "isReady: 항상 boolean");
  }

  // ── listSelectedCalendars ──
  {
    const { client } = okClient([]);
    const extra = { id: "a@x.com", name: "A", color: "", secret: "drop" } as any;
    const feed = new EventFeed(client, () => [CAL, extra], () => false);
    const got: FeedCalendarInfo[] = feed.listSelectedCalendars();
    eq(
      got,
      [
        { id: "work@x.com", name: "회사", color: "#3366cc" },
        { id: "a@x.com", name: "A", color: "" },
      ],
      "listSelectedCalendars: {id,name,color} 만, 미인증이어도 돌려준다"
    );
    ok(got[0] !== (CAL as any), "listSelectedCalendars: 설정 객체를 그대로 내주지 않는다(복사)");
    const boom = new EventFeed(client, () => {
      throw new Error("x");
    }, () => true);
    eq(boom.listSelectedCalendars(), [], "listSelectedCalendars: 던지면 빈 배열");
    eq(new EventFeed(client, () => [], () => true).listSelectedCalendars(), [], "listSelectedCalendars: 없으면 빈 배열");
  }

  // ── peekEvents: 동기, 배열, 절대 throw 안 함 ──
  {
    const { client, calls } = okClient([]);
    const feed = new EventFeed(client, () => [CAL], () => true);
    const r = feed.peekEvents("2026-03-01", "2026-03-31");
    ok(Array.isArray(r), "peekEvents: 빈 피드에서도 배열");
    eq(r, [], "peekEvents: 빈 피드 → []");
    ok(!(r instanceof Promise), "peekEvents: Promise 가 아니다(동기)");
    eq(calls(), 0, "peekEvents: 네트워크를 타지 않는다");

    let threw = false;
    let odd: unknown[] = [];
    try {
      odd = [
        feed.peekEvents("garbage", "2026-03-31"),
        feed.peekEvents("2026-03-31", "2026-03-01"),
        feed.peekEvents(undefined as any, null as any),
        feed.peekEvents("", ""),
      ];
    } catch {
      threw = true;
    }
    eq(threw, false, "peekEvents: 이상한 인자에도 throw 안 함");
    eq(odd, [[], [], [], []], "peekEvents: 이상한 인자 → 빈 배열들");

    const boom = new EventFeed(client, () => {
      throw new Error("x");
    }, () => true);
    const d = console.debug;
    console.debug = () => {};
    try {
      eq(boom.peekEvents("2026-03-01", "2026-03-31"), [], "peekEvents: getCalendars 가 던져도 []");
    } finally {
      console.debug = d;
    }
    eq(
      new EventFeed(client, () => [CAL], () => false).peekEvents("2026-03-01", "2026-03-31"),
      [],
      "peekEvents: 미인증 → []"
    );
  }

  // ── requestEvents: Promise, 절대 reject 안 함 ──
  {
    const cases: [string, EventFeed][] = [
      ["client 가 비동기로 reject", new EventFeed(throwingClient, () => [CAL], () => true)],
      ["client 가 동기로 throw", new EventFeed(syncThrowingClient, () => [CAL], () => true)],
      ["getCalendars 가 throw", new EventFeed(throwingClient, () => { throw new Error("x"); }, () => true)],
      ["isAuthed 가 throw", new EventFeed(throwingClient, () => [CAL], () => { throw new Error("x"); })],
      ["준비 안 됨", new EventFeed(throwingClient, () => [], () => false)],
    ];
    for (const [label, feed] of cases) {
      const p = quiet(async () => {
        const ret = feed.requestEvents("2026-03-01", "2026-03-31");
        ok(ret instanceof Promise, `requestEvents(${label}): Promise 를 돌려준다`);
        let rejected = false;
        let value: unknown = "sentinel";
        try {
          value = await ret;
        } catch {
          rejected = true;
        }
        eq(rejected, false, `requestEvents(${label}): reject 하지 않는다`);
        eq(value, undefined, `requestEvents(${label}): undefined 로 resolve`);
      });
      await p;
    }
    {
      const feed = new EventFeed(throwingClient, () => [CAL], () => true);
      await quiet(() => feed.requestEvents("garbage", "x"));
      eq(feed.peekEvents("2026-03-01", "2026-03-31"), [], "requestEvents 실패 후에도 peek 은 []");
    }
  }

  // ── onChange: 구독 해제 함수 ──
  {
    const item: GCalEvent = {
      id: "ev1",
      summary: "주간 회의",
      start: { date: "2026-03-05" },
      end: { date: "2026-03-06" },
    };
    const { client } = okClient([item]);
    const feed = new EventFeed(client, () => [CAL], () => true);
    let hits = 0;
    const unsub = feed.onChange(() => hits++);
    eq(typeof unsub, "function", "onChange: 구독 해제 함수를 돌려준다");
    eq(unsub.length, 0, "onChange: 해제 함수는 인자 없음");

    await feed.requestEvents("2026-03-01", "2026-03-31");
    eq(hits, 1, "onChange: 새 데이터가 오면 한 번 알린다");

    const events: ExternalEvent[] = feed.peekEvents("2026-03-01", "2026-03-31");
    eq(events.length, 1, "peekEvents: 받아온 뒤엔 일정이 보인다");
    eq(
      Object.keys(events[0]).sort(),
      [
        "allDay",
        "calendarId",
        "calendarName",
        "color",
        "endISO",
        "htmlLink",
        "location",
        "multiDay",
        "recurring",
        "startISO",
        "tEnd",
        "tStart",
        "title",
        "uid",
      ],
      "ExternalEvent: 필드 이름 집합(location·htmlLink 는 원본에 없어도 키가 있고 값이 undefined)"
    );
    eq(
      [events[0].location, events[0].htmlLink, "location" in events[0]],
      [undefined, undefined, true],
      "ExternalEvent: 선택 필드는 undefined 로 존재(externalEvent.ts:115-116)"
    );
    eq(
      {
        uid: events[0].uid,
        calendarId: events[0].calendarId,
        calendarName: events[0].calendarName,
        color: events[0].color,
        title: events[0].title,
        startISO: events[0].startISO,
        endISO: events[0].endISO,
        tStart: events[0].tStart,
        tEnd: events[0].tEnd,
        allDay: events[0].allDay,
        multiDay: events[0].multiDay,
        recurring: events[0].recurring,
      },
      {
        uid: "work@x.com ev1",
        calendarId: "work@x.com",
        calendarName: "회사",
        color: "#3366cc",
        title: "주간 회의",
        startISO: "2026-03-05",
        endISO: "2026-03-05",
        tStart: null,
        tEnd: null,
        allDay: true,
        multiDay: false,
        recurring: false,
      },
      "ExternalEvent: 종일 하루 일정의 값"
    );

    const r1 = unsub();
    eq(r1 as unknown, true, "onChange: 해제 함수는 첫 호출에 true (Set.delete 반환값 — 특성 고정)");
    const r2 = unsub();
    eq(r2 as unknown, false, "onChange: 두 번 불러도 안전(false)");

    (feed as any).buckets.forEach((b: any, k: string) =>
      (feed as any).buckets.set(k, { ...b, fetchedAt: 1 })
    );
    (client as any).listEvents = async () => ({ items: [{ ...item, summary: "바뀜" }] });
    await feed.requestEvents("2026-03-01", "2026-03-31");
    eq(hits, 1, "onChange: 해제 뒤에는 알리지 않는다");
    eq(feed.peekEvents("2026-03-01", "2026-03-31")[0].title, "바뀜", "해제와 무관하게 캐시는 갱신된다");

    // 구독자가 던져도 다른 구독자와 호출부는 멀쩡하다
    let other = 0;
    feed.onChange(() => {
      throw new Error("bad subscriber");
    });
    feed.onChange(() => other++);
    (feed as any).buckets.forEach((b: any, k: string) =>
      (feed as any).buckets.set(k, { ...b, fetchedAt: 1 })
    );
    (client as any).listEvents = async () => ({ items: [{ ...item, summary: "또 바뀜" }] });
    let rejected = false;
    await quiet(() => feed.requestEvents("2026-03-01", "2026-03-31")).catch(() => (rejected = true));
    eq([rejected, other], [false, 1], "onChange: 던지는 구독자가 있어도 reject 없이 나머지에 알린다");

    // 같은 콜백을 두 번 구독해도 Set 이라 한 번만 불린다
    const feed2 = new EventFeed(okClient([item]).client, () => [CAL], () => true);
    let twice = 0;
    const cb = () => twice++;
    const u1 = feed2.onChange(cb);
    feed2.onChange(cb);
    await feed2.requestEvents("2026-03-01", "2026-03-31");
    eq(twice, 1, "onChange: 같은 콜백 중복 구독은 한 번으로 합쳐진다(Set) — 특성 고정");
    u1();
    (feed2 as any).buckets.forEach((b: any, k: string) =>
      (feed2 as any).buckets.set(k, { ...b, fetchedAt: 1 })
    );
    (feed2 as any).client.listEvents = async () => ({ items: [] });
    await feed2.requestEvents("2026-03-01", "2026-03-31");
    eq(twice, 1, "onChange: 중복 구독도 해제 한 번이면 전부 풀린다 — 특성 고정");
  }

  done();
})();
