/**
 * SyncEngine 유지보수 명령 특성화 테스트(0.12.0 안전망) — backfillDescriptions · cleanupDuplicates.
 * 현재 동작을 그대로 고정한다.
 */
import { installFakeEnv, resetClock } from "./helpers/fakeEnv";
installFakeEnv();

import { eq, ok, done } from "./helpers/assert";
import { SyncEngine } from "../src/sync/SyncEngine";
import { CAL, TODAY, doneEvent, harness, rec, task } from "./helpers/engineHarness";

const BLOCK = (id: string) => `— tasks-gcal-sync —\n📁 vault\n🆔 ${id}`;

/** console.warn 를 모아 조용히 만든다. */
const warns: any[][] = [];
console.warn = (...a: any[]) => {
  warns.push(a);
};

type H = ReturnType<typeof harness>;

/** 같은 스텁으로 saveState 호출 수를 세는 엔진을 새로 만든다. */
function engineWithSave(h: H, tasks: any[]) {
  const saves = { n: 0 };
  const engine = new SyncEngine(
    h.app,
    h.settings,
    h.state,
    { getTasks: async () => tasks } as any,
    h.client,
    h.writer,
    async () => {
      saves.n++;
    }
  );
  return { engine, saves };
}

const ours = (id: string, taskId: string, over: any = {}) => ({
  id,
  updated: "u-" + id,
  status: "confirmed",
  summary: "☐ 샘플",
  start: { date: TODAY },
  end: { date: "2026-08-07" },
  extendedProperties: {
    private: {
      tgsTaskId: taskId,
      tgsVault: "vault",
      tgsDue: TODAY,
      tgsStart: TODAY,
      tgsDone: "0",
      tgsTitle: "원격 " + id,
      ...over,
    },
  },
});

(async () => {
  resetClock();

  // ═══ backfillDescriptions
  {
    const h = harness({
      tasks: [],
      events: [],
      records: {
        A1: rec({ eventId: "ev-A1" }),
        B2: rec({ eventId: "ev-B2", calendarId: "cal-2" }),
        C3: rec({ eventId: "ev-C3" }),
        D4: rec({ eventId: "ev-D4" }),
        E5: rec({ eventId: "ev-E5" }),
        F6: rec({ eventId: "ev-F6" }),
        G7: rec({ eventId: "ev-G7" }),
        H8: rec({ eventId: "ev-H8" }),
      },
    });
    const descs: Record<string, string | undefined> = {
      // 설명 없음 → 블록만
      "ev-A1": undefined,
      // 사용자 메모 + 마커 블록(옛 볼트 이름·딥링크) → 메모 보존, 블록 교체
      "ev-B2": "회의 준비물: 노트북  \n\n— tasks-gcal-sync —\n📁 old-vault\n🆔 B2\n🔗 obsidian://open?vault=old",
      // 마커 없는 구버전: 끝의 📁/🆔/🔗 줄(과 빈 줄)만 걷어낸다
      "ev-C3": "첫 줄\n둘째 줄\n\n📁 vault\n🆔 C3\n🔗 obsidian://open?x\n\n",
      // 구버전 설명이 그 줄들뿐 → 블록만
      "ev-D4": "📁 vault\n🆔 D4",
      // 중간에 📁 로 시작하는 사용자 줄은 끝이 아니므로 보존
      "ev-E5": "📁 자료 폴더 참고\n실제 메모",
      // 앞뒤 공백 붙은 마커도 마커로 인식
      "ev-H8": "위 메모\n   — tasks-gcal-sync —   \n아래는 버려짐",
    };
    const gets: any[] = [];
    const patches: any[] = [];
    h.client.getEvent = async (cal: string, id: string) => {
      gets.push([cal, id]);
      if (id === "ev-F6") return undefined; // 이벤트 없음(스텁이 undefined) → cur.description 에서 TypeError
      if (id === "ev-G7") throw new Error("404");
      return { id, description: descs[id] };
    };
    h.client.patchEvent = async (...args: any[]) => {
      patches.push(args);
      if (args[1] === "ev-C3") throw new Error("patch 실패");
      return {};
    };
    const before = JSON.stringify(h.state.records);
    const { engine, saves } = engineWithSave(h, []);
    warns.length = 0;
    const r = await engine.backfillDescriptions();

    eq(r, { ok: 5, fail: 3 }, "backfill: counts (F6 missing, G7 get throws, C3 patch throws)");
    eq(
      gets,
      [
        ["cal-1", "ev-A1"],
        ["cal-2", "ev-B2"],
        ["cal-1", "ev-C3"],
        ["cal-1", "ev-D4"],
        ["cal-1", "ev-E5"],
        ["cal-1", "ev-F6"],
        ["cal-1", "ev-G7"],
        ["cal-1", "ev-H8"],
      ],
      "backfill: getEvent per record in key order with record calendar"
    );
    eq(
      patches,
      [
        ["cal-1", "ev-A1", { description: BLOCK("A1") }],
        ["cal-2", "ev-B2", { description: "회의 준비물: 노트북\n\n" + BLOCK("B2") }],
        ["cal-1", "ev-C3", { description: "첫 줄\n둘째 줄\n\n" + BLOCK("C3") }],
        ["cal-1", "ev-D4", { description: BLOCK("D4") }],
        ["cal-1", "ev-E5", { description: "📁 자료 폴더 참고\n실제 메모\n\n" + BLOCK("E5") }],
        ["cal-1", "ev-H8", { description: "위 메모\n\n" + BLOCK("H8") }],
      ],
      "backfill: patch args (no etag, no deep link, record key as 🆔)"
    );
    eq(saves.n, 0, "backfill: saveState not called");
    eq(JSON.stringify(h.state.records), before, "backfill: records untouched");
    eq(warns.length, 3, "backfill: one warn per failure");
    eq(warns.map((w) => w[1]), ["C3", "F6", "G7"], "backfill: warn carries task id");
    ok(warns[0][2] instanceof Error && warns[0][2].message === "patch 실패", "backfill: warn carries error");
    eq(warns[1][2] instanceof TypeError, true, "backfill: missing event → TypeError path");
  }
  // 딥링크 설정 'line' 이어도 백필은 링크를 안 넣는다(task 를 넘기지 않는다)
  {
    const h = harness({
      tasks: [],
      events: [],
      records: { A1: rec() },
      settings: { deepLink: "line" },
    });
    const patches: any[] = [];
    h.client.getEvent = async () => ({ description: "메모" });
    h.client.patchEvent = async (...a: any[]) => {
      patches.push(a);
    };
    eq(await h.engine.backfillDescriptions(), { ok: 1, fail: 0 }, "backfill deepLink=line: ok");
    eq(patches, [["cal-1", "ev-A1", { description: "메모\n\n" + BLOCK("A1") }]], "backfill deepLink=line: no 🔗");
  }
  // records 없음
  {
    const h = harness({ tasks: [], events: [], records: {} });
    let n = 0;
    h.client.getEvent = async () => {
      n++;
    };
    eq(await h.engine.backfillDescriptions(), { ok: 0, fail: 0 }, "backfill empty: 0/0");
    eq(n, 0, "backfill empty: no client calls");
  }

  // ═══ cleanupDuplicates
  // record 의 이벤트가 목록에 있으면 그것을 남기고, 다른 볼트 이벤트는 제외
  {
    const h = harness({
      tasks: [task("A1", false)],
      events: [],
      records: { A1: rec({ eventId: "ev-A1", uncheckSeenAt: 123, gcalUpdated: "old" }) },
    });
    const finds: any[] = [];
    const dels: any[] = [];
    const legacy: any = { id: "ev-Z", updated: "u-Z", status: "confirmed" }; // tgsVault 없음 → 우리 것으로 본다
    h.client.findByTaskId = async (cal: string, id: string) => {
      finds.push([cal, id]);
      return [
        ours("ev-X", "A1"),
        ours("ev-Y", "A1", { tgsVault: "other" }),
        { ...doneEvent("A1", true, "555"), id: "ev-A1" },
        legacy,
      ];
    };
    h.client.deleteEvent = async (cal: string, id: string) => {
      dels.push([cal, id]);
    };
    const { engine, saves } = engineWithSave(h, [task("A1", false)]);
    const r = await engine.cleanupDuplicates();
    eq(r, { removed: 2, checked: 1 }, "cleanup keep-record: counts");
    eq(finds, [["cal-1", "A1"]], "cleanup keep-record: findByTaskId(default cal, id)");
    eq(dels, [["cal-1", "ev-X"], ["cal-1", "ev-Z"]], "cleanup keep-record: deletes others, not foreign");
    eq(
      h.state.records.A1,
      {
        eventId: "ev-A1",
        calendarId: "cal-1",
        due: TODAY,
        start: TODAY,
        time: "",
        done: true,
        title: "샘플",
        gcalUpdated: "555",
      },
      "cleanup keep-record: record rebuilt from kept event snapshot (uncheckSeenAt dropped)"
    );
    eq(saves.n, 1, "cleanup: saveState once");
  }
  // record 없음 → 첫 이벤트를 남기고 record 생성(스냅샷 없는 옛 이벤트면 task 값 폴백)
  {
    const t = { ...task("B2", true, "2026-08-10"), start: "2026-08-08", title: "제목 #gcal/Work", tags: ["#task"] };
    const h = harness({ tasks: [], events: [], records: {} });
    const dels: string[] = [];
    h.client.findByTaskId = async () => [
      { id: "ev-first", updated: "u1", status: "confirmed" },
      ours("ev-second", "B2"),
    ];
    h.client.deleteEvent = async (_c: string, id: string) => {
      dels.push(id);
    };
    const { engine } = engineWithSave(h, [t]);
    eq(await engine.cleanupDuplicates(), { removed: 1, checked: 1 }, "cleanup no-record: counts");
    eq(dels, ["ev-second"], "cleanup no-record: keeps first");
    eq(
      h.state.records.B2,
      {
        eventId: "ev-first",
        calendarId: "cal-1",
        due: "2026-08-10",
        start: "2026-08-08",
        time: "",
        done: true,
        title: "제목",
        gcalUpdated: "u1",
      },
      "cleanup no-record: record from task fallbacks (routing tag stripped from title)"
    );
  }
  // task 에 유효 ⏰ 가 있고 이벤트에 tgsTime 이 없으면 task 시각을 쓴다 / 다중일이면 ""
  {
    const t1 = { ...task("T1", false), time: "09:00-10:00" };
    const t2 = { ...task("T2", false, "2026-08-09"), start: "2026-08-07", time: "09:00-10:00" };
    const h = harness({ tasks: [], events: [], records: {} });
    h.client.findByTaskId = async (_c: string, id: string) => [
      { id: "k-" + id, status: "confirmed" },
      { id: "d-" + id, status: "confirmed" },
    ];
    h.client.deleteEvent = async () => {};
    const { engine } = engineWithSave(h, [t1, t2]);
    eq(await engine.cleanupDuplicates(), { removed: 2, checked: 2 }, "cleanup time: counts");
    eq(h.state.records.T1.time, "09:00-10:00", "cleanup time: single-day task time");
    eq(h.state.records.T2.time, "", "cleanup time: multi-day → all-day");
    eq(h.state.records.T2.start, "2026-08-07", "cleanup time: multi-day start");
    eq(h.state.records.T1.gcalUpdated, undefined, "cleanup time: no updated on event → undefined");
    ok("gcalUpdated" in h.state.records.T1, "cleanup time: gcalUpdated key present");
  }
  // record 가 있으나 그 이벤트가 목록에 없으면 첫 이벤트로 record 를 덮는다
  {
    const h = harness({
      tasks: [],
      events: [],
      records: { C3: rec({ eventId: "ev-gone", calendarId: "cal-old" }) },
    });
    const dels: string[] = [];
    h.client.findByTaskId = async () => [ours("ev-1", "C3"), ours("ev-2", "C3")];
    h.client.deleteEvent = async (_c: string, id: string) => {
      dels.push(id);
    };
    const { engine } = engineWithSave(h, [task("C3", false)]);
    eq(await engine.cleanupDuplicates(), { removed: 1, checked: 1 }, "cleanup stale-record: counts");
    eq(dels, ["ev-2"], "cleanup stale-record: keeps first");
    eq(h.state.records.C3.eventId, "ev-1", "cleanup stale-record: record eventId replaced");
    eq(h.state.records.C3.calendarId, "cal-1", "cleanup stale-record: calendarId = resolved target");
    eq(h.state.records.C3.title, "원격 ev-1", "cleanup stale-record: title from tgsTitle");
  }
  // 한 id 조회 실패 → 건너뛰고 계속 / 삭제 실패는 removed 에 안 센다 / 이벤트 1개 이하는 손대지 않음
  {
    const tasks = [
      task("E1", false),
      task("E2", false),
      task("E3", false),
      task("E4", false),
      { ...task("E5", false), id: undefined }, // id 없음 → skip
      { ...task("E6", false), due: undefined }, // due 없음 → skip
    ];
    const h = harness({
      tasks: [],
      events: [],
      records: { E3: rec({ eventId: "keep-me", title: "그대로" }) },
    });
    const finds: string[] = [];
    const dels: string[] = [];
    h.client.findByTaskId = async (_c: string, id: string) => {
      finds.push(id);
      if (id === "E1") throw new Error("조회 실패");
      if (id === "E2") return [ours("e2-a", "E2"), ours("e2-b", "E2"), ours("e2-c", "E2")];
      if (id === "E3") return [ours("e3-only", "E3")];
      return [ours("e4-foreign", "E4", { tgsVault: "other" }), ours("e4-mine", "E4")];
    };
    h.client.deleteEvent = async (_c: string, id: string) => {
      dels.push(id);
      if (id === "e2-b") throw new Error("삭제 실패");
    };
    const { engine, saves } = engineWithSave(h, tasks);
    warns.length = 0;
    const r = await engine.cleanupDuplicates();
    eq(r, { removed: 1, checked: 3 }, "cleanup mixed: counts (E1 unchecked, e2-b delete failed)");
    eq(finds, ["E1", "E2", "E3", "E4"], "cleanup mixed: continues after lookup failure; skips no id/due");
    eq(dels, ["e2-b", "e2-c"], "cleanup mixed: delete attempts");
    eq(h.state.records.E2.eventId, "e2-a", "cleanup mixed: record set despite delete failure");
    eq(h.state.records.E3, rec({ eventId: "keep-me", title: "그대로" }), "cleanup mixed: single event → record untouched");
    eq(h.state.records.E4, undefined, "cleanup mixed: one ours after foreign filter → no record created");
    eq(h.state.records.E1, undefined, "cleanup mixed: failed lookup → no record");
    eq(warns.map((w) => [w[0], w[1]]), [
      ["[tasks-gcal-sync] 중복 조회 실패:", "E1"],
      ["[tasks-gcal-sync] 중복 삭제 실패:", "e2-b"],
    ], "cleanup mixed: warnings");
    eq(saves.n, 1, "cleanup mixed: saveState once");
  }
  // 라우팅 태그 → 해당 캘린더 / 기본 캘린더 없음 → skip
  {
    const h = harness({
      tasks: [],
      events: [],
      records: {},
      settings: { calendars: [{ id: "cal-work", name: "Work" }] as any },
    });
    const finds: any[] = [];
    const dels: any[] = [];
    h.client.findByTaskId = async (cal: string, id: string) => {
      finds.push([cal, id]);
      return [ours("w1", id), ours("w2", id)];
    };
    h.client.deleteEvent = async (cal: string, id: string) => {
      dels.push([cal, id]);
    };
    const t = { ...task("R1", false), tags: ["#task", "#gcal/work"] };
    const { engine } = engineWithSave(h, [t]);
    await engine.cleanupDuplicates();
    eq(finds, [["cal-work", "R1"]], "cleanup routing: routed calendar (case-insensitive name)");
    eq(dels, [["cal-work", "w2"]], "cleanup routing: delete on routed calendar");
    eq(h.state.records.R1.calendarId, "cal-work", "cleanup routing: record calendarId");
  }
  {
    const h = harness({ tasks: [], events: [], records: {}, settings: { defaultCalendarId: "" } });
    let n = 0;
    h.client.findByTaskId = async () => {
      n++;
      return [];
    };
    const { engine, saves } = engineWithSave(h, [task("N1", false)]);
    eq(await engine.cleanupDuplicates(), { removed: 0, checked: 0 }, "cleanup no calendar: 0/0");
    eq(n, 0, "cleanup no calendar: no lookup");
    eq(saves.n, 1, "cleanup no calendar: saveState still called");
  }
  // task 없음 → 그래도 saveState 1회
  {
    const h = harness({ tasks: [], events: [], records: {} });
    const { engine, saves } = engineWithSave(h, []);
    eq(await engine.cleanupDuplicates(), { removed: 0, checked: 0 }, "cleanup empty: 0/0");
    eq(saves.n, 1, "cleanup empty: saveState once");
  }
  // 같은 🆔 가 두 줄이면 두 번 조회·정리한다(스텁은 삭제를 반영하지 않으므로 두 번 지운다)
  {
    const h = harness({ tasks: [], events: [], records: {} });
    const store = [ours("d1", "DUP"), ours("d2", "DUP")];
    const dels: string[] = [];
    h.client.findByTaskId = async () => store.filter((e) => !dels.includes(e.id));
    h.client.deleteEvent = async (_c: string, id: string) => {
      dels.push(id);
    };
    const { engine } = engineWithSave(h, [task("DUP", false), { ...task("DUP", true), line: 3 }]);
    eq(await engine.cleanupDuplicates(), { removed: 1, checked: 2 }, "cleanup dup lines: second pass sees 1 event");
    eq(dels, ["d2"], "cleanup dup lines: deleted once with stateful stub");
    eq(h.state.records.DUP.eventId, "d1", "cleanup dup lines: record from first pass");
  }

  // 참고: cleanupDuplicates 의 `keepEv ? … : { eventId: keepId, … gcalUpdated: undefined }`
  // 폴백은 keepId 가 항상 evs 안의 id 라 도달하지 않는다(테스트 불가).
  void CAL;

  done();
})();
