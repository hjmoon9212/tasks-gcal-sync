/**
 * 특성화 테스트 — 동기화 로그 항목의 **정확한 문구**(0.12.0 안전망).
 *
 * 로그 파일은 사후 추적의 유일한 근거라, 리팩토링이 문구 한 글자·키 순서 하나를 바꿔도
 * 그건 동작 변경이다. 여기서는 run 이 만든 `entries` 를 **통째로**(action·id·title·calendar·
 * eventId·where·detail, 키 순서까지) 고정한다.
 *
 * private 접근은 전부 helpers/internals.ts 를 거친다 — 이 파일은 리팩토링 동안 바이트 단위로
 * 그대로 두고 통과해야 한다.
 *
 * ※ 하네스의 설정 캐시(calendars)는 비어 있다 → 조정 경로의 calendar 는 calName(id) = id
 *   그대로("cal-1"), 생성·입양 경로는 target.name("Test")이다. 이 차이도 현재 동작이다.
 */
import { installFakeEnv, resetClock } from "./helpers/fakeEnv";
installFakeEnv();

import { Platform } from "obsidian";
import { eq, ok, done } from "./helpers/assert";
import { CAL, TODAY, cancelledEvent, doneEvent, harness, rec, task } from "./helpers/engineHarness";
import * as I from "./helpers/internals";

const FUT = "2026-08-09";
const RAW = (due: string, id = "A1") => `- [ ] #task 샘플 📅 ${due} 🆔 ${id}`;
const noId = (due: string, over: any = {}) => ({
  ...task("", false, due),
  id: undefined,
  raw: `- [ ] #task 샘플 📅 ${due}`,
  ...over,
});

/** 사람이 GCal 에서 옮긴 이벤트(스탬프는 옛 값 그대로). */
const movedByHuman = (to: string, updated = "200") => {
  const ev = doneEvent("A1", false, updated);
  ev.start = { date: to };
  ev.end = { date: addOne(to) };
  return ev;
};
/** 다른 기기가 올린 메아리(값과 스탬프가 같다). */
const echoed = (to: string, updated = "200") => {
  const ev = movedByHuman(to, updated);
  ev.extendedProperties.private.tgsDue = to;
  ev.extendedProperties.private.tgsStart = to;
  return ev;
};
function addOne(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const x = new Date(y, m - 1, day + 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

const SKIP_PULL_FAILED =
  "캘린더를 읽지 못함 → 그 캘린더의 record는 손대지 않음(읽지 못할 때는 쓰지도 않는다)";

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  // A) 로그 문구 조각 — fieldText · diffText · changedFields · lastLineText
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const { engine } = harness({ tasks: [], events: [], records: {} });
    const s = { due: TODAY, start: "2026-08-04", time: "09:00-10:00", done: true, title: "제목" };
    eq(I.fieldText(engine, s, "due"), TODAY, "fieldText: due");
    eq(I.fieldText(engine, { ...s, due: "" }, "due"), "(없음)", "fieldText: 빈 due → (없음)");
    eq(I.fieldText(engine, s, "start"), "2026-08-04", "fieldText: start");
    eq(I.fieldText(engine, { ...s, start: undefined }, "start"), TODAY, "fieldText: start 없음 → due");
    eq(I.fieldText(engine, { ...s, start: "" }, "start"), "", "fieldText: start \"\" 는 그대로 빈 문자열(?? 라서)");
    eq(I.fieldText(engine, s, "time"), "09:00-10:00", "fieldText: time");
    eq(I.fieldText(engine, { ...s, time: "" }, "time"), "(종일)", "fieldText: time \"\" → (종일)");
    eq(I.fieldText(engine, { ...s, time: undefined }, "time"), "(종일)", "fieldText: time 없음 → (종일)");
    eq(I.fieldText(engine, s, "done"), "완료", "fieldText: done true");
    eq(I.fieldText(engine, { ...s, done: false }, "done"), "미완료", "fieldText: done false");
    eq(I.fieldText(engine, s, "title"), "\"제목\"", "fieldText: title 은 따옴표");
    eq(I.fieldText(engine, { ...s, title: "" }, "title"), "\"\"", "fieldText: 빈 제목");

    const b = { due: TODAY, done: false, title: "a" };
    const a = { due: FUT, start: FUT, time: "", done: true, title: "b" };
    eq(
      I.diffText(engine, b, a, ["due", "start", "time", "done", "title"]),
      `due ${TODAY}→${FUT}, start ${TODAY}→${FUT}, time (종일)→(종일), done 미완료→완료, title "a"→"b"`,
      "diffText: 필드 순서대로 · 같아도 적는다"
    );
    eq(I.diffText(engine, b, a, []), "", "diffText: 필드 없음 → 빈 문자열");
    eq(I.diffText(engine, b, a, ["title", "due"]), `title "a"→"b", due ${TODAY}→${FUT}`, "diffText: 넘긴 순서");

    eq(I.changedFields(engine, b, a), ["due", "start", "done", "title"], "changedFields: 기본 필드 순서");
    eq(
      I.changedFields(engine, { due: TODAY, done: false, title: "a" }, { due: TODAY, start: TODAY, time: "", done: false, title: "a" }),
      [],
      "changedFields: start 없음=due · time 없음=\"\" 은 같은 것"
    );
    eq(I.changedFields(engine, b, a, ["title", "due"]), ["title", "due"], "changedFields: 넘긴 필드만 · 그 순서");

    eq(I.lastLineText(engine, rec()), "", "lastLineText: 원문 없음");
    eq(I.lastLineText(engine, rec({ lastLine: "" })), "", "lastLineText: 빈 원문");
    eq(
      I.lastLineText(engine, rec({ lastLine: "  - [ ] x  " })),
      " · 마지막으로 본 줄: `- [ ] x`",
      "lastLineText: 위치 없음 · trim"
    );
    eq(
      I.lastLineText(engine, rec({ lastLine: "- [ ] x", lastWhere: "a/b.md:7" })),
      " · 마지막으로 본 줄 @a/b.md:7: `- [ ] x`",
      "lastLineText: 위치 포함"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // B) 삭제 · 매핑 폐기 · 미일정화
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() } });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "DELETE",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          detail: `노트에서 task 줄이 사라짐 → 이벤트 삭제 (마지막 스냅샷 due=${TODAY})`,
        },
      ],
      "DELETE task-gone: 원문 없음"
    );
    ok(Object.keys(r.entries[0]).includes("where"), "DELETE task-gone: where 키는 undefined 로 존재");
  }
  {
    resetClock();
    const h = harness({
      tasks: [],
      events: [],
      records: {
        A1: rec({ time: "09:00-11:00", lastLine: `  ${RAW(TODAY)}  `, lastWhere: "daily/x.md:3" }),
      },
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "DELETE",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          detail:
            `노트에서 task 줄이 사라짐 → 이벤트 삭제 (마지막 스냅샷 due=${TODAY} 09:00-11:00)` +
            ` · 마지막으로 본 줄 @daily/x.md:3: \`${RAW(TODAY)}\``,
        },
      ],
      "DELETE task-gone: 시각 + 마지막 줄"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("A1", false), due: undefined, line: 4 }],
      events: [],
      records: { A1: rec({ time: "09:00-11:00" }) },
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "DELETE",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:5",
          detail:
            `task는 있으나 📅가 없음 → 이벤트 삭제 (마지막 스냅샷 due=${TODAY})` +
            ` · 마지막으로 본 줄 @note.md:5: \`${RAW(TODAY)}\``,
        },
      ],
      "DELETE due-invalid: 시각은 안 적는다 · 같은 run 에서 본 줄을 싣는다"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", true)],
      events: [cancelledEvent("A1")],
      records: { A1: rec({ done: true }) },
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "DROP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "GCal에서 이벤트가 삭제됨 + 완료된 줄 → 매핑만 폐기(📅는 기록이므로 유지)",
        },
      ],
      "DROP"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [cancelledEvent("A1")],
      records: { A1: rec({ title: "스냅샷 제목" }) },
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "UNSCHEDULE",
          id: "A1",
          title: "스냅샷 제목",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: `GCal에서 이벤트가 삭제됨 → 노트의 📅 ${TODAY} · 🆔 A1 제거(미일정화)`,
        },
      ],
      "UNSCHEDULE: title 은 record 의 것"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // C) 보류(HOLD) · 건너뜀(SKIP)
  // ════════════════════════════════════════════════════════════════════════
  const HOLD_CONFLICT =
    "노트·GCal 값이 갈렸으나 볼트가 아직 정착 전 → 충돌 해결 보류(어느 쪽도 쓰지 않음)";
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [movedByHuman("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    I.setSettledSince(h.engine, Date.now()); // 정착 전
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "HOLD",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: `⚔️⏸ ${HOLD_CONFLICT} — due(노트 2026-08-19 / GCal 2026-08-20), start(노트 2026-08-19 / GCal 2026-08-20), 15초 뒤 재확인`,
        },
      ],
      "HOLD conflict: 첫 보류(보류 시계 없음)"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("A1", false, "2026-08-19"), title: "노트 제목" }],
      events: [
        (() => {
          const ev = movedByHuman("2026-08-20");
          ev.summary = "☐ GCal 제목";
          return ev;
        })(),
      ],
      records: { A1: rec({ gcalUpdated: "100", conflictHeldAt: Date.now() - 45_400 }) },
    });
    I.setSettledSince(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "HOLD",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail:
            `⚔️⏸ ${HOLD_CONFLICT} — due(노트 2026-08-19 / GCal 2026-08-20), start(노트 2026-08-19 / GCal 2026-08-20), ` +
            `title(노트 "노트 제목" / GCal "GCal 제목"), 15초 뒤 재확인 · 45초째 보류(상한 15분 · 리본으로 즉시 해결)`,
        },
      ],
      "HOLD conflict: 보류 경과 초(반올림) · 제목 포함"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() } });
    I.setSettledSince(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          detail: "task가 안 보이지만 지우기엔 이름 → 이벤트 유지",
        },
      ],
      "SKIP hold-task-gone"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("A1", false), due: undefined }],
      events: [],
      records: { A1: rec() },
    });
    I.setSettledSince(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "📅가 없지만 지우기엔 이름 → 이벤트 유지",
        },
      ],
      "SKIP hold-due-invalid"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [cancelledEvent("A1")],
      records: { A1: rec() },
    });
    I.setSettledSince(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "이벤트가 삭제됐지만 미일정화하기엔 이름 → 📅 유지",
        },
      ],
      "SKIP hold-unschedule"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false), { ...task("A1", false), line: 6 }],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:7",
          detail: "같은 🆔가 두 줄 이상 → 정본 불명, 손대지 않음 — note.md:1, note.md:7",
        },
      ],
      "SKIP duplicate-id: 위치 목록 · where 는 마지막 줄"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    I.setLoadedAt(h.engine, Date.now());
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "HOLD",
          id: "N1",
          title: "샘플",
          calendar: "Test",
          where: "note.md:1",
          detail: "콜드 스타트 → 새 이벤트 생성 보류",
        },
      ],
      "HOLD cold-start-create"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, FUT)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    I.setLoadedAt(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "HOLD",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "⏸ 콜드 스타트 → GCal 쓰기 보류(다음 run에 올라감)",
        },
      ],
      "HOLD merge: 콜드 스타트로 push 보류"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [noId(FUT)], events: [], records: {} });
    I.setSettledSince(h.engine, Date.now());
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "HOLD",
          title: "샘플",
          calendar: "Test",
          where: "note.md:1",
          detail:
            "볼트가 아직 정착 전 → 새 🆔 발급·이벤트 생성 보류(노트에 쓰는 순간 편집·Sync와 겹친다)",
        },
      ],
      "HOLD unsettled-create: 🆔 없는 줄(id 키 없음)"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    (h.app as any).internalPlugins = {
      plugins: { sync: { instance: { getStatus: () => "Syncing" } } },
    };
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "SKIP",
          detail: "볼트가 Obsidian Sync로 아직 따라잡는 중 → run 전체 보류(15초 뒤 재확인)",
        },
      ],
      "SKIP vault-behind"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false), task("N1", false, FUT)],
      events: [movedByHuman("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    (Platform as any).isMobile = true;
    try {
      const r = await h.engine.run();
      eq(
        r.entries,
        [
          {
            action: "PULL",
            id: "A1",
            title: "샘플",
            calendar: CAL,
            eventId: "ev-A1",
            where: "note.md:1",
            detail:
              "⬇ 노트 반영: due 2026-08-06→2026-08-20, start 2026-08-06→2026-08-20 | " +
              "⏸ 콜드 스타트 → GCal 쓰기 보류(다음 run에 올라감)",
          },
          {
            action: "SKIP",
            id: "N1",
            title: "샘플",
            calendar: "Test",
            where: "note.md:1",
            detail: "모바일 읽기 전용 → GCal에 쓰지 않음(pull은 정상. 반영은 데스크탑이 맡는다)",
          },
        ],
        "모바일 읽기 전용: PULL(보류 문구는 '콜드 스타트' 그대로) + 생성 SKIP"
      );
    } finally {
      (Platform as any).isMobile = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // D) 생성 · 입양 · 실패
  // ════════════════════════════════════════════════════════════════════════
  const CREATE = (over: any) => ({
    action: "CREATE",
    id: "N1",
    title: "샘플",
    calendar: "Test",
    eventId: "new",
    where: "note.md:1",
    ...over,
  });
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    eq((await h.engine.run()).entries, [CREATE({ detail: `due=${FUT} (종일)` })], "CREATE 종일");
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("N1", false, FUT), start: "2026-08-07" }],
      events: [],
      records: {},
    });
    eq(
      (await h.engine.run()).entries,
      [CREATE({ detail: `due=${FUT} start=2026-08-07 (종일)` })],
      "CREATE 🛫"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("N1", false, FUT), start: "2026-08-12" }],
      events: [],
      records: {},
    });
    eq((await h.engine.run()).entries, [CREATE({ detail: `due=${FUT} (종일)` })], "CREATE 🛫>📅 → start 안 적음");
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("N1", false, FUT), time: "09:00-10:30" }],
      events: [],
      records: {},
    });
    eq((await h.engine.run()).entries, [CREATE({ detail: `due=${FUT} time=09:00-10:30` })], "CREATE 시간지정");
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("N1", false, FUT), start: "2026-08-07", time: "09:00-10:30" }],
      events: [],
      records: {},
    });
    eq(
      (await h.engine.run()).entries,
      [CREATE({ detail: `due=${FUT} start=2026-08-07 (종일)` })],
      "CREATE 다중일 + ⏰ → 종일로 적는다"
    );
  }
  {
    resetClock();
    const tasks = [noId(FUT)];
    const h = harness({ tasks, events: [], records: {} });
    const r = await h.engine.run();
    const newId = tasks[0].id as unknown as string;
    ok(/^[A-Za-z0-9]{6}$/.test(newId), "CREATE 새 🆔: 6자리 영숫자");
    eq(
      r.entries,
      [CREATE({ id: newId, detail: `due=${FUT} (종일) · 🆔를 새로 부여해 노트에 기록` })],
      "CREATE 새 🆔"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [noId(FUT)], events: [], records: {} });
    h.writer.ensureId = async () => {
      throw new Error("줄이 바뀜");
    };
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "SKIP",
          title: "샘플",
          calendar: "Test",
          where: "note.md:1",
          detail: "🆔를 노트에 쓰지 못함: 줄이 바뀜",
        },
      ],
      "SKIP ensure-id-failed: id 키 없음"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    h.client.insertEvent = async () => {
      throw new Error("GCal 400");
    };
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "FAIL",
          id: "N1",
          title: "샘플",
          calendar: "Test",
          where: "note.md:1",
          detail: "이벤트 생성 실패: GCal 400",
        },
      ],
      "FAIL create-failed"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [task("A1", false, FUT)], events: [], records: {} });
    const e1 = doneEvent("A1", false, "300");
    const e2 = { ...doneEvent("A1", false, "301"), id: "ev-A1-dup" };
    const e3 = { ...doneEvent("A1", false, "302"), id: "ev-A1-bad" };
    h.client.findByTaskId = async () => [e1, e2, e3];
    h.client.deleteEvent = async (_c: string, id: string) => {
      if (id === "ev-A1-bad") throw new Error("403");
    };
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "ADOPT",
          id: "A1",
          title: "샘플",
          calendar: "Test",
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "GCal에 이미 있던 이벤트를 매핑으로 회수(다른 기기가 만든 것) — 새로 만들지 않음",
        },
        {
          action: "DELETE",
          id: "A1",
          title: "샘플",
          calendar: "Test",
          eventId: "ev-A1-dup",
          where: "note.md:1",
          detail: "같은 🆔의 중복 이벤트 정리 (정본 ev-A1 유지)",
        },
        {
          action: "FAIL",
          id: "A1",
          calendar: "Test",
          eventId: "ev-A1-bad",
          detail: "중복 이벤트 삭제 실패: 403",
        },
      ],
      "ADOPT + 중복 DELETE + 중복 삭제 FAIL"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [task("A1", false, FUT)], events: [], records: {} });
    h.client.findByTaskId = async () => {
      throw new Error("GCal list 503");
    };
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "FAIL",
          id: "A1",
          title: "샘플",
          calendar: "Test",
          where: "note.md:1",
          detail: "기존 이벤트 조회 실패 → 새로 생성 진행(중복 가능): GCal list 503",
        },
        CREATE({ id: "A1", detail: `due=${FUT} (종일)` }),
      ],
      "FAIL findByTaskId → CREATE"
    );
  }
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() } });
    h.client.deleteEvent = async () => {
      throw new Error("500 boom");
    };
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "FAIL",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          detail: "조정 중 예외: 500 boom",
        },
      ],
      "FAIL reconcile-error"
    );
    eq(r.failures, [{ where: "A1", message: "500 boom" }], "FAIL reconcile-error: failures");
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
      pullFails: true,
    });
    const r = await h.engine.run();
    eq(
      r.entries,
      [
        {
          action: "FAIL",
          calendar: CAL,
          detail: "캘린더를 읽지 못함 → 이 캘린더의 record 는 이번 run 에서 손대지 않는다: pull 실패",
        },
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: SKIP_PULL_FAILED,
        },
      ],
      "FAIL pull-failed + SKIP pull-failed"
    );
    eq(r.failures, [{ where: `pull ${CAL}`, message: "pull 실패" }], "pull-failed: failures");
  }
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() }, pullFails: true });
    eq(
      (await h.engine.run()).entries[1],
      {
        action: "SKIP",
        id: "A1",
        title: "샘플",
        calendar: CAL,
        eventId: "ev-A1",
        detail: SKIP_PULL_FAILED,
      },
      "SKIP pull-failed: task 없으면 where 없음"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // E) 병합 — UPDATE · PULL · MOVE · HOLD 와 충돌 대조
  // ════════════════════════════════════════════════════════════════════════
  const M = (action: string, detail: string, over: any = {}) => ({
    action,
    id: "A1",
    title: "샘플",
    calendar: CAL,
    eventId: "ev-A1",
    where: "note.md:1",
    detail,
    ...over,
  });
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, FUT)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    eq(
      (await h.engine.run()).entries,
      [M("UPDATE", `⬆ GCal 반영: due ${TODAY}→${FUT}, start ${TODAY}→${FUT}`)],
      "UPDATE 날짜"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("A1", true), title: "새 제목", time: "09:00-10:00" }],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "UPDATE",
          '⬆ GCal 반영: time (종일)→09:00-10:00, done 미완료→완료, title "샘플"→"새 제목"',
          { title: "새 제목" }
        ),
      ],
      "UPDATE 시각·완료·제목"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    eq((await h.engine.run()).entries, [], "변화 없음 → 로그 없음");
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [movedByHuman("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "UPDATE",
          "⬇ 노트 반영: due 2026-08-06→2026-08-20, start 2026-08-06→2026-08-20 | ⬆ 이벤트 표현만 재적용(제목 접두사 등)"
        ),
      ],
      "UPDATE: GCal 이동 pull + 표현 재적용"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [movedByHuman("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    I.setLoadedAt(h.engine, Date.now());
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "PULL",
          "⬇ 노트 반영: due 2026-08-06→2026-08-20, start 2026-08-06→2026-08-20 | ⏸ 콜드 스타트 → GCal 쓰기 보류(다음 run에 올라감)"
        ),
      ],
      "PULL: 콜드 스타트라 표현 재적용을 못 함"
    );
  }
  {
    resetClock();
    const ev = doneEvent("A1", false, "200");
    ev.summary = "☐ GCal 제목";
    const h = harness({
      tasks: [task("A1", false)],
      events: [ev],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    h.writer.replaceTitle = async () => {
      throw new Error("drift");
    };
    eq(
      (await h.engine.run()).entries,
      [M("HOLD", '⚠ 노트 반영 실패(값 유지): title "샘플"→"GCal 제목"', { title: "GCal 제목" })],
      "HOLD: 제목 pull 실패(title 은 merged 의 것)"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [echoed("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "UPDATE",
          "⚔️ 충돌 due(노트 2026-08-06→2026-08-19 / GCal 2026-08-06→2026-08-20), " +
            "start(노트 2026-08-06→2026-08-19 / GCal 2026-08-06→2026-08-20) → " +
            "노트 채택(GCal 변경은 메아리 — 스탬프와 값이 같다), GCal 변경 폐기 " +
            "[대조: tgsDue=2026-08-20/현재 2026-08-20 · tgsStart=2026-08-20/현재 2026-08-20]" +
            " | ⬆ GCal 반영: due 2026-08-06→2026-08-19, start 2026-08-06→2026-08-19"
        ),
      ],
      "UPDATE: 충돌(메아리 → 노트 채택) + [대조]"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [movedByHuman("2026-08-20")],
      records: { A1: rec({ gcalUpdated: "100" }) },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "UPDATE",
          "⚔️ 충돌 due(노트 2026-08-06→2026-08-19 / GCal 2026-08-06→2026-08-20), " +
            "start(노트 2026-08-06→2026-08-19 / GCal 2026-08-06→2026-08-20) → " +
            "GCal 채택(사람이 캘린더에서 편집), 노트 변경 폐기 " +
            "[대조: tgsDue=2026-08-06/현재 2026-08-20 · tgsStart=2026-08-06/현재 2026-08-20]" +
            " | ⬇ 노트 반영: due 2026-08-06→2026-08-20, start 2026-08-06→2026-08-20" +
            " | ⬆ 이벤트 표현만 재적용(제목 접두사 등)"
        ),
      ],
      "UPDATE: 충돌(사람 편집 → GCal 채택) + [대조]"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false)],
      events: [doneEvent("A1", true, "100")],
      records: { A1: rec({ done: true }) },
    });
    eq(
      (await h.engine.run()).entries,
      [M("HOLD", "⏸ 완료 해제(완료→미완료)를 한 사이클 보류 — 62초 뒤 재확인")],
      "HOLD: 완료 해제 보류"
    );
  }
  {
    resetClock();
    const ev = doneEvent("A1", false, "200");
    ev.start = { dateTime: "2026-08-04T09:00:00", timeZone: "Asia/Seoul" };
    ev.end = { dateTime: "2026-08-06T11:00:00", timeZone: "Asia/Seoul" };
    ev.extendedProperties.private.tgsStart = "2026-08-04";
    const h = harness({
      tasks: [{ ...task("A1", false), start: "2026-08-04" }],
      events: [ev],
      records: { A1: rec({ start: "2026-08-04", gcalUpdated: "100" }) },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "HOLD",
          "⚠ GCal이 시각을 지정했으나 여러 날에 걸친 task 라 받지 않음 (🛫<📅 구간은 종일로만 표현된다 — 🛫를 떼면 시각을 쓸 수 있다)"
        ),
      ],
      "HOLD: 다중일에 GCal 시각"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
      patchPrecondition: true,
    });
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail: "pull 이후 GCal이 또 바뀜 → push 포기(다음 run이 새 상태로 다시 판정한다)",
        },
        M("HOLD", "⏸ pull 이후 GCal이 또 바뀜 → push 포기(덮지 않는다. 다음 run이 새 상태로 재판정)"),
      ],
      "SKIP 412 + HOLD"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [{ ...task("A1", false, FUT), tags: ["#task", "#gcal/Growth"] }],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
      settings: {
        rules: [{ tag: "Growth", calendarId: "cal-growth", calendarName: "Growth(규칙)" }],
        calendars: [
          { id: CAL, name: "Test캘" },
          { id: "cal-growth", name: "Growth캘" },
        ],
      },
    });
    eq(
      (await h.engine.run()).entries,
      [
        M(
          "MOVE",
          `⬆ GCal 반영: due ${TODAY}→${FUT}, start ${TODAY}→${FUT} | ↔ 캘린더 이동: Test캘 → Growth캘 (이벤트 재생성)`,
          { calendar: "Growth캘", eventId: "new" }
        ),
      ],
      "MOVE: 이름은 calendars 캐시에서"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // F) 되돌림 의심 관측 · 🆔 중복 자동 정리
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, "2026-08-19")],
      events: [doneEvent("A1", false, "100")],
      records: {
        A1: rec({ pulledLine: RAW("2026-08-20"), pulledAt: Date.now() - 14_400 }),
      },
    });
    eq(
      (await h.engine.run()).entries,
      [
        {
          action: "SKIP",
          id: "A1",
          title: "샘플",
          calendar: CAL,
          eventId: "ev-A1",
          where: "note.md:1",
          detail:
            "※ 관측: 14초 전 pull 로 쓴 줄이 달라졌다(GCal 은 그대로). " +
            "사용자 편집이면 정상이고, 건드린 적이 없다면 되돌림이다 — " +
            `쓴 줄 \`${RAW("2026-08-20")}\` → 지금 \`${RAW("2026-08-19")}\``,
        },
        M("UPDATE", `⬆ GCal 반영: due ${TODAY}→2026-08-19, start ${TODAY}→2026-08-19`),
      ],
      "SKIP 되돌림 의심 관측 → 이어서 UPDATE"
    );
  }
  {
    resetClock();
    const tasks = [
      { ...task("A1", true), recurrence: "every day" } as any,
      { ...task("A1", false, "2026-08-07"), line: 1, recurrence: "every day" } as any,
    ];
    const h = harness({
      tasks,
      events: [doneEvent("A1", true, "100")],
      records: { A1: rec({ done: true }) },
    });
    const r = await h.engine.run();
    eq(
      r.entries[0],
      {
        action: "REPAIR",
        id: "A1",
        where: "note.md:2",
        detail: "반복(🔁) 완료가 만든 중복 → 새 회차 줄에서 🆔 제거(다음 run이 새 🆔·이벤트를 준다)",
      },
      "REPAIR: 반복 완료"
    );
    eq(
      r.entries.map((e) => e.action),
      ["REPAIR", "CREATE"],
      "REPAIR: 같은 run 에서 새 회차가 새 🆔로 생성된다(현재 동작)"
    );
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false), { ...task("A1", false), title: "복사된 다른 일", line: 2 }],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    const r = await h.engine.run();
    eq(
      r.entries[0],
      {
        action: "REPAIR",
        id: "A1",
        where: "note.md:3",
        detail:
          '서로 다른 task 가 같은 🆔 → 원본(제목 "샘플")이 아닌 줄에서 🆔 제거(다음 run이 새 🆔·이벤트를 준다)',
      },
      "REPAIR: 다른 task 가 같은 🆔"
    );
    eq(r.entries.map((e) => e.action), ["REPAIR", "CREATE"], "REPAIR(b): 이어서 CREATE");
  }

  // ════════════════════════════════════════════════════════════════════════
  // G) logMerge 직접 — run 으로는 닿기 어려운 문구
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const { engine } = harness({ tasks: [], events: [], records: {} });
    const snap = { due: TODAY, start: TODAY, time: "", done: false, title: "샘플" };
    const plan = (over: any) => ({
      kind: "merge",
      pull: {},
      pulledFields: [],
      conflicts: [],
      gcalWins: [],
      agreed: [],
      remote: snap,
      pushNeeded: false,
      normalizeIfPulled: false,
      holdDone: false,
      uncheckSeen: undefined,
      conflictHeldClear: false,
      gcalChanged: false,
      timeIgnoredMultiDay: false,
      merged: snap,
      local: snap,
      ...over,
    });
    const run = (over: any, c: any = {}) => {
      const result: any = { entries: [] };
      I.logMerge(engine, {
        plan: plan(over),
        id: "A1",
        rec: rec(),
        task: task("A1", false),
        before: { ...snap },
        fromCalendar: CAL,
        applied: [],
        pushKind: null,
        blockedByCold: false,
        precondFailed: false,
        ev: undefined,
        result,
        where: "note.md:1",
        ...c,
      });
      return result.entries;
    };
    eq(run({}), [], "logMerge: 한 일 없음 → 기록 없음");
    eq(
      run(
        { conflicts: ["title"], local: { ...snap, title: "노트" }, remote: { ...snap, title: "지캘" } },
        { pushKind: "update" }
      ),
      [
        M(
          "UPDATE",
          '⚔️ 충돌 title(노트 "샘플"→"노트" / GCal "샘플"→"지캘") → 노트 채택(GCal 변경은 메아리 — 스탬프와 값이 같다), GCal 변경 폐기 [스탬프 없음 — 판정 불가]' +
            ' | ⬆ GCal 반영: title "샘플"→"노트"'
        ),
      ],
      "logMerge: 이벤트 없음 → [스탬프 없음 — 판정 불가] · title 은 merged 우선"
    );
    eq(
      run(
        { gcalWins: ["time"], remote: { ...snap, time: "10:00-11:00" }, merged: { ...snap, title: "" }, local: { ...snap, title: "로컬" } },
        { ev: { extendedProperties: { private: {} } } }
      ),
      [
        M(
          "HOLD",
          "⚔️ 충돌 time(노트 (종일)→(종일) / GCal (종일)→10:00-11:00) → GCal 채택(사람이 캘린더에서 편집), 노트 변경 폐기 [대조: tgsDue=-/현재 2026-08-06 · tgsStart=-/현재 2026-08-06]",
          { title: "로컬" }
        ),
      ],
      "logMerge: 스탬프 키 없음 → '-' · merged 제목이 비면 local 제목"
    );
    eq(
      run({ holdDone: true, retryAfterMs: 1_499 }, { blockedByCold: true, precondFailed: true, pushKind: "presentation" }),
      [
        M(
          "UPDATE",
          "⬆ 이벤트 표현만 재적용(제목 접두사 등) | ⏸ 완료 해제(완료→미완료)를 한 사이클 보류 — 1초 뒤 재확인" +
            " | ⏸ 콜드 스타트 → GCal 쓰기 보류(다음 run에 올라감)" +
            " | ⏸ pull 이후 GCal이 또 바뀜 → push 포기(덮지 않는다. 다음 run이 새 상태로 재판정)"
        ),
      ],
      "logMerge: 보류 문구 순서"
    );
    eq(
      run({ holdDone: true }),
      [M("HOLD", "⏸ 완료 해제(완료→미완료)를 한 사이클 보류 — 0초 뒤 재확인")],
      "logMerge: retryAfterMs 없음 → 0초"
    );
    eq(
      run({ pulledFields: ["due", "title"], merged: { ...snap, due: FUT, title: "새" } }, { applied: ["due"] }),
      [
        M("PULL", `⬇ 노트 반영: due ${TODAY}→${FUT} | ⚠ 노트 반영 실패(값 유지): title "샘플"→"새"`, {
          title: "새",
        }),
      ],
      "logMerge: 일부 반영 · 일부 실패"
    );
    eq(
      run(
        { local: { ...snap, due: FUT }, merged: { ...snap, due: FUT }, pulledFields: ["due"] },
        { pushKind: "move", applied: ["due"], rec: rec({ calendarId: "cal-z" }) }
      ),
      [
        M("MOVE", `⬇ 노트 반영: due ${TODAY}→${FUT} | ↔ 캘린더 이동: ${CAL} → cal-z (이벤트 재생성)`, {
          calendar: "cal-z",
        }),
      ],
      "logMerge: move 인데 올린 필드가 pull 된 것뿐이면 ⬆ 없이 이동만"
    );
  }

  done();
})();
