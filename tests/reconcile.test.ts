/**
 * 조정 루프의 방향 판정 테스트 — 2026-08-06 롤백 사고(가짜 기준선 + 스테일 노트)가
 * 다시 나지 않는지 확인한다. 실제 SyncEngine에 스텁 의존성을 물려 run()을 돌린다.
 */
import { SyncEngine } from "../src/sync/SyncEngine";
import { PreconditionFailedError } from "../src/gcal/CalendarClient";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/settings/Settings";
import { PersistedState, SyncRecord } from "../src/sync/StateStore";
import { addDays, todayStr } from "../src/sync/dates";

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

const CAL = "cal-1";
const TODAY = "2026-08-06";

type Ev = any;
const doneEvent = (id: string, done: boolean, updated: string): Ev => ({
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
const timedEvent = (id: string, date: string, range = "09:00-11:00"): Ev => {
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
const cancelledEvent = (id: string): Ev => ({
  id: "ev-" + id,
  status: "cancelled",
});

const task = (id: string, checked: boolean, due = TODAY) => ({
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
function harness(opts: {
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
    ensureId: async () => {},
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
  return { engine, calls, state, settings, client };
}

const rec = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  eventId: "ev-A1",
  calendarId: CAL,
  due: TODAY,
  start: TODAY,
  done: false,
  title: "샘플",
  gcalUpdated: "100",
  ...over,
});

(async () => {
  // ── 2) 신뢰 기준선 + 진짜 체크 해제 → 첫 run은 보류, 다음 사이클에 push
  {
    const ev = doneEvent("A1", true, "200");
    const h = harness({
      tasks: [task("A1", false)],
      events: [ev],
      records: { A1: rec({ done: true, gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 0, "진짜 해제: 첫 관측은 보류");
    eq(h.state.records.A1.done, true, "보류 중에는 스냅샷을 안 내린다");
    eq(
      typeof h.state.records.A1.uncheckSeenAt,
      "number",
      "보류 시각을 기록한다"
    );

    // 한 사이클(대기 시간) 지난 뒤 재실행 → 이번엔 올라간다
    h.state.records.A1.uncheckSeenAt = Date.now() - 120_000;
    await h.engine.run();
    eq(h.calls.patch.length, 1, "대기 뒤에는 체크 해제를 push");
    eq(h.state.records.A1.done, false, "push 후 스냅샷 갱신");
  }

  // ── 3) ★★ 캘린더를 읽지 못하면 그 캘린더에는 **쓰지도 않는다**(0.9.0~)
  //
  //     예전에는 pull 이 실패해도 run 이 그대로 이어졌다. 그러면 그 캘린더의 이벤트는
  //     `remote = undefined` 로 들어와 "GCal은 안 바뀜"으로 읽히고, 노트 변경만 참이라
  //     **원격을 못 본 채로 push 가 나갔다** — 그 사이 사람이 캘린더에서 고쳐 뒀다면
  //     그대로 덮인다. push 는 이벤트 전체를 다시 그리므로 "완료만 올린다"도 성립하지 않는다.
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", true, "200")],
      records: { A1: rec({ done: true, gcalUpdated: "200" }) },
      pullFails: true,
    });
    const r = await h.engine.run();
    eq(h.calls.patch.length, 0, "읽지 못한 캘린더에 push하지 않는다 ★");
    eq(h.calls.writes, [], "노트도 건드리지 않는다 ★");
    eq(h.state.records.A1.done, true, "스냅샷 그대로 — 다음 run이 다시 판정한다");
    eq(
      r.entries.some((e) => (e.detail ?? "").includes("캘린더를 읽지 못함")),
      true,
      "무엇을 왜 건너뛰었는지 로그에 남는다"
    );
  }

  // ── 4) 콜드 스타트: 로드 직후 run은 원격에 아무것도 쓰지 않는다
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09"), task("B2", false)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    (h.engine as any).loadedAt = Date.now(); // 방금 로드됨
    (h.engine as any).pullCycleDone = false;
    await h.engine.run();
    eq(h.calls.patch.length, 0, "콜드 스타트: 기존 이벤트 push 없음");
    eq(h.calls.insert.length, 0, "콜드 스타트: 새 이벤트 생성 없음");
    eq(h.state.records.A1.due, TODAY, "콜드 스타트: 못 올린 변경을 스냅샷에 안 남김");
    eq((h.engine as any).pullCycleDone, true, "pull 완주 → 잠금 해제 준비");
  }

  // ── 5) 회귀 확인: 평상시 날짜 변경은 그대로 올라간다
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "정상: 날짜 변경 push");
    eq(h.state.records.A1.due, "2026-08-09", "정상: 스냅샷 갱신");
  }

  // ── 6) 회귀 확인: 완료(미완료 → 완료)는 보류 대상이 아니다
  {
    const h = harness({
      tasks: [task("A1", true)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "완료 방향은 즉시 push");
    eq(h.state.records.A1.done, true, "완료 스냅샷 갱신");
  }

  // ── 7) 볼트가 동기화 중이면 run 전체를 건너뛴다
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    (h.engine as any).app.internalPlugins = {
      plugins: { sync: { instance: { getStatus: () => "Syncing" } } },
    };
    const r = await h.engine.run();
    eq(h.calls.patch.length, 0, "볼트 뒤처짐: push 없음");
    eq(r.skipped, 1, "볼트 뒤처짐: run 보류로 표시");
    // 보류만 하고 끝내면 다음 주기(5분)까지 방치된다 → 재확인을 예약시킨다
    eq(r.retryAfterMs, 15_000, "볼트 뒤처짐: 재확인 시각을 돌려준다");

    // fail-open 상한은 **횟수가 아니라 시간**이다. 재확인이 15초로 촘촘해진 뒤로
    // 횟수 상한(옛 5회)은 75초 만에 보호를 풀어버려 제거했다.
    for (let i = 0; i < 6; i++) await h.engine.run();
    eq(h.calls.patch.length, 0, "짧게 여러 번 보류해도 상한은 안 풀린다");
    (h.engine as any).behindSince = Date.now() - 11 * 60_000;
    await h.engine.run();
    eq(h.calls.patch.length >= 1, true, "fail-open 시간 상한 초과 후에는 통과");
  }

  // ── 7-b) 상태 문자열 없이 `syncing` 불리언만 있어도 뒤처짐으로 본다
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    (h.engine as any).app.internalPlugins = {
      plugins: { sync: { instance: { syncing: true, syncStatus: "" } } },
    };
    const r = await h.engine.run();
    eq(h.calls.patch.length, 0, "syncing 불리언: push 없음");
    eq(r.skips["vault-behind"], 1, "syncing 불리언: 뒤처짐으로 집계");
  }

  // ── 7-c) fail-open: 판정할 근거가 없으면 통과시킨다(가드가 기능을 끄면 안 된다)
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    (h.engine as any).app.internalPlugins = {
      plugins: { sync: { instance: { getStatus: () => "synced" } } },
    };
    await h.engine.run();
    eq(h.calls.patch.length >= 1, true, "synced 토큰: 평소대로 통과");
  }

  // ── 8) GCal에서 이벤트를 지워도 **완료된** 줄의 📅는 건드리지 않는다.
  //     반복(🔁) task는 회차마다 별도 이벤트가 쌓여 캘린더 정리가 잦은데, 그때마다
  //     완료 회차의 due가 노트에서 사라졌다(2026-08-07).
  {
    const h = harness({
      tasks: [task("A1", true)],
      events: [cancelledEvent("A1")],
      records: { A1: rec({ done: true }) },
    });
    await h.engine.run();
    eq(h.calls.unschedule, [], "완료 줄: 이벤트가 지워져도 📅·🆔 유지");
    eq(h.state.records.A1, undefined, "완료 줄: record는 정리");
  }

  // ── 9) 미완료 줄은 기존대로 미일정화한다
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [cancelledEvent("A1")],
      records: { A1: rec() },
    });
    await h.engine.run();
    eq(h.calls.unschedule, ["A1"], "미완료 줄: 미일정화(📅+🆔)");
    eq(h.state.records.A1, undefined, "미완료 줄: record 정리");
  }

  // ── 10) 콜드 스타트에서는 미일정화도 보류한다
  //      (남의 기기가 중복정리·캘린더이동으로 만든 cancelled일 수 있다)
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [cancelledEvent("A1")],
      records: { A1: rec() },
    });
    (h.engine as any).loadedAt = Date.now();
    (h.engine as any).pullCycleDone = false;
    await h.engine.run();
    eq(h.calls.unschedule, [], "콜드 스타트: 미일정화 보류");
    eq(h.state.records.A1 !== undefined, true, "콜드 스타트: record 유지");
  }

  // ── 10-b) 콜드 스타트 run은 잠금이 풀리는 시점을 돌려준다.
  //      안 그러면 60초에 잠금이 풀려도 깨우는 사람이 없어 5분 틱까지 기다린다.
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    (h.engine as any).loadedAt = Date.now() - 20_000;
    (h.engine as any).pullCycleDone = false;
    const r = await h.engine.run();
    eq(h.calls.patch.length, 0, "콜드 스타트: GCal 쓰기 없음");
    // 남은 40초 + 여유 2초. 실행 시간만큼 오차가 나므로 범위로 본다.
    const ok = r.retryAfterMs! > 39_000 && r.retryAfterMs! <= 42_000;
    eq(ok, true, `콜드 스타트: 잠금 만료 시점 예약 (실제 ${r.retryAfterMs})`);
  }

  // ── 10-c) pull이 실패했으면 예약하지 않는다.
  //      시간이 다 지나도 pullCycleDone이 false면 다음 run도 콜드다 — 예약하면
  //      2초 간격으로 되돈다. 그 경우는 기존 주기 동기화가 재시도한다.
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
      pullFails: true,
    });
    (h.engine as any).loadedAt = Date.now();
    (h.engine as any).pullCycleDone = false;
    const r = await h.engine.run();
    eq(r.retryAfterMs, undefined, "콜드 스타트 + pull 실패: 예약 없음");
  }

  // -- 11) due를 잃은 task: 평상시엔 이벤트를 지운다(400 무한반복 방지, 0.3.5)
  {
    const h = harness({
      tasks: [{ ...task("A1", false), due: undefined }],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec() },
    });
    await h.engine.run();
    eq(h.calls.del, ["ev-A1"], "due 유실: 이벤트 삭제");
    eq(h.state.records.A1, undefined, "due 유실: record 정리");
  }

  // -- 12) 같은 상황이라도 콜드 스타트에는 지우지 않는다.
  //     📅가 있는 줄이 아직 Sync로 안 내려왔을 뿐일 수 있다 — 다른 파괴 경로와 같은 가드.
  {
    const h = harness({
      tasks: [{ ...task("A1", false), due: undefined }],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec() },
    });
    (h.engine as any).loadedAt = Date.now();
    (h.engine as any).pullCycleDone = false;
    await h.engine.run();
    eq(h.calls.del, [], "콜드 스타트: due 유실이어도 삭제 보류");
    eq(h.state.records.A1 !== undefined, true, "콜드 스타트: record 유지");
  }

  // -- 13) 이번 스캔에서 처음 주운 record(adopted)도 같은 이유로 보류한다
  {
    const h = harness({
      tasks: [{ ...task("A1", false), due: undefined }],
      events: [doneEvent("A1", false, "200")],
      records: {}, // 비어 있음 → run()이 rebuildRecords로 입양
    });
    await h.engine.run();
    eq(h.calls.del, [], "입양 직후: due 유실이어도 삭제 보류");
    eq(h.state.records.A1 !== undefined, true, "입양 직후: record 유지");
  }

  // -- 14) 다른 볼트가 만든 이벤트는 입양하지도, 지우지도 않는다.
  //     매핑키(tgsTaskId)는 볼트 안에서만 유일하다 — 같은 캘린더를 공유하면
  //     남의 이벤트를 record로 삼고 "task 없음 → 삭제"로 지워버린다.
  {
    const foreign = doneEvent("Z9", false, "200");
    foreign.extendedProperties.private.tgsVault = "other-vault";
    const h = harness({ tasks: [], events: [foreign], records: {} });
    await h.engine.run({ fullScan: true });
    eq(h.state.records.Z9, undefined, "다른 볼트 이벤트: 입양 안 함");
    eq(h.calls.del, [], "다른 볼트 이벤트: 삭제 안 함");
  }

  // -- 15) tgsVault가 없는 옛 이벤트는 종전대로 입양한다(backfill 전 데이터)
  {
    const legacy = doneEvent("Y8", false, "200");
    delete legacy.extendedProperties.private.tgsVault;
    const h = harness({ tasks: [], events: [legacy], records: {} });
    await h.engine.run({ fullScan: true });
    eq(h.state.records.Y8 !== undefined, true, "tgsVault 없는 옛 이벤트: 입양");
    eq(h.calls.del, [], "입양 직후 run에서는 지우지 않는다");
  }

  // -- 17) 노트에서 체크 해제 → 보류 후 push할 때 free/완료색이 실제로 풀린다.
  //     그리고 보류가 풀리는 시점을 호출부에 알려 후속 run이 예약되게 한다
  //     (안 그러면 다음 주기까지 GCal이 그대로라 "아무 일도 없다"로 보인다).
  {
    const ev = doneEvent("A1", true, "200");
    const h = harness({
      tasks: [task("A1", false)],
      events: [ev],
      records: { A1: rec({ done: true, gcalUpdated: "200" }) },
    });
    const first = await h.engine.run();
    eq(h.calls.patch.length, 0, "해제 첫 관측: 보류");
    eq(typeof first.retryAfterMs, "number", "보류 시 재시도 시각을 알린다");

    h.state.records.A1.uncheckSeenAt = Date.now() - 120_000;
    const second = await h.engine.run();
    eq(h.calls.patch.length, 1, "대기 뒤 push");
    const patch = h.calls.patch[0].patch;
    eq(patch.summary, "☐ 샘플", "해제: 제목 접두사 미완료로");
    eq(patch.colorId, null, "해제: 완료색 제거");
    eq(patch.transparency, undefined, "해제: 바쁨/한가함은 건드리지 않는다");
    eq(second.retryAfterMs, undefined, "push했으면 재시도 예약 없음");
  }

  // -- 18) **완료는 노트가 소유한다**: 이벤트가 완료로 바뀌어도 노트를 건드리지 않는다.
  //     GCal엔 완료 어휘가 없어 색·제목을 빌려 읽어야 했고, 오탐의 결과가 노트에 ✅를
  //     쓰는 것이라 파괴적이었다(0.4.0에서 pull 방향 제거).
  {
    const ev = doneEvent("A1", true, "300"); // 회색 + ☑️ 제목으로 바뀜
    const h = harness({
      tasks: [task("A1", false)],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    await h.engine.run();
    eq(h.state.records.A1.done, false, "이벤트가 완료여도 스냅샷은 미완료 그대로");
    eq(h.calls.unschedule, [], "노트를 건드리지 않는다");
    eq(h.calls.patch.length, 0, "되돌려 쓰지도 않는다");
  }

  // -- 19) 반대 방향(노트 → 이벤트)은 그대로 동작한다
  {
    const h = harness({
      tasks: [task("A1", true)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "노트 완료 → 이벤트 push");
    const patch = h.calls.patch[0].patch;
    eq(patch.summary, "☑️ 샘플", "이벤트 제목이 완료로");
    eq(patch.colorId, "8", "이벤트 색이 완료색으로");
  }

  // -- 20) 완료일(✅)은 이벤트에 실린다
  {
    const h = harness({
      tasks: [{ ...task("A1", true), done: "2026-08-07" }],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "완료를 push");
    eq(
      h.calls.patch[0].patch.extendedProperties.private.tgsDoneAt,
      "2026-08-07",
      "완료일을 이벤트에 싣는다"
    );
  }

  // -- 21) 해제 push엔 완료일 키를 빼서, 이벤트에 직전 완료일이 남게 한다
  //    노트에서 실수로 풀려도 "언제 완료였는지"를 잃지 않는 유일한 사본이다(2026-08-09 CISS).
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", true, "200")],
      records: {
        A1: rec({
          done: true,
          gcalUpdated: "200",
          uncheckSeenAt: Date.now() - 120_000,
        }),
      },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "대기 뒤 해제를 push");
    eq(
      "tgsDoneAt" in h.calls.patch[0].patch.extendedProperties.private,
      false,
      "해제 push엔 완료일 키를 안 보낸다"
    );
  }

  // -- 20) 캘린더 전수 스캔은 하루 1회. 매 실행마다 ±2년치를 훑지 않는다.
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    h.state.lastFullScanAt = Date.now() - 1000; // 방금 훑었음
    await h.engine.run();
    eq(h.calls.fullScan, 0, "최근에 훑었으면 전수 스캔 안 함");

    h.state.lastFullScanAt = Date.now() - 25 * 60 * 60 * 1000; // 하루 지남
    await h.engine.run();
    eq(h.calls.fullScan > 0, true, "하루 지나면 다시 훑는다");
  }

  // -- 21) 캐시가 비었으면 간격과 무관하게 즉시 훑는다(유일한 복구 경로)
  {
    const h = harness({ tasks: [], events: [], records: {} });
    h.state.lastFullScanAt = Date.now();
    await h.engine.run();
    eq(h.calls.fullScan > 0, true, "records 가 비면 즉시 전수 스캔");
  }

  // -- 22) 수동 명령(fullScan)은 간격을 무시한다
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    h.state.lastFullScanAt = Date.now();
    await h.engine.run({ fullScan: true });
    eq(h.calls.fullScan > 0, true, "명시적 요청은 항상 훑는다");
  }

  // -- 23) 이벤트 설명의 **사용자 메모를 보존**한다(v0.4.3).
  //     예전엔 매 push 마다 설명을 우리 블록으로 통째로 갈아치워, GCal 에 적어 둔
  //     메모가 사라졌다.
  {
    const ev = doneEvent("A1", false, "200");
    ev.description = `회의실 3층
준비물: 노트북
📁 vault
🆔 A1`;
    const h = harness({
      tasks: [task("A1", true)],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    const d: string = h.calls.patch[0].patch.description;
    eq(d.startsWith("회의실 3층"), true, "사용자 메모 보존");
    eq(d.includes("준비물: 노트북"), true, "여러 줄 메모도 보존");
    eq(d.includes("🆔 A1"), true, "우리 블록도 다시 찍힌다");
    eq((d.match(/🆔 A1/g) ?? []).length, 1, "구버전 블록을 걷어내 중복되지 않는다");
  }

  // -- 24) 마커가 이미 있으면 그 아래만 갈아친다
  {
    const ev = doneEvent("A1", false, "200");
    ev.description = `메모

— tasks-gcal-sync —
📁 vault
🆔 A1
🔗 old-link`;
    const h = harness({
      tasks: [task("A1", true)],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    const d: string = h.calls.patch[0].patch.description;
    eq(d.startsWith("메모"), true, "마커 위는 그대로");
    eq(d.includes("old-link"), false, "마커 아래는 새로 씀");
  }

  // -- 25) 이벤트를 손에 못 쥔 run 은 description 을 아예 안 보낸다.
  //     현재 값을 모르는 채 쓰면 사용자 메모를 날린다 — patch 는 키 단위 병합이라
  //     키를 빼면 이벤트의 설명이 그대로 남는다.
  {
    const h = harness({
      tasks: [task("A1", false, "2026-08-11")],
      events: [],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "날짜 변경은 push 된다");
    eq("description" in h.calls.patch[0].patch, false, "설명을 모르면 그 키를 안 보낸다");
  }

  // -- 26) skip 은 **사유와 함께** 센다. 합계만 있으면 원인을 못 찾는다
  //     (2026-07-21 "도는 것 같은데 아무것도 안 바뀜" 의 사각지대).
  {
    const h = harness({
      tasks: [task("A1", false), task("A1", false)], // 같은 🆔 두 줄
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    const r = await h.engine.run();
    eq(r.skipped, 1, "건너뛴 건수");
    eq(r.skips["duplicate-id"], 1, "사유가 함께 기록된다");
    eq(r.failures, [], "정상 보류는 실패가 아니다");
  }

  // -- 27) 항목별 실패는 예외로 새지 않고 result.failures 에 남는다.
  //     전부 catch 로 삼키고 상태바에 ✓ 를 찍던 게 07-21 사고를 며칠 끌었다.
  {
    const h = harness({
      tasks: [task("A1", true)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    h.client.patchEvent = async () => {
      throw new Error("GCal PATCH 401: invalid_client");
    };
    const r = await h.engine.run();
    eq(r.skips["reconcile-error"], 1, "조정 실패로 분류");
    eq(r.failures.length, 1, "실패가 결과에 남는다");
    eq(r.failures[0].where, "A1", "어느 항목인지");
    eq(r.failures[0].message.includes("invalid_client"), true, "원인 메시지 보존");
    eq(r.entries.filter((e) => e.action === "FAIL").length, 1, "로그에도 남는다");
  }

  // ── 11-b) 종일 이벤트에 ⏰ 를 새로 붙이면 PATCH 가 400 나던 것(2026-08-16).
  //     PATCH 는 병합이라 start 에 date 가 남은 채 dateTime 이 더해져
  //     "Invalid start time" 이 됐다 — 반대편 표현을 null 로 지워야 한다.
  {
    const ev = doneEvent("A1", false, "200"); // 종일 이벤트(start.date)
    const h = harness({
      tasks: [{ ...task("A1", false), time: "07:45-10:00" }], // 노트에 ⏰ 추가됨
      events: [ev],
      records: { A1: rec({ gcalUpdated: "200" }) }, // 스냅샷은 종일(time 없음)
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "⏰ 추가 → push 발생");
    const p = h.calls.patch[0].patch;
    eq(p.start.dateTime, "2026-08-06T07:45:00", "시작 시각을 보낸다");
    eq(p.end.dateTime, "2026-08-06T10:00:00", "종료 시각을 보낸다");
    eq(p.start.date, null, "종일 표현(start.date)을 명시적으로 지운다");
    eq(p.end.date, null, "종일 표현(end.date)을 명시적으로 지운다");
  }
  {
    // 반대 방향(종일 patch)도 한 가지 표현만 남긴다 — 시간 표현이 섞여 들어가면
    // 같은 400 이 반대쪽에서 난다.
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")], // ⏰ 없음, 날짜만 변경
      events: [doneEvent("A1", false, "200")], // 종일 이벤트
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
    await h.engine.run();
    const p = h.calls.patch[0].patch;
    eq(p.start.date, "2026-08-09", "종일 날짜를 보낸다");
    eq(p.start.dateTime, null, "시간 표현(dateTime)을 명시적으로 지운다");
    eq(p.start.timeZone, null, "시간대도 지운다");
  }
  {
    // ⏰ 가 없는 task 는 GCal 에서 사람이 지정한 시각을 보존한다(0.5.0 설계).
    // 그 경로에서도 종일 표현이 남지 않아야 한다.
    // **rec.time 이 비어 있다**는 게 "우리가 시각을 올린 적 없다 = GCal 쪽 것" 의 근거다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { dateTime: "2026-08-06T07:45:00", timeZone: "Asia/Seoul" };
    ev.end = { dateTime: "2026-08-06T10:00:00", timeZone: "Asia/Seoul" };
    const h = harness({
      tasks: [task("A1", false, "2026-08-09")],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "200" }) }, // time 없음 = 우리가 올린 시각 아님
    });
    await h.engine.run();
    const p = h.calls.patch[0].patch;
    eq(p.start.dateTime, "2026-08-09T07:45:00", "시각은 보존한 채 날짜만 민다");
    eq(p.start.date, null, "종일 표현을 지운다");
  }
  {
    // ── 노트에서 ⏰ 를 떼면 GCal 도 종일로 돌아가야 한다(2026-08-16).
    // 위 보존 분기가 이 경우까지 삼켜서, 노트에서 지워도 이벤트는 시간지정으로 남았다.
    // 구분 기준은 rec.time — 차 있으면 "우리가 올렸던 시각이 사라진 것" 이다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { dateTime: "2026-08-06T07:45:00", timeZone: "Asia/Seoul" };
    ev.end = { dateTime: "2026-08-06T10:00:00", timeZone: "Asia/Seoul" };
    const h = harness({
      tasks: [task("A1", false)], // 노트에서 ⏰ 제거됨(날짜는 그대로)
      events: [ev],
      records: { A1: rec({ time: "07:45-10:00", gcalUpdated: "200" }) },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "⏰ 제거 → push 발생");
    const p = h.calls.patch[0].patch;
    eq(p.start.date, "2026-08-06", "종일로 되돌린다");
    eq(p.start.dateTime, null, "시간 표현을 지운다");
    eq(p.start.timeZone, null, "시간대도 지운다");
    eq(p.end.dateTime, null, "종료의 시간 표현도 지운다");
  }

  // ── 12) 로그 항목: 사후에 "무엇이 왜"에 답할 수 있어야 한다.
  //     카운터만으로는 삭제 한 건의 이유도, 충돌에서 무엇이 버려졌는지도 알 수 없다.
  {
    // (a) task가 사라져 이벤트를 지운 경우 — 사유와 마지막 스냅샷이 남는가
    const h = harness({
      tasks: [],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    const r = await h.engine.run();
    eq(r.deleted, 1, "task 없음 → 삭제");
    const del = r.entries.find((e) => e.action === "DELETE")!;
    eq(del.id, "A1", "삭제 기록: 어느 task인지");
    eq(del.eventId, "ev-A1", "삭제 기록: 어느 이벤트인지");
    eq(del.detail!.includes("task 줄이 사라짐"), true, "삭제 기록: 사유");
    eq(del.detail!.includes(TODAY), true, "삭제 기록: 마지막 스냅샷 due");
  }
  {
    // (b) 같은 필드를 양쪽에서 다른 값으로 수정 — **원격 변경이 메아리**인 경우.
    //     tgs* 스탬프가 이벤트의 현재 값과 **같다** = 어느 기기가 이 값을 올린 것이지
    //     사람이 캘린더에서 고친 게 아니다 → 노트를 채택하고 노트 값을 올린다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    ev.extendedProperties.private.tgsDue = "2026-08-20";
    ev.extendedProperties.private.tgsStart = "2026-08-20";
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")], // 노트도 같은 필드(due)를 바꿨다
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    const r = await h.engine.run();
    const merged = r.entries.find((e) => e.action === "PULL" || e.action === "UPDATE")!;
    eq(merged.id, "A1", "충돌 기록: 대상");
    eq(merged.detail!.includes("⚔️ 충돌"), true, "충돌 기록: 충돌 표시");
    eq(merged.detail!.includes("2026-08-19"), true, "충돌 기록: 채택된 노트 값");
    eq(merged.detail!.includes("2026-08-20"), true, "충돌 기록: 폐기된 GCal 값");
    eq(merged.detail!.includes("노트 채택"), true, "충돌 기록: 승자");
    eq(merged.where, "note.md:1", "충돌 기록: 노트 위치");
    eq(h.calls.writes, [], "메아리: GCal 값을 노트에 쓰지 않는다");
    eq(h.calls.patch.length, 1, "메아리: 노트 값을 GCal로 올린다");
  }
  {
    // (b-2) ★★ 같은 상황인데 **사람이 GCal에서 고쳤다**(0.9.0~).
    //       스탬프는 우리가 마지막에 올린 옛 값 그대로인데 이벤트만 옮겨져 있다 →
    //       플러그인 밖에서 바뀐 것 = 사람의 편집이므로 **GCal이 이긴다.**
    //       (b)와 픽스처 차이가 tgs* 하나뿐이라는 점이 이 판별의 전부다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    // tgsDue/tgsStart 는 TODAY 그대로 — 우리가 올린 뒤 사람이 옮겼다는 뜻이다.
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    const r = await h.engine.run();
    const merged = r.entries.find((e) => e.action === "PULL" || e.action === "UPDATE")!;
    eq(merged.detail!.includes("GCal 채택"), true, "사람 편집: 승자는 GCal ★");
    eq(merged.detail!.includes("사람이 캘린더에서 편집"), true, "사람 편집: 사유");
    eq(merged.detail!.includes("2026-08-19"), true, "사람 편집: 폐기된 노트 값도 남긴다");
    eq(h.calls.writes.includes("setDue"), true, "사람 편집: GCal 값을 노트에 쓴다 ★");
    eq(h.state.records.A1.due, "2026-08-20", "사람 편집: 스냅샷도 GCal 값");
  }
  {
    // (b-3) ★ 날짜 둘은 **한 구간**이라 함께 넘어간다.
    //       🛫만 사람이 옮겼어도 📅까지 GCal 것으로 맞춰야 아무도 정한 적 없는 구간이
    //       만들어지지 않는다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-18" }; // 사람이 🛫만 앞으로 당겼다
    ev.end = { date: "2026-08-21" };
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    await h.engine.run();
    eq(h.state.records.A1.due, "2026-08-20", "구간 전체가 GCal 것 (📅)");
    eq(h.state.records.A1.start, "2026-08-18", "구간 전체가 GCal 것 (🛫) ★");
    // 표현 정규화(☐ 접두사 다시 찍기)는 돌지만 **날짜는 실리지 않는다** —
    // GCal 이 방금 정한 일정을 되돌리면 안 된다.
    eq(h.calls.patch.length, 1, "표현만 다시 찍는다");
    eq(h.calls.patch[0].patch.start, undefined, "노트 날짜를 되올리지 않는다 ★");
  }
  {
    // (c) 양쪽 다 기준선과 다르지만 **값이 같다** → 충돌이 아니다.
    //     며칠 꺼둔 기기를 켜면 기준선만 뒤처져 이 모양이 된다. 예전엔 이걸 충돌로 세어
    //     같은 값을 노트에 다시 쓰고(→ modify → 자동 push) 로그를 "폐기"로 채웠다.
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    ev.extendedProperties.private.tgsDue = "2026-08-20";
    ev.extendedProperties.private.tgsStart = "2026-08-20";
    const h = harness({
      tasks: [task("A1", false, "2026-08-20")], // 노트도 같은 값으로 바뀌어 있다
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    const r = await h.engine.run();
    eq(h.calls.writes, [], "합의: 노트를 다시 쓰지 않는다 ★");
    eq(h.calls.patch, [], "합의: GCal도 건드리지 않는다 ★");
    eq(r.pulled, 0, "합의: pull 카운트 없음");
    eq(r.updated, 0, "합의: update 카운트 없음");
    eq(
      r.entries.some((e) => (e.detail ?? "").includes("충돌")),
      false,
      "합의: 로그에 충돌로 남기지 않는다 ★"
    );
    eq(h.state.records.A1.due, "2026-08-20", "합의: 기준선만 앞당긴다");
    eq(h.state.records.A1.gcalUpdated, "200", "합의: 다음 run이 또 보지 않도록 updated도 갱신");
  }
  {
    // (d) 조용한 run은 로그를 남기지 않는다 — 5분마다 "변화 없음"이 쌓이면
    //     정작 찾아야 할 삭제 한 줄이 묻힌다.
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    const r = await h.engine.run();
    eq(r.entries, [], "아무 일도 없으면 기록도 없다");
  }

  /*
   * ── 정착 전에는 지우지 않는다 · 지웠으면 원문을 남긴다 (v0.8.1) ──────────────
   *
   * 2026-09-07 실제 사건: 갤탭에서 task 추가 → Windows 로 Sync → 사용자가 다른 md 로
   * 잘라내기·붙여넣기 → 편집이 Sync 경합으로 되돌아가 노트에서 줄이 사라짐 →
   * 플러그인이 그 상태를 정확히 읽고 이벤트를 지웠다. 로그에 남은 건 `마지막 스냅샷
   * due=…` 뿐이라 복구하려면 Obsidian 버전 기록을 뒤져야 했다.
   *
   * 삭제가 통과한 지점은 **40분짜리 보류 구간 두 개 사이의 2초 틈**이었다.
   */
  {
    // (a) 볼트가 막 정착하기 시작했으면(=순간 틈) 줄이 사라져도 지우지 않는다
    const h = harness({
      tasks: [],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ lastLine: "- [ ] #task 음산협 계약서 변경건 확인 📅 2026-09-07 🆔 A1", lastWhere: "note.md:45" }) },
    });
    (h.engine as any).settledSince = Date.now() - 1_000; // 1초 전에야 조용해졌다
    const r = await h.engine.run();
    eq(h.calls.del, [], "정착 전이면 줄이 사라져도 이벤트를 지우지 않는다 ★");
    eq(!!h.state.records.A1, true, "record 도 유지된다");
    eq(r.skips["hold-task-gone"], 1, "보류 사유가 집계된다");
    eq((r.retryAfterMs ?? 0) > 0, true, "정착되면 다시 보도록 후속 run 을 예약한다");
  }
  {
    // (b) 정착한 뒤에는 정상적으로 지우고, **무엇을 지웠는지 원문을 남긴다**
    const LINE = "- [ ] #task 음산협 계약서 변경건 확인 📅 2026-09-07 🆔 A1";
    const h = harness({
      tasks: [],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ lastLine: LINE, lastWhere: "note.md:45" }) },
    });
    const r = await h.engine.run();
    eq(h.calls.del, ["ev-A1"], "정착 후에는 지운다");
    const del = r.entries.find((e) => e.action === "DELETE")!;
    eq(del.detail!.includes(LINE), true, "삭제 기록에 원문 줄이 그대로 남는다 ★★");
    eq(del.detail!.includes("note.md:45"), true, "어느 노트 몇 번째 줄이었는지도 남는다");
  }
  {
    // (c) 줄이 보이는 동안 원문을 계속 보관한다 — 사라진 뒤에는 읽을 방법이 없다.
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    await h.engine.run();
    eq(
      h.state.records.A1.lastLine,
      "- [ ] #task 샘플 📅 2026-08-06 🆔 A1",
      "마지막으로 본 줄 원문을 record 에 보관한다"
    );
    eq(h.state.records.A1.lastWhere, "note.md:1", "위치도 함께 보관한다");
  }
  {
    // (d) 새 🆔 발급도 정착 뒤에만 — 노트에 쓰는 동작이라 편집·Sync 와 겹친다.
    const h = harness({
      tasks: [{ ...task("", false, todayStr()), id: "" }],
      events: [],
      records: {},
    });
    (h.engine as any).settledSince = Date.now() - 1_000;
    const r = await h.engine.run();
    eq(h.calls.insert, [], "정착 전에는 새 이벤트를 만들지 않는다");
    eq(r.skips["unsettled-create"], 1, "보류 사유가 집계된다");
  }

  /*
   * ── 🛫 다중일 + ⏰: 시각은 무시하고 종일 블록으로 ──────────────────────────────
   * GCal 의 시간지정 이벤트는 "첫날 시작시각 → 마지막날 종료시각" 한 덩어리라,
   * ⏰ 09:00-11:00 에 3일 span 을 얹으면 매일 09-11시가 아니라 50시간짜리 통짜
   * 블록이 된다. "여러 날 · 매일 같은 시간대"는 반복 이벤트라야 표현되므로,
   * 표현 못 하는 것을 억지로 만들지 않고 종일 다중일 블록으로 둔다.
   *
   * 창(window) 밖 task 는 생성되지 않으므로 날짜는 오늘 기준으로 만든다.
   */
  const D1 = addDays(todayStr(), 1);
  const D3 = addDays(todayStr(), 3);

  {
    const h = harness({
      tasks: [{ ...task("M1", false, D3), start: D1, time: "09:00-11:00" }],
      events: [],
      records: {},
    });
    await h.engine.run();
    eq(h.calls.insert.length, 1, "다중일+⏰: 이벤트 생성");
    const ev = h.calls.insert[0];
    eq(ev.start, { date: D1 }, "다중일+⏰: 🛫부터 종일로 시작");
    eq(ev.end, { date: addDays(D3, 1) }, "다중일+⏰: 📅+1일(배타적)로 끝");
    eq(
      h.state.records.M1.time,
      "",
      "다중일+⏰: 스냅샷도 종일 — 다음 run 이 되밀지 않는다"
    );
  }

  {
    // 🛫 == 📅 는 하루짜리다 → 시각을 그대로 쓴다(경계).
    const h = harness({
      tasks: [{ ...task("S1", false, D1), start: D1, time: "09:00-11:00" }],
      events: [],
      records: {},
    });
    await h.engine.run();
    const ev = h.calls.insert[0];
    eq(ev.start.dateTime, `${D1}T09:00:00`, "🛫=📅: 시간지정 유지(시작)");
    eq(ev.end.dateTime, `${D1}T11:00:00`, "🛫=📅: 시간지정 유지(끝)");
  }

  {
    // 🛫 없이 ⏰ 만 — 기존 동작 회귀 방지.
    const h = harness({
      tasks: [{ ...task("S2", false, D1), time: "09:00-11:00" }],
      events: [],
      records: {},
    });
    await h.engine.run();
    eq(
      h.calls.insert[0].start.dateTime,
      `${D1}T09:00:00`,
      "🛫 없음: 시간지정 유지"
    );
  }

  {
    // 🛫 가 📅 보다 뒤면 spanStart 가 무시한다 → 하루짜리, 시각 유지.
    const h = harness({
      tasks: [{ ...task("S3", false, D1), start: D3, time: "09:00-11:00" }],
      events: [],
      records: {},
    });
    await h.engine.run();
    const ev = h.calls.insert[0];
    eq(ev.start.dateTime, `${D1}T09:00:00`, "🛫 > 📅: 🛫 무시, 시간지정 유지");
    eq(ev.end.dateTime, `${D1}T11:00:00`, "🛫 > 📅: 끝도 📅 당일");
  }

  {
    // 이미 시간지정으로 올라간 이벤트에 🛫 를 붙여 다중일이 되면 → 종일로 되돌린다.
    // (⏰ 를 노트에서 뗀 것과 같은 경로: rec.time 은 차 있고 taskTime 은 "")
    const h = harness({
      tasks: [{ ...task("M2", false, D3), start: D1, time: "09:00-11:00" }],
      events: [timedEvent("M2", D3)],
      records: {
        M2: rec({
          eventId: "ev-M2",
          due: D3,
          start: D3,
          time: "09:00-11:00",
          gcalUpdated: "100",
        }),
      },
    });
    await h.engine.run();
    eq(h.calls.patch.length, 1, "다중일 전환: patch 1회");
    const patch = h.calls.patch[0].patch;
    eq(
      patch.start,
      { date: D1, dateTime: null, timeZone: null },
      "다중일 전환: 종일 시작 + 시간 표현 제거"
    );
    eq(
      patch.end,
      { date: addDays(D3, 1), dateTime: null, timeZone: null },
      "다중일 전환: 종일 끝"
    );
    eq(h.state.records.M2.time, "", "다중일 전환: 스냅샷 종일");
  }

  // ── 조건부 push (If-Match) — pull 과 push 사이의 창 (0.9.0~) ──
//
// pull 을 T0 에 하고 push 를 T2 에 하는 사이 몇 초에 사람이 캘린더에서 고치면 우리는 못 본다.
// 그 창까지 닫는 유일한 방법이 ETag 조건부 수정이다: 우리가 **읽은 버전**을 실어 보내고,
// 그 사이 바뀌었으면 Google 이 412 를 준다.
{
  // (a) 우리가 읽은 이벤트의 etag 가 실제로 실려 나간다
  const ev = doneEvent("A1", false, "100");
  (ev as any).etag = '"etag-v1"';
  const h = harness({
    tasks: [task("A1", false, "2026-08-19")], // 노트만 바뀜 → push
    events: [ev],
    records: { A1: rec() },
  });
  await h.engine.run();
  eq(h.calls.patch.length, 1, "push 가 돌았다");
  eq(h.calls.patch[0].etag, '"etag-v1"', "읽은 버전을 If-Match 로 실어 보낸다 ★");
}
{
  // (b) ★★ 412 = pull 이후 원격이 또 바뀌었다. **덮지 않고 물러난다.**
  //     스냅샷도 그대로여야 다음 run 이 새 상태로 처음부터 다시 판정한다 —
  //     여기서 스냅샷을 갱신하면 그 노트 변경이 "이미 반영됨"이 되어 영영 사라진다.
  const h = harness({
    tasks: [task("A1", false, "2026-08-19")],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec() },
    patchPrecondition: true,
  });
  const r = await h.engine.run();
  eq(h.state.records.A1.due, TODAY, "412: 스냅샷을 갱신하지 않는다 ★");
  eq(h.state.records.A1.gcalUpdated, "100", "412: gcalUpdated 도 그대로");
  eq(
    r.entries.some((e) => (e.detail ?? "").includes("push 포기")),
    true,
    "412: 무엇을 왜 포기했는지 로그에 남는다"
  );
  eq(r.failures.length, 0, "412 는 실패가 아니라 정보다 — ⚠ 로 세지 않는다 ★");
}

// ── ★★ 보류한 원격 관측은 다음 run 에 되살아나야 한다 (0.9.4) ──
//
// `pullCalendar` 는 syncToken 증분이라 **한 번 받은 이벤트는 다음 델타에 안 온다.**
// 그래서 이번 run 이 충돌을 보류하면, 다음 run 은 `remote = undefined` 로 들어와
// "원격은 안 바뀌었다"로 읽고 **노트 값을 그냥 올렸다.**
//
// 결과적으로 **보류한 충돌은 100% 노트 승으로 끝났다.** 2026-09-10 실측 로그:
//   16:36:20  HOLD ⚔️⏸ 충돌 해결 보류 — due(노트 09-11 / GCal 09-10)
//   16:36:38  UPDATE ⬆ GCal 반영: 09-12→09-11        ← ⚔️ 가 사라졌다
// "충돌 시 GCal 우선"으로 규칙을 바꿔도 이 경로 때문에 한 번도 적용되지 않았다.
{
  const ev = doneEvent("A1", false, "200");
  ev.start = { date: "2026-08-20" };
  ev.end = { date: "2026-08-21" };
  // tgs* 는 옛 값 그대로 = 사람이 캘린더에서 옮겼다.

  let deliver = true; // 증분 델타가 이벤트를 주는가(첫 run 만 준다)
  const h = harness({
    tasks: [task("A1", false, "2026-08-19")],
    events: [ev],
    records: { A1: rec({ gcalUpdated: "100" }) },
  });
  const realList = h.client.listEvents;
  h.client.listEvents = async (c: string, params: any) => {
    const r = await realList(c, params);
    if (!deliver) return { ...r, items: [] }; // 두 번째 run 부터는 델타가 비어 있다
    return r;
  };
  let fetched = 0;
  const realGet = h.client.getEvent;
  h.client.getEvent = async (c: string, id: string) => {
    fetched++;
    return realGet(c, id);
  };

  // 1) 정착 전 → 충돌 보류
  (h.engine as any).settledSince = Date.now(); // 정착 시계를 방금 시작 = 아직 30초 전
  await h.engine.run();
  eq(h.state.records.A1.recheckRemote, true, "보류하면 재조회 표시를 남긴다 ★★");
  eq(h.calls.patch, [], "보류 중엔 아무것도 안 올린다");

  // 2) 다음 run — **델타에는 이벤트가 없다.** 재조회로 관측을 되살려야 한다.
  deliver = false;
  (h.engine as any).settledSince = Date.now() - 60_000; // 이제 정착했다
  await h.engine.run();
  eq(fetched > 0, true, "델타에 없으면 직접 조회해 관측을 되살린다 ★★");
  eq(
    h.state.records.A1.due,
    "2026-08-20",
    "보류했던 충돌이 GCal 채택으로 해결된다 ★★ (여기가 0.9.0~0.9.3 회귀 지점)"
  );
  eq(h.state.records.A1.recheckRemote, undefined, "판정했으면 표시를 끈다");
}
{
  // 보류가 없었으면 재조회하지 않는다 — 매 run 이벤트를 다시 긁으면 안 된다.
  let fetched = 0;
  const h = harness({
    tasks: [task("A1", false)],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec() },
  });
  const realGet = h.client.getEvent;
  h.client.getEvent = async (c: string, id: string) => {
    fetched++;
    return realGet(c, id);
  };
  await h.engine.run();
  eq(fetched, 0, "보류 표시가 없으면 조회하지 않는다 ★");
}

// ── ★ 반복(🔁) 완료가 만든 🆔 중복은 스스로 푼다 (0.9.5) ──
//
// Tasks 는 반복 task 를 완료하면 다음 회차 줄을 만들면서 **원본 🆔를 그대로 복사한다.**
// 그러면 정본을 특정할 수 없어 그 id 는 손으로 고칠 때까지 영영 멈춘다.
// `TaskLine.removeId` 의 주석이 처음부터 이 경우를 위한 것이라고 적고 있었지만
// 호출부가 없었다(2026-09-10 실사용에서 걸림).
{
  const h = harness({
    tasks: [
      { ...task("A1", true), recurrence: "every day" } as any, // 완료된 원래 회차
      {
        ...task("A1", false, "2026-08-07"),
        line: 1,
        recurrence: "every day",
      } as any, // Tasks 가 만든 새 회차 — 같은 🆔가 복사돼 있다
    ],
    events: [doneEvent("A1", true, "100")],
    records: { A1: rec({ done: true }) },
  });
  const r = await h.engine.run();
  eq(h.calls.writes, ["removeId"], "새 회차 줄에서 🆔만 뗀다 ★");
  eq(
    r.entries.some((e) => e.action === "REPAIR"),
    true,
    "무엇을 고쳤는지 로그에 남긴다 ★"
  );
}
{
  // ⛔ 모양이 다르면 손대지 않는다 — Sync 가 블록을 복제한 경우는 완료 상태가 같다.
  //    그때는 사람이 봐야 한다.
  const h = harness({
    tasks: [
      { ...task("A1", false), recurrence: "every day" } as any,
      { ...task("A1", false), line: 1, recurrence: "every day" } as any,
    ],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec() },
  });
  const r = await h.engine.run();
  eq(h.calls.writes, [], "둘 다 미완료면 건드리지 않는다 ★");
  eq(
    r.entries.some((e) => (e.detail ?? "").includes("정본 불명")),
    true,
    "대신 중복으로 건너뛴다"
  );
}
{
  // 반복이 아니면(🔁 없음) 이 경로가 아니다 — 그냥 중복이다.
  const h = harness({
    tasks: [task("A1", true), { ...task("A1", false), line: 1 } as any],
    events: [doneEvent("A1", true, "100")],
    records: { A1: rec({ done: true }) },
  });
  await h.engine.run();
  eq(h.calls.writes, [], "반복이 아니면 자동 정리하지 않는다 ★");
}

// ── ★ pull 로 쓴 줄이 곧바로 달라지면 **관측만** 한다 (0.9.7) ──
//
// 2026-09-10 에 pull 이 쓴 줄이 14초 만에 옛 값으로 달라진 것을 두 번 봤다. 되돌림이라면
// 다음 run 이 그 값을 GCal 에 올려 원격까지 오염시키는 경로다.
//
// ⛔ 그런데 **되돌림인지 사용자 편집인지 구분할 근거가 없다.** 두 사례 모두 사람이 리본을
//    누르며 날짜를 돌려가며 테스트하던 중이었다. 0.9.6 은 여기서 줄을 다시 썼는데, 그러면
//    충돌 해결 직후의 진짜 편집을 되돌려 버린다 — 근거 없이 사용자와 싸우는 쪽이 더 나쁘다.
//    그래서 **막지 않고 기록만 남긴다.**
{
  const h = harness({
    // 노트 값이 기준선과 다르다 = 정상 판정이면 push 로 흘러간다
    tasks: [task("A1", false, "2026-08-19")],
    events: [doneEvent("A1", false, "100")],
    records: {
      A1: rec({
        pulledLine: "- [ ] #task 샘플 📅 2026-08-20 🆔 A1",
        pulledAt: Date.now(),
      }),
    },
  });
  const r = await h.engine.run();
  eq(
    r.entries.some((e) => (e.detail ?? "").includes("되돌림이다")),
    true,
    "달라졌다는 사실과 양쪽 줄을 기록한다 ★"
  );
  eq(
    h.calls.writes.includes("rewriteLine"),
    false,
    "노트를 되돌리지 않는다 — 사용자 편집일 수 있다 ★★"
  );
  eq(h.calls.patch.length, 1, "정상 판정으로 흘러가 노트 값이 올라간다 ★");
  eq(h.state.records.A1.pulledLine, undefined, "관측했으면 기록을 지운다");
}

// ── ★ 수동 실행은 **생성만** 연다 (0.9.8) ──
//
// 사람이 노트를 고치는 동안 볼트는 계속 "따라잡는 중"이라 정착 30초가 잘 안 쌓인다
// (2026-09-10 실측: 편집 중 run 의 약 60%가 보류). 새 task 가 캘린더에 안 뜨는 구간이
// 길어지는데, 생성은 최악이 **일시적 중복**이고 전수 스캔이 하루 안에 정리한다.
// **삭제·미일정화는 계속 막는다** — 되돌리기 어렵다.
{
  const unsettled = () => {
    const h = harness({
      // 픽스처 TODAY 는 과거라 창(inWindow) 밖이다 — 생성 경로를 타려면 미래 날짜여야 한다
      tasks: [task("N1", false, "2099-01-01")], // record 없는 새 task → 생성 경로
      events: [],
      records: {},
    });
    (h.engine as any).settledSince = Date.now(); // 정착 시계를 방금 시작 = 30초 전
    return h;
  };

  const auto = unsettled();
  const r1 = await auto.engine.run();
  eq(auto.calls.insert.length, 0, "자동 실행: 정착 전이면 생성 보류");
  eq(
    r1.entries.some((e) => (e.detail ?? "").includes("생성 보류")),
    true,
    "자동 실행: 이유를 남긴다"
  );

  const manual = unsettled();
  await manual.engine.run({ force: true });
  eq(manual.calls.insert.length, 1, "수동 실행: 정착 전이어도 생성한다 ★");

  // 삭제는 수동으로도 안 열린다 — 위험의 크기가 다르다.
  const del = harness({
    tasks: [], // task 가 사라졌다 → 이벤트 삭제 경로
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec() },
  });
  (del.engine as any).settledSince = Date.now();
  await del.engine.run({ force: true });
  eq(del.calls.del, [], "수동 실행이어도 삭제는 계속 보류 ★★");
}

// ── ★★ 완료 회차 이벤트를 지우면 되살아나지 않는다 (0.9.9) ──
//
// `drop-record` 는 "완료된 줄의 📅 는 기록이므로 유지하고 매핑만 버린다" 인데, 그 전제가
// *"완료 + 과거 due 는 생성 루프의 inWindow 에서 걸러진다"* 였다. 조건이 `t.due >= today`
// 라 **오늘·미래 마감의 완료 task 는 안 걸렸고**, 지운 이벤트가 같은 run 에서 부활했다.
// 2026-09-10 실측:
//   DROP   `kctfFJ` … 완료된 줄 → 매핑만 폐기(📅는 기록이므로 유지)
//   CREATE `kctfFJ` … due=2026-09-10 (종일) done=완료      ← 바로 다음 줄
{
  const FUTURE = "2099-01-01";
  const h = harness({
    tasks: [task("A1", true, FUTURE)], // 완료됐고 마감은 미래 = 옛 조건이면 창 안
    events: [], // GCal 에서 사람이 지웠다
    records: {}, // DROP 으로 매핑이 이미 폐기된 상태
  });
  const r = await h.engine.run();
  eq(h.calls.insert, [], "완료된 task 에는 이벤트를 새로 만들지 않는다 ★★");
  eq(r.created, 0, "생성 카운트도 0");
}
{
  // 미완료면 예전대로 만든다 — 막는 것은 완료된 것뿐이다.
  const h = harness({
    tasks: [task("A1", false, "2099-01-01")],
    events: [],
    records: {},
  });
  await h.engine.run();
  eq(h.calls.insert.length, 1, "미완료는 그대로 생성한다 ★");
}
{
  // 이미 이벤트가 있는 완료 task 는 조정 경로가 맡는다 — 회색+☑️ 로 유지된다.
  // (생성 루프를 막았다고 기존 완료 이벤트가 사라지면 안 된다)
  const h = harness({
    tasks: [task("A1", true, "2099-01-01")],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec({ due: "2099-01-01", start: "2099-01-01", done: false }) },
  });
  await h.engine.run();
  eq(h.calls.del, [], "기존 완료 이벤트를 지우지 않는다 ★");
  eq(h.calls.patch.length, 1, "완료 표시를 올린다");
}

// ── ★ 서로 다른 task 가 같은 🆔 일 때 (0.9.10) ──
//
// task 줄을 복사하면 🆔까지 딸려온다. 2026-09-10 실측:
//   :41 명상/Night Stretching … 🆔 TMzvTR
//   :42 집 알아보기          … 🆔 TMzvTR
// 반복 완료 모양이 아니라 0.9.5 의 자동 정리가 안 걸렸고, 그 id 는 통째로 멈춰 있었다.
// record 가 마지막으로 동기화한 **제목**이 어느 쪽이 원본인지 말해 준다.
{
  const h = harness({
    tasks: [
      { ...task("A1", false), title: "샘플" } as any, // record 의 제목과 같다 = 원본
      { ...task("A1", false), line: 1, title: "복사된 다른 일" } as any,
    ],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec({ title: "샘플" }) },
  });
  const r = await h.engine.run();
  eq(h.calls.writes, ["removeId"], "원본이 아닌 줄에서 🆔를 뗀다 ★");
  eq(
    r.entries.some((e) => (e.detail ?? "").includes("서로 다른 task")),
    true,
    "왜 그렇게 판단했는지 남긴다"
  );
}
{
  // ⛔ 제목으로 원본을 못 가리면 손대지 않는다 — 같은 task 가 두 번 복제된 경우.
  //    (2026-09-10 의 `2pkajX` 가 이 모양이었다: 두 줄 다 완료, 제목 동일, 한 줄은 깨짐)
  const h = harness({
    tasks: [
      { ...task("A1", true), title: "샘플" } as any,
      { ...task("A1", true), line: 1, title: "샘플" } as any,
    ],
    events: [doneEvent("A1", true, "100")],
    records: { A1: rec({ title: "샘플", done: true }) },
  });
  const r = await h.engine.run();
  eq(h.calls.writes, [], "둘 다 제목이 같으면 사람이 봐야 한다 ★★");
  eq(
    r.entries.some((e) => (e.detail ?? "").includes("정본 불명")),
    true,
    "대신 중복으로 건너뛰고 위치를 남긴다"
  );
}
{
  // 정착 전이어도 **수동 실행**이면 정리한다 — 안 그러면 이 볼트에선 영영 안 풀린다.
  const h = harness({
    tasks: [
      { ...task("A1", false), title: "샘플" } as any,
      { ...task("A1", false), line: 1, title: "복사된 다른 일" } as any,
    ],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec({ title: "샘플" }) },
  });
  (h.engine as any).settledSince = Date.now(); // 정착 전
  await h.engine.run({ force: true });
  eq(h.calls.writes, ["removeId"], "수동 실행은 정착 전에도 중복을 푼다 ★");
}

// ── ★★ 모바일 읽기 전용 — pull 은 돌고 push 는 안 한다 (0.10.0~) ──
{
  const { Platform } = require("obsidian");
  const ev = doneEvent("A1", false, "200");
  ev.start = { date: "2026-08-20" };
  ev.end = { date: "2026-08-21" };
  const h = harness({
    tasks: [task("A1", false), { ...task("N1", false, "2099-01-01") } as any],
    events: [ev],
    records: { A1: rec({ gcalUpdated: "100" }) },
    settings: { mobileReadOnly: true },
  });
  Platform.isMobile = true;
  try {
    const r = await h.engine.run({ force: true }); // 수동으로도 열리지 않아야 한다
    eq(h.calls.patch, [], "모바일: GCal 에 push 하지 않는다 ★★");
    eq(h.calls.insert, [], "모바일: 이벤트를 만들지 않는다 ★★");
    eq(h.calls.del, [], "모바일: 이벤트를 지우지 않는다 ★★");
    eq(
      h.calls.writes.includes("setDue"),
      true,
      "모바일: pull 은 그대로 돈다(GCal → 노트) ★★"
    );
    eq(
      r.entries.some((e) => (e.detail ?? "").includes("모바일 읽기 전용")),
      true,
      "무엇을 왜 건너뛰었는지 남긴다"
    );
  } finally {
    Platform.isMobile = false;
  }
}
{
  // 설정을 끄면 모바일에서도 예전처럼 쓴다 — 기본값이 안전 쪽일 뿐이다.
  const { Platform } = require("obsidian");
  const h = harness({
    tasks: [task("A1", false, "2026-08-19")],
    events: [doneEvent("A1", false, "100")],
    records: { A1: rec() },
    settings: { mobileReadOnly: false },
  });
  Platform.isMobile = true;
  try {
    await h.engine.run();
    eq(h.calls.patch.length, 1, "설정을 끄면 모바일도 push 한다 ★");
  } finally {
    Platform.isMobile = false;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
