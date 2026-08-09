/**
 * 조정 루프의 방향 판정 테스트 — 2026-08-06 롤백 사고(가짜 기준선 + 스테일 노트)가
 * 다시 나지 않는지 확인한다. 실제 SyncEngine에 스텁 의존성을 물려 run()을 돌린다.
 */
import { SyncEngine } from "../src/sync/SyncEngine";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/settings/Settings";
import { PersistedState, SyncRecord } from "../src/sync/StateStore";

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

/** GCal에서 지워진 이벤트가 pull 응답에 실려 오는 모양. */
const cancelledEvent = (id: string): Ev => ({
  id: "ev-" + id,
  status: "cancelled",
});

const task = (id: string, checked: boolean, due = TODAY) => ({
  id,
  checked,
  due,
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
}) {
  const calls = {
    patch: [] as any[],
    insert: [] as any[],
    del: [] as string[],
    removeDue: [] as string[],
    /** 전수 스캔(rebuildRecords) 호출 — timeMax 를 넘기는 건 이쪽뿐이다. */
    fullScan: 0,
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
    patchEvent: async (_c: string, id: string, patch: any) => {
      calls.patch.push({ id, patch });
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
    removeDue: async (t: any) => {
      calls.removeDue.push(t.id);
    },
    setDue: async () => {},
    setStart: async () => {},
    removeStart: async () => {},
    replaceTitle: async () => {},
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
  // 기본은 "콜드 스타트 지난 상태" — 콜드 스타트 자체는 따로 테스트한다.
  (engine as any).loadedAt = Date.now() - 10 * 60_000;
  (engine as any).pullCycleDone = true;
  return { engine, calls, state, settings };
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

  // ── 3) pull이 실패해도 완료 해제 규칙은 그대로다(완료는 노트가 소유하므로
  //     GCal에 물어볼 것이 없다 — 한 사이클 재확인만 한다)
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", true, "200")],
      records: { A1: rec({ done: true, gcalUpdated: "200" }) },
      pullFails: true,
    });
    await h.engine.run();
    eq(h.calls.patch.length, 0, "첫 관측은 보류");
    eq(h.state.records.A1.done, true, "보류 중 스냅샷 유지");
    eq(typeof h.state.records.A1.uncheckSeenAt, "number", "대기 시계 시작");
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

    // fail-open 상한: 계속 뒤처짐이면 결국 통과시킨다
    for (let i = 0; i < 6; i++) await h.engine.run();
    eq(h.calls.patch.length >= 1, true, "fail-open 상한 초과 후에는 통과");
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
    eq(h.calls.removeDue, [], "완료 줄: 이벤트가 지워져도 📅 유지");
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
    eq(h.calls.removeDue, ["A1"], "미완료 줄: 미일정화");
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
    eq(h.calls.removeDue, [], "콜드 스타트: 미일정화 보류");
    eq(h.state.records.A1 !== undefined, true, "콜드 스타트: record 유지");
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
    eq(h.calls.removeDue, [], "노트를 건드리지 않는다");
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
