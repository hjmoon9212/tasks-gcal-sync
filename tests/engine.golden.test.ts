/**
 * SyncEngine.run() 골든 — 0.12.x 구조 리팩토링의 판정 기준.
 *
 * reconcile.test.ts 가 "이 경우 이것이 참이다" 를 하나씩 단언한다면, 여기서는 run 한 번이
 * 만든 **모든 것**(스텁 호출 순서·인자, result, records, task 인메모리 상태)을 통째로
 * 스냅샷한다. 코드를 옮기다 로그 한 글자·patch 키 순서 하나가 달라져도 여기서 걸린다.
 *
 * ⛔ 리팩토링 릴리스에서 tests/golden/engine.*.json 이 바뀌면 그건 리팩토링이 아니다.
 *    의도한 동작 변경일 때만 `GOLDEN=update npm test` 로 다시 기록하고 커밋에 이유를 적는다.
 *
 * 시계는 2026-08-06 12:00(로컬)로 고정한다 — 픽스처 TODAY 와 같은 날이다.
 */
import { installFakeEnv, resetClock, advanceClock } from "./helpers/fakeEnv";
installFakeEnv();

import { Platform } from "obsidian";
import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import {
  CAL,
  TODAY,
  cancelledEvent,
  doneEvent,
  harness,
  rec,
  task,
  timedEvent,
} from "./helpers/engineHarness";

type H = ReturnType<typeof harness>;

/** 스텁의 모든 메서드를 감싸 호출 순서와 인자를 기록한다. make() 가 스텁을 교체한 뒤에 건다. */
function instrument(h: H): any[] {
  const trace: any[] = [];
  const wrap = (label: string, obj: any) => {
    for (const k of Object.keys(obj)) {
      const fn = obj[k];
      if (typeof fn !== "function") continue;
      const wrapped = function (this: any, ...args: any[]) {
        // task 객체는 통째로 싣지 않는다 — 식별자만(상태는 마지막 스냅샷에서 본다)
        const shown = args.map((a) =>
          a && typeof a === "object" && "raw" in a && "line" in a
            ? { task: a.id ?? null, line: a.line }
            : a
        );
        trace.push([`${label}.${k}`, ...JSON.parse(JSON.stringify(shown))]);
        return fn.apply(this, args);
      };
      (wrapped as any).__traced = true;
      obj[k] = wrapped;
    }
  };
  wrap("client", h.client);
  wrap("writer", h.writer);
  return trace;
}

function snapshot(h: H, tasks: any[], trace: any[], results: any[]) {
  return {
    trace,
    results,
    records: h.state.records,
    syncTokens: h.state.syncTokens,
    lastFullScanAt: h.state.lastFullScanAt ?? null,
    tasks: tasks.map((t) => ({
      id: t.id ?? null,
      due: t.due ?? null,
      start: t.start ?? null,
      time: t.time ?? null,
      text: t.text ?? null,
      raw: t.raw,
    })),
    engine: {
      pullCycleDone: (h.engine as any).pullCycleDone,
      behindSince: (h.engine as any).behindSince,
      settledSince: (h.engine as any).settledSince,
    },
  };
}

async function scenario(
  name: string,
  make: () => { h: H; tasks: any[] },
  runs: Array<{ force?: boolean; fullScan?: boolean; before?: (h: H) => void }> = [{}]
) {
  resetClock();
  const { h, tasks } = make();
  const results: any[] = [];
  // 스텁 교체는 make() 안에서 끝난다 — 여기서 한 번만 감싼다(before 훅은 스텁을 바꾸지 않는다).
  const trace = instrument(h);
  for (const r of runs) {
    r.before?.(h);
    trace.push(["run", { force: !!r.force, fullScan: !!r.fullScan }]);
    try {
      results.push(await h.engine.run({ force: r.force, fullScan: r.fullScan }));
    } catch (e) {
      results.push({ threw: e instanceof Error ? e.message : String(e) });
    }
    advanceClock(20_000);
  }
  golden(`engine.${name}`, snapshot(h, tasks, trace, results));
}

/** harness 에 넘긴 task 배열을 그대로 돌려받아 run 뒤 인메모리 상태를 본다. */
function mk(opts: Parameters<typeof harness>[0]) {
  return () => ({ h: harness(opts), tasks: opts.tasks });
}

const FUT = "2026-08-09";
const noId = (due: string, over: any = {}) => ({
  ...task("", false, due),
  id: undefined,
  raw: `- [ ] #task 샘플 📅 ${due}`,
  ...over,
});

(async () => {
  // ── 생성 ────────────────────────────────────────────────────────────────
  await scenario("create.allday-with-id", mk({ tasks: [task("N1", false, FUT)], events: [], records: {} }));
  await scenario("create.allday-new-id", mk({ tasks: [noId(FUT)], events: [], records: {} }));
  await scenario(
    "create.timed",
    mk({ tasks: [{ ...task("N1", false, FUT), time: "09:00-10:30" }], events: [], records: {} })
  );
  await scenario(
    "create.multiday-time-ignored",
    mk({
      tasks: [{ ...task("N1", false, FUT), start: "2026-08-07", time: "09:00-10:30" }],
      events: [],
      records: {},
    })
  );
  await scenario(
    "create.recurring-routed",
    mk({
      tasks: [
        {
          ...task("N1", false, FUT),
          tags: ["#task", "#gcal/Growth"],
          recurrence: "every week",
          raw: `- [ ] #task #gcal/Growth 샘플 🔁 every week 📅 ${FUT} 🆔 N1`,
        },
      ],
      events: [],
      records: {},
      settings: { rules: [{ tag: "Growth", calendarId: "cal-growth", calendarName: "Growth" }] },
    })
  );
  await scenario("create.overdue-off", mk({ tasks: [task("N1", false, "2026-08-01")], events: [], records: {} }));
  await scenario(
    "create.overdue-on",
    mk({ tasks: [task("N1", false, "2026-08-01")], events: [], records: {}, settings: { includeOverdue: true } })
  );
  await scenario("create.done-not-created", mk({ tasks: [task("N1", true, FUT)], events: [], records: {} }));
  await scenario("create.no-calendar-throws", mk({
    tasks: [task("N1", false, FUT)],
    events: [],
    records: {},
    settings: { defaultCalendarId: "" },
  }));

  // ── 입양 · 중복 ─────────────────────────────────────────────────────────
  await scenario("adopt.with-duplicate", () => {
    const tasks = [task("A1", false, FUT)];
    const h = harness({ tasks, events: [], records: {} });
    const e1 = doneEvent("A1", false, "300");
    const e2 = { ...doneEvent("A1", false, "301"), id: "ev-A1-dup" };
    h.client.findByTaskId = async () => [e1, e2];
    return { h, tasks };
  });
  await scenario("adopt.lookup-fails-then-create", () => {
    const tasks = [task("A1", false, FUT)];
    const h = harness({ tasks, events: [], records: {} });
    h.client.findByTaskId = async () => {
      throw new Error("GCal list 503");
    };
    return { h, tasks };
  });
  await scenario("adopt.full-scan-foreign-vault", () => {
    const mine = doneEvent("A1", false, "200");
    const foreign = doneEvent("Z9", false, "200");
    foreign.extendedProperties.private.tgsVault = "other-vault";
    const tasks = [task("A1", false)];
    return { h: harness({ tasks, events: [mine, foreign], records: {} }), tasks };
  }, [{ fullScan: true }]);

  // ── 병합 (노트 → GCal) ───────────────────────────────────────────────────
  await scenario(
    "merge.quiet-noop",
    mk({ tasks: [task("A1", false)], events: [doneEvent("A1", false, "100")], records: { A1: rec() } })
  );
  await scenario(
    "merge.date-move-push",
    mk({ tasks: [task("A1", false, FUT)], events: [doneEvent("A1", false, "100")], records: { A1: rec() } })
  );
  await scenario(
    "merge.complete-push",
    mk({ tasks: [task("A1", true)], events: [doneEvent("A1", false, "100")], records: { A1: rec() } })
  );
  await scenario("merge.uncheck-held-then-pushed", () => {
    const tasks = [task("A1", false)];
    const h = harness({
      tasks,
      events: [doneEvent("A1", true, "200")],
      records: { A1: rec({ done: true, gcalUpdated: "200", doneAt: "2026-08-05" } as any) },
    });
    return { h, tasks };
  }, [{}, { before: () => advanceClock(120_000) }]);
  await scenario(
    "merge.add-time",
    mk({
      tasks: [{ ...task("A1", false), time: "07:45-10:00" }],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    })
  );
  await scenario("merge.remove-time", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { dateTime: "2026-08-06T07:45:00", timeZone: "Asia/Seoul" };
    ev.end = { dateTime: "2026-08-06T10:00:00", timeZone: "Asia/Seoul" };
    const tasks = [task("A1", false)];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ time: "07:45-10:00", gcalUpdated: "200" }) } }), tasks };
  });
  await scenario("merge.preserve-human-time-shift-date", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { dateTime: "2026-08-06T07:45:00", timeZone: "Asia/Seoul" };
    ev.end = { dateTime: "2026-08-06T10:00:00", timeZone: "Asia/Seoul" };
    const tasks = [task("A1", false, FUT)];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "200" }) } }), tasks };
  });
  await scenario("merge.timed-to-multiday", () => {
    const tasks = [{ ...task("M2", false, FUT), start: "2026-08-07", time: "09:00-11:00" }];
    const h = harness({
      tasks,
      events: [timedEvent("M2", FUT)],
      records: { M2: rec({ eventId: "ev-M2", due: FUT, start: FUT, time: "09:00-11:00", gcalUpdated: "100" }) },
    });
    return { h, tasks };
  });
  const growth = { rules: [{ tag: "Growth", calendarId: "cal-growth", calendarName: "Growth" }] };
  // 현재 동작: 라우팅 태그만 바꾸면 **이동하지 않는다** — push 가 필요한 필드 변경이 있어야
  // applyMerge 가 대상 캘린더를 본다(버그 백로그 B7 후보). 리팩토링은 이 동작도 보존한다.
  await scenario("merge.calendar-tag-only-no-move", () => {
    const tasks = [{ ...task("A1", false), tags: ["#task", "#gcal/Growth"] }];
    const h = harness({ tasks, events: [doneEvent("A1", false, "100")], records: { A1: rec() }, settings: growth });
    return { h, tasks };
  });
  await scenario("merge.calendar-move", () => {
    const tasks = [{ ...task("A1", false, FUT), tags: ["#task", "#gcal/Growth"] }];
    const h = harness({ tasks, events: [doneEvent("A1", false, "100")], records: { A1: rec() }, settings: growth });
    return { h, tasks };
  });
  await scenario("merge.etag-412", () => {
    const tasks = [task("A1", false, FUT)];
    const ev = doneEvent("A1", false, "100");
    (ev as any).etag = '"etag-v1"';
    return { h: harness({ tasks, events: [ev], records: { A1: rec() }, patchPrecondition: true }), tasks };
  });
  await scenario("merge.patch-500", () => {
    const tasks = [task("A1", true)];
    const h = harness({ tasks, events: [doneEvent("A1", false, "200")], records: { A1: rec({ gcalUpdated: "200" }) } });
    h.client.patchEvent = async () => {
      throw new Error("GCal PATCH 500: backend");
    };
    return { h, tasks };
  });
  await scenario("merge.description-preserved", () => {
    const ev = doneEvent("A1", false, "100");
    (ev as any).description = "사용자 메모\n\n— tasks-gcal-sync —\n📁 old.md";
    const tasks = [task("A1", false, FUT)];
    return { h: harness({ tasks, events: [ev], records: { A1: rec() } }), tasks };
  });

  // ── 충돌 ────────────────────────────────────────────────────────────────
  await scenario("conflict.echo-note-wins", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    ev.extendedProperties.private.tgsDue = "2026-08-20";
    ev.extendedProperties.private.tgsStart = "2026-08-20";
    const tasks = [task("A1", false, "2026-08-19")];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } }), tasks };
  });
  await scenario("conflict.human-gcal-wins", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    const tasks = [task("A1", false, "2026-08-19")];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } }), tasks };
  });
  await scenario("conflict.title-human-gcal-wins", () => {
    const ev = doneEvent("A1", false, "200");
    ev.summary = "☐ 캘린더에서 고친 제목";
    const tasks = [{ ...task("A1", false), title: "노트에서 고친 제목", text: "노트에서 고친 제목" }];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } }), tasks };
  });
  await scenario("conflict.agreed-values", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    ev.extendedProperties.private.tgsDue = "2026-08-20";
    ev.extendedProperties.private.tgsStart = "2026-08-20";
    const tasks = [task("A1", false, "2026-08-20")];
    return { h: harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } }), tasks };
  });
  await scenario("conflict.held-then-recheck", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    const tasks = [task("A1", false, "2026-08-19")];
    const h = harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } });
    let deliver = true;
    const realList = h.client.listEvents;
    h.client.listEvents = async (c: string, p: any) => {
      const r = await realList(c, p);
      return deliver ? r : { ...r, items: [] };
    };
    (h.engine as any).settledSince = Date.now();
    (h as any).stopDelivery = () => (deliver = false);
    return { h, tasks };
  }, [
    {},
    {
      before: (h) => {
        (h as any).stopDelivery();
        (h.engine as any).settledSince = Date.now() - 60_000;
      },
    },
  ]);
  await scenario("conflict.held-forced", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    const tasks = [task("A1", false, "2026-08-19")];
    const h = harness({ tasks, events: [ev], records: { A1: rec({ gcalUpdated: "100" }) } });
    (h.engine as any).settledSince = Date.now();
    return { h, tasks };
  }, [{ force: true }]);

  // ── 파괴 경로 ────────────────────────────────────────────────────────────
  await scenario(
    "destroy.task-gone-delete",
    mk({
      tasks: [],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ lastLine: "- [ ] #task 샘플 📅 2026-08-06 🆔 A1", lastWhere: "note.md:45" }) },
    })
  );
  await scenario(
    "destroy.task-gone-unsettled-hold",
    mk({ tasks: [], events: [doneEvent("A1", false, "100")], records: { A1: rec() } }),
    [{ before: (h) => ((h.engine as any).settledSince = Date.now() - 1_000) }]
  );
  await scenario(
    "destroy.task-gone-forced-still-held",
    mk({ tasks: [], events: [doneEvent("A1", false, "100")], records: { A1: rec() } }),
    [{ force: true, before: (h) => ((h.engine as any).settledSince = Date.now()) }]
  );
  await scenario(
    "destroy.due-invalid-delete",
    mk({
      tasks: [{ ...task("A1", false), due: undefined, time: "09:00-10:00" }],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ time: "09:00-10:00" }) },
    })
  );
  await scenario(
    "destroy.cancelled-done-drop",
    mk({ tasks: [task("A1", true)], events: [cancelledEvent("A1")], records: { A1: rec({ done: true }) } })
  );
  await scenario(
    "destroy.cancelled-unschedule",
    mk({ tasks: [task("A1", false)], events: [cancelledEvent("A1")], records: { A1: rec() } })
  );
  await scenario(
    "destroy.task-gone-record-adopted-hold",
    mk({ tasks: [{ ...task("A1", false), due: undefined }], events: [doneEvent("A1", false, "200")], records: {} })
  );

  // ── pull ────────────────────────────────────────────────────────────────
  await scenario(
    "pull.failed-calendar",
    mk({ tasks: [task("A1", false, FUT)], events: [doneEvent("A1", true, "200")], records: { A1: rec({ done: true, gcalUpdated: "200" }) }, pullFails: true })
  );
  await scenario("pull.sync-token-gone", () => {
    const tasks = [task("A1", false)];
    const h = harness({ tasks, events: [doneEvent("A1", false, "100")], records: { A1: rec() } });
    h.state.syncTokens[CAL] = "old-token";
    const realList = h.client.listEvents;
    h.client.listEvents = async (c: string, p: any) => {
      if (p?.syncToken) {
        const e: any = new Error("GCal list 410: gone");
        e.gone = true;
        throw e;
      }
      return realList(c, p);
    };
    return { h, tasks };
  });

  // ── 가드 ────────────────────────────────────────────────────────────────
  const syncing = (h: H) =>
    ((h.app as any).internalPlugins = { plugins: { sync: { instance: { getStatus: () => "Syncing" } } } });
  const behindCase = () =>
    mk({ tasks: [task("A1", false, FUT)], events: [doneEvent("A1", false, "200")], records: { A1: rec({ gcalUpdated: "200" }) } });
  await scenario("guard.vault-behind", behindCase(), [{ before: syncing }]);
  await scenario("guard.vault-behind-over-budget", behindCase(), [
    { before: syncing },
    { before: (h) => ((h.engine as any).behindSince = Date.now() - 11 * 60_000) },
  ]);
  await scenario("guard.vault-behind-forced", behindCase(), [{ force: true, before: syncing }]);
  await scenario("guard.vault-behind-paused", behindCase(), [
    {
      before: (h) =>
        ((h.app as any).internalPlugins = { plugins: { sync: { instance: { pause: true, getStatus: () => "paused" } } } }),
    },
  ]);
  const coldCase = () =>
    mk({
      tasks: [task("A1", false, FUT), task("B2", false, FUT)],
      events: [doneEvent("A1", false, "200")],
      records: { A1: rec({ gcalUpdated: "200" }) },
    });
  const cold = (h: H) => {
    (h.engine as any).loadedAt = Date.now() - 20_000;
    (h.engine as any).pullCycleDone = false;
  };
  await scenario("guard.cold-start", coldCase(), [{ before: cold }]);
  await scenario("guard.cold-start-forced", coldCase(), [{ force: true, before: cold }]);
  const unsettledCreate = () => mk({ tasks: [task("N1", false, FUT), noId(FUT, { line: 1 })], events: [], records: {} });
  const unsettle = (h: H) => ((h.engine as any).settledSince = Date.now());
  await scenario("guard.unsettled-create", unsettledCreate(), [{ before: unsettle }]);
  await scenario("guard.unsettled-create-forced", unsettledCreate(), [{ force: true, before: unsettle }]);

  await scenario("guard.mobile-read-only", () => {
    const ev = doneEvent("A1", false, "200");
    ev.start = { date: "2026-08-20" };
    ev.end = { date: "2026-08-21" };
    const tasks = [task("A1", false), task("N1", false, "2099-01-01"), task("B2", false, FUT)];
    const h = harness({
      tasks,
      events: [ev, doneEvent("B2", false, "100")],
      records: {
        A1: rec({ gcalUpdated: "100" }),
        B2: rec({ eventId: "ev-B2", due: TODAY, start: TODAY, gcalUpdated: "100" }),
      },
      settings: { mobileReadOnly: true },
    });
    return { h, tasks };
  }, [
    {
      force: true,
      before: () => {
        (Platform as any).isMobile = true;
      },
    },
  ]);
  (Platform as any).isMobile = false;

  // ── 🆔 중복 · 되돌림 관측 ─────────────────────────────────────────────────
  await scenario(
    "dup.recurring-repair",
    mk({
      tasks: [
        { ...task("A1", true), recurrence: "every day" },
        { ...task("A1", false, "2026-08-07"), line: 1, recurrence: "every day" },
      ],
      events: [doneEvent("A1", true, "100")],
      records: { A1: rec({ done: true }) },
    })
  );
  await scenario(
    "dup.copied-line-repair",
    mk({
      tasks: [
        { ...task("A1", false), title: "샘플" },
        { ...task("A1", false), line: 1, title: "복사된 다른 일" },
      ],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ title: "샘플" }) },
    })
  );
  await scenario(
    "dup.ambiguous-skip",
    mk({
      tasks: [
        { ...task("A1", true), title: "샘플" },
        { ...task("A1", true), line: 1, title: "샘플" },
      ],
      events: [doneEvent("A1", true, "100")],
      records: { A1: rec({ title: "샘플", done: true }) },
    })
  );
  await scenario("observe.revert-suspect", () => {
    const tasks = [task("A1", false, "2026-08-19")];
    const h = harness({
      tasks,
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec({ pulledLine: "- [ ] #task 샘플 📅 2026-08-20 🆔 A1", pulledAt: Date.now() - 5_000 }) },
    });
    return { h, tasks };
  });

  done();
})();
