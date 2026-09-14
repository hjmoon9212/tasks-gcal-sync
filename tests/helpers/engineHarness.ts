/**
 * SyncEngine.run() 을 스텁 의존성으로 구동하는 하네스와 픽스처.
 *
 * tests/reconcile.test.ts 에 있던 것을 그대로 옮겼다(0.12.0) — 골든·특성화 테스트가 같은
 * 스텁 계약을 공유해야 "같은 run 이 같은 호출을 만든다"를 비교할 수 있다.
 * ⚠️ 스텁은 실제 계약을 흉내내야 한다(writer 가 쓰기 뒤 인메모리 task 를 갱신하는 것 등).
 */
import { SyncEngine } from "../../src/sync/SyncEngine";
import { PreconditionFailedError } from "../../src/gcal/CalendarClient";
import { DEFAULT_SETTINGS, PluginSettings } from "../../src/settings/Settings";
import { PersistedState, SyncRecord } from "../../src/sync/StateStore";

export const CAL = "cal-1";
export const TODAY = "2026-08-06";

export type Ev = any;
export const doneEvent = (id: string, done: boolean, updated: string): Ev => ({
  id: "ev-" + id,
  updated,
  status: "confirmed",
  colorId: done ? "8" : undefined,
  summary: (done ? "☑️ " : "☐ ") + "샘플",
  start: { date: TODAY },
  end: { date: "2026-08-07" },
  extendedProperties: {
    private: {
      tgsTaskId: id,
      tgsVault: "vault",
      tgsDue: TODAY,
      tgsStart: TODAY,
      tgsDone: done ? "1" : "0",
      tgsTitle: "샘플",
    },
  },
});

/** 시간지정(타임블록) 이벤트 — 하루짜리. tgsTime 스냅샷까지 심는다. */
export const timedEvent = (id: string, date: string, range = "09:00-11:00"): Ev => {
  const [st, et] = range.split("-");
  return {
    id: "ev-" + id,
    updated: "100",
    status: "confirmed",
    summary: "☐ 샘플",
    start: { dateTime: `${date}T${st}:00`, timeZone: "Asia/Seoul" },
    end: { dateTime: `${date}T${et}:00`, timeZone: "Asia/Seoul" },
    extendedProperties: {
      private: {
        tgsTaskId: id,
        tgsVault: "vault",
        tgsDue: date,
        tgsStart: date,
        tgsTime: range,
        tgsDone: "0",
        tgsTitle: "샘플",
      },
    },
  };
};

/** GCal에서 지워진 이벤트가 pull 응답에 실려 오는 모양. */
export const cancelledEvent = (id: string): Ev => ({
  id: "ev-" + id,
  status: "cancelled",
});

export const task = (id: string, checked: boolean, due = TODAY) => ({
  id,
  checked,
  due,
  raw: `- [${checked ? "x" : " "}] #task 샘플 📅 ${due} 🆔 ${id}`,
  start: undefined,
  title: "샘플",
  tags: ["#task"],
  path: "note.md",
  line: 0,
  statusChar: checked ? "x" : " ",
  recurrence: undefined,
});

/** 호출 기록을 남기는 스텁 묶음. */
export function harness(opts: {
  tasks: any[];
  events: Ev[];
  records: Record<string, SyncRecord>;
  settings?: Partial<PluginSettings>;
  /** pull을 실패시킨다(원격 미확인 재현). */
  pullFails?: boolean;
  /** patch를 412로 실패시킨다(pull 이후 원격이 또 바뀐 상황 재현). */
  patchPrecondition?: boolean;
}) {
  const calls = {
    patch: [] as any[],
    insert: [] as any[],
    del: [] as string[],
    /** 미일정화(📅+🆔 동시 제거) 호출 — 0.9.0~ 엔진이 부르는 것은 이쪽이다. */
    unschedule: [] as string[],
    /** 되돌림 방어로 다시 쓴 줄. */
    rewrote: [] as string[],
    /** 전수 스캔(rebuildRecords) 호출 — timeMax 를 넘기는 건 이쪽뿐이다. */
    fullScan: 0,
    /** 노트에 실제로 쓴 것 — "가짜 충돌은 노트를 다시 쓰지 않는다"를 보려면 필요하다. */
    writes: [] as string[],
  };
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    defaultCalendarId: CAL,
    defaultCalendarName: "Test",
    ...opts.settings,
  };
  const state: PersistedState = { records: opts.records, syncTokens: {} };
  const app: any = { vault: { getName: () => "vault" }, internalPlugins: {} };
  const repo: any = { getTasks: async () => opts.tasks };
  const client: any = {
    listEvents: async (_c: string, params: any) => {
      if (params?.timeMax !== undefined) calls.fullScan++;
      if (opts.pullFails) throw new Error("pull 실패");
      return { items: opts.events, nextSyncToken: "tok" };
    },
    getEvent: async (_c: string, id: string) =>
      opts.events.find((e) => e.id === id),
    patchEvent: async (_c: string, id: string, patch: any, etag?: string) => {
      if (opts.patchPrecondition) throw new PreconditionFailedError("test");
      calls.patch.push({ id, patch, etag });
      return { ...opts.events.find((e) => e.id === id), updated: "9999" };
    },
    insertEvent: async (_c: string, ev: any) => {
      calls.insert.push(ev);
      return { ...ev, id: "new", updated: "9999" };
    },
    deleteEvent: async (_c: string, id: string) => {
      calls.del.push(id);
    },
    findByTaskId: async () => [],
  };
  const writer: any = {
    unschedule: async (t: any) => {
      calls.unschedule.push(t.id);
      calls.writes.push("unschedule");
      // 실제 TaskWriter 는 📅·🆔 를 뗀 줄을 다시 파싱해 인메모리 task 에 반영한다(refresh).
      t.due = undefined;
      t.id = undefined;
    },
    removeId: async (t: any) => {
      calls.writes.push("removeId");
      t.id = undefined;
    },
    rewriteLine: async (t: any, line: string) => {
      calls.writes.push("rewriteLine");
      calls.rewrote.push(line);
      t.raw = line;
    },
    // ⚠️ 실제 TaskWriter 는 쓰기 뒤 `refresh()` 로 **인메모리 task 의 파싱 필드를 갱신한다**
    //    (같은 run 안에서 이어지는 push 가 낡은 값을 올리지 않도록). 스텁도 그렇게 해야
    //    "pull 로 노트를 고친 뒤 스냅샷에 무엇이 남는가"를 제대로 검증할 수 있다.
    setDue: async (t: any, date: string) => {
      calls.writes.push("setDue");
      t.due = date;
    },
    setStart: async (t: any, date: string) => {
      calls.writes.push("setStart");
      t.start = date;
    },
    removeStart: async (t: any) => {
      calls.writes.push("removeStart");
      t.start = undefined;
    },
    setTime: async (t: any, range: string) => {
      calls.writes.push("setTime");
      t.time = range;
    },
    removeTime: async (t: any) => {
      calls.writes.push("removeTime");
      t.time = undefined;
    },
    replaceTitle: async (t: any, _from: string, to: string) => {
      calls.writes.push("replaceTitle");
      t.text = to;
    },
    ensureId: async (t: any, id: string) => {
      t.id = id; // refresh 가 새 🆔 를 읽어 온다
    },
    wroteRecently: () => false,
  };
  const engine = new SyncEngine(
    app,
    settings,
    state,
    repo,
    client,
    writer,
    async () => {}
  );
  // 기본은 "콜드 스타트 지난 + 볼트가 정착한 상태" — 각각은 따로 테스트한다.
  (engine as any).loadedAt = Date.now() - 10 * 60_000;
  (engine as any).pullCycleDone = true;
  (engine as any).settledSince = Date.now() - 10 * 60_000;
  return { engine, calls, state, settings, client, writer, app };
}

export const rec = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  eventId: "ev-A1",
  calendarId: CAL,
  due: TODAY,
  start: TODAY,
  done: false,
  title: "샘플",
  gcalUpdated: "100",
  ...over,
});
