/**
 * 특성화 테스트 — 표현(제목·설명·색) · 시각 매핑 · tgs* 스탬프 코덱(0.12.0 안전망).
 *
 * "옳은 동작"이 아니라 **현재 동작**을 고정한다. 0.12.x 리팩토링이 이 함수들을 다른 모듈로
 * 옮겨도 이 파일은 바이트 단위로 그대로 두고 통과해야 한다 — private 접근은 전부
 * helpers/internals.ts 를 거친다(여기서 엔진을 any 로 캐스팅해 부르지 않는다).
 *
 * 비교는 JSON 직렬화 동등이라 **키 순서까지** 고정된다(patch·이벤트 모양이 곧 동작이다).
 * 타임존은 기기마다 달라서 `timeZone` 값만 `<TZ>` 로 바꿔 비교한다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { eq, ok, done } from "./helpers/assert";
import { CAL, TODAY, doneEvent, harness, task, timedEvent } from "./helpers/engineHarness";
import * as I from "./helpers/internals";

const mk = (settings: any = {}) =>
  harness({ tasks: [], events: [], records: {}, settings });

/** timeZone 값만 `<TZ>` 로. null(명시적 제거)은 그대로 둔다. */
const tz = (v: unknown): unknown =>
  v === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(v, (k, x) => (k === "timeZone" && typeof x === "string" ? "<TZ>" : x))
      );

const BLOCK = "— tasks-gcal-sync —\n📁 vault\n🆔 A1";
const LINK_NOTE = "obsidian://open?vault=vault&file=note.md";

(() => {
  // ════════════════════════════════════════════════════════════════════════
  // 1) 제목: titleBase · summary
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    eq(I.titleBase(engine, task("A1", false)), "샘플", "titleBase: 그대로");
    eq(
      I.titleBase(engine, { ...task("A1", false), title: "회의 #gcal/Growth 준비" }),
      "회의 준비",
      "titleBase: 라우팅 태그 제거"
    );
    eq(
      I.titleBase(engine, { ...task("A1", false), title: "#gcal/ 샘플" }),
      "샘플",
      "titleBase: 이름 없는 #gcal/ 도 제거"
    );
    eq(
      I.titleBase(engine, { ...task("A1", false), title: "#gcalx #GCAL/A 샘플" }),
      "#gcalx #GCAL/A 샘플",
      "titleBase: 접두사가 정확히 #gcal/ 인 단어만(대소문자 구분)"
    );
    eq(
      I.titleBase(engine, { ...task("A1", false), title: "  a \t  b  " }),
      "a b",
      "titleBase: 공백을 한 칸으로 접는다"
    );
    eq(
      I.titleBase(engine, { ...task("A1", false), title: "#gcal/X" }),
      "",
      "titleBase: 태그뿐이면 빈 문자열"
    );

    const t = task("A1", false);
    const c = task("A1", true);
    const r = { ...task("A1", false), recurrence: "every day" };
    const rc = { ...task("A1", true), recurrence: "every day" };
    eq(I.summary(engine, t), "☐ 샘플", "summary: 미완료 ☐");
    eq(I.summary(engine, c), "☑️ 샘플", "summary: 완료 ☑️");
    eq(I.summary(engine, r), "☐ 🔁 샘플", "summary: 반복은 체크박스 뒤에 🔁");
    eq(I.summary(engine, rc), "☑️ 🔁 샘플", "summary: 완료 반복");
    eq(
      I.summary(engine, { ...task("A1", false), title: "회의 #gcal/Growth" }),
      "☐ 회의",
      "summary: 라우팅 태그는 제목에서 빠진다"
    );
  }
  {
    const { engine } = mk({ todoPrefix: "", donePrefix: "", recurringPrefix: "" });
    eq(I.summary(engine, task("A1", false)), "샘플", "summary: 접두사 모두 끔 → 제목만");
    eq(I.summary(engine, task("A1", true)), "샘플", "summary: 완료도 #done 을 끼우지 않는다");
    eq(
      I.summary(engine, { ...task("A1", true), recurrence: "every day" }),
      "샘플",
      "summary: 반복 아이콘도 끔"
    );
  }
  {
    const { engine } = mk({ recurringPrefix: "" });
    eq(
      I.summary(engine, { ...task("A1", false), recurrence: "every day" }),
      "☐ 샘플",
      "summary: 반복 아이콘만 끔"
    );
  }
  {
    const { engine } = mk({ todoPrefix: "  [ ]  ", recurringPrefix: " ↻ " });
    eq(
      I.summary(engine, { ...task("A1", false), recurrence: "every day" }),
      "[ ] ↻ 샘플",
      "summary: 접두사 앞뒤 공백은 trim"
    );
  }
  {
    const { engine } = mk({ donePrefix: "   " });
    eq(I.summary(engine, task("A1", true)), "샘플", "summary: 공백뿐인 접두사는 없는 것");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2) GCal 제목 → 순수 제목: gcalTitleBase
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    const g = (summary: any) => I.gcalTitleBase(engine, { summary });
    eq(g("☐ 샘플"), "샘플", "gcalTitleBase: ☐");
    eq(g("☑️ 샘플"), "샘플", "gcalTitleBase: ☑️");
    eq(g("☑️ 🔁 샘플"), "샘플", "gcalTitleBase: ☑️ 🔁");
    eq(g("🔁 ☐ 샘플"), "샘플", "gcalTitleBase: 순서가 뒤바뀌어도");
    eq(g("☐ ☐ 샘플"), "샘플", "gcalTitleBase: 같은 접두사 반복");
    eq(g("#done 샘플"), "샘플", "gcalTitleBase: 옛 #done");
    eq(g("☑️ #done 샘플"), "샘플", "gcalTitleBase: ☑️ + 옛 #done");
    eq(g("  ☐샘플  "), "샘플", "gcalTitleBase: 공백 없이 붙어도 떼고 trim");
    eq(g("#doneness"), "ness", "gcalTitleBase: #done 은 단어 경계를 안 본다(현재 동작)");
    eq(g("샘플 ☐"), "샘플 ☐", "gcalTitleBase: 뒤에 붙은 건 그대로");
    eq(g("☑ 샘플"), "☑ 샘플", "gcalTitleBase: VS16 없는 ☑ 는 다른 글자");
    eq(g(undefined), "", "gcalTitleBase: summary 없음 → 빈 문자열");
    eq(g("☐"), "", "gcalTitleBase: 접두사뿐");
    eq(g("회의 #gcal/X"), "회의 #gcal/X", "gcalTitleBase: 라우팅 태그는 안 뗀다");
  }
  {
    const { engine } = mk({ donePrefix: "", todoPrefix: "", recurringPrefix: "" });
    eq(
      I.gcalTitleBase(engine, { summary: "☑️ 🔁 샘플" }),
      "☑️ 🔁 샘플",
      "gcalTitleBase: 설정에서 끈 접두사는 떼지 않는다"
    );
    eq(
      I.gcalTitleBase(engine, { summary: "#done 샘플" }),
      "샘플",
      "gcalTitleBase: #done 은 설정과 무관하게 뗀다"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3) 딥링크 · 설명 블록
  // ════════════════════════════════════════════════════════════════════════
  {
    const t = task("A1", false);
    eq(I.deepLink(mk({ deepLink: "off" }).engine, t), null, "deepLink: off → null");
    eq(I.deepLink(mk({ deepLink: "note" }).engine, t), LINK_NOTE, "deepLink: note");
    eq(
      I.deepLink(mk({ deepLink: "line" }).engine, { ...t, line: 4 }),
      "obsidian://adv-uri?vault=vault&filepath=note.md&line=5",
      "deepLink: line 은 1-based"
    );
    eq(
      I.deepLink(mk({ deepLink: "note" }).engine, { ...t, path: "폴더/a b&c.md" }),
      "obsidian://open?vault=vault&file=%ED%8F%B4%EB%8D%94%2Fa%20b%26c.md",
      "deepLink: 경로는 encodeURIComponent"
    );
    eq(
      I.deepLink(mk({ deepLink: "line" }).engine, { ...t, path: "x/y.md" }),
      "obsidian://adv-uri?vault=vault&filepath=x%2Fy.md&line=1",
      "deepLink: line 경로도 인코딩"
    );
    eq(
      I.deepLink(mk({ deepLink: "bogus" }).engine, t),
      LINK_NOTE,
      "deepLink: 모르는 값은 note 로 떨어진다"
    );
  }
  {
    const { engine } = mk();
    eq(I.noteBlock(engine, "A1"), BLOCK, "noteBlock: task 없음 → 링크 없음");
    eq(
      I.noteBlock(engine, "A1", task("A1", false)),
      `${BLOCK}\n🔗 ${LINK_NOTE}`,
      "noteBlock: task 있음 → 🔗"
    );
    eq(
      I.noteBlock(mk({ deepLink: "off" }).engine, "A1", task("A1", false)),
      BLOCK,
      "noteBlock: deepLink off → 링크 없음"
    );
  }
  {
    const { engine } = mk();
    const u = (s: any) => I.userDescription(engine, s);
    eq(u(`메모\n\n${BLOCK}\n🔗 x`), "메모", "userDescription: 마커 위만 남긴다");
    eq(u(`메모\n  — tasks-gcal-sync —  \n🆔 A1`), "메모", "userDescription: 마커 줄은 trim 비교");
    eq(u(`${BLOCK}`), "", "userDescription: 마커가 첫 줄이면 빈 문자열");
    eq(
      u(`위\n— tasks-gcal-sync —\n🆔 A1\n사용자가 아래 적은 것`),
      "위",
      "userDescription: 마커 아래는 사용자 글이라도 버린다(현재 동작)"
    );
    eq(
      u("메모\n📁 vault\n🆔 A1\n🔗 x\n\n"),
      "메모",
      "userDescription: 마커 없음 → 끝의 📁/🆔/🔗/빈 줄만 걷는다"
    );
    eq(u("📁 vault\n🆔 A1"), "", "userDescription: 옛 블록뿐 → 빈 문자열");
    eq(u("🆔 A1\n메모"), "🆔 A1\n메모", "userDescription: 끝이 아니면 안 걷는다");
    eq(u("메모 🆔 inline"), "메모 🆔 inline", "userDescription: 줄 머리가 아니면 안 걷는다");
    eq(u("  🔗 x"), "", "userDescription: 앞 공백은 trim 뒤 판정");
    eq(u("메모   \n\n"), "메모", "userDescription: trimEnd");
    eq(u(""), "", "userDescription: 빈 설명");
    let threw = "";
    try {
      u(undefined);
    } catch (e) {
      threw = e instanceof TypeError ? "TypeError" : String(e);
    }
    eq(threw, "TypeError", "userDescription: undefined 는 던진다(호출부가 ?? \"\" 로 막는다)");
  }
  {
    const { engine } = mk();
    const t = task("A1", false);
    eq(
      I.mergeDescription(engine, "메모", "A1", t),
      `메모\n\n${BLOCK}\n🔗 ${LINK_NOTE}`,
      "mergeDescription: 사용자 글 + 빈 줄 + 블록"
    );
    eq(I.mergeDescription(engine, "", "A1"), BLOCK, "mergeDescription: 사용자 글 없음 → 블록만");
    eq(
      I.mergeDescription(engine, `메모\n\n${BLOCK}\n🔗 old`, "A1", t),
      `메모\n\n${BLOCK}\n🔗 ${LINK_NOTE}`,
      "mergeDescription: 멱등(블록만 갱신)"
    );
    eq(
      I.mergeDescription(engine, "📁 old\n🆔 A1", "A1"),
      BLOCK,
      "mergeDescription: 옛 블록은 새 블록으로 교체"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4) 완료색 · presentationPatch · buildEvent (키 순서까지)
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    eq(I.doneColor(engine, task("A1", true)), "8", "doneColor: 완료 → 완료색");
    eq(I.doneColor(engine, task("A1", false)), null, "doneColor: 미완료 → null(기본색)");
    const off = mk({ doneColorId: "" }).engine;
    eq(I.doneColor(off, task("A1", true)), undefined, "doneColor: 끔 → undefined");
    eq(I.doneColor(off, task("A1", false)), undefined, "doneColor: 끔 → undefined(미완료)");
  }
  const PROPS = (over: Record<string, string> = {}) => ({
    tgsTaskId: "A1",
    tgsSource: "tasks-gcal-sync",
    tgsVault: "vault",
    tgsDue: TODAY,
    tgsStart: TODAY,
    tgsTime: "",
    tgsDone: "0",
    tgsTitle: "샘플",
    ...over,
  });
  {
    const { engine } = mk();
    const t = task("A1", false);
    eq(
      JSON.stringify(I.presentationPatch(engine, "A1", t)),
      JSON.stringify({
        summary: "☐ 샘플",
        extendedProperties: { private: PROPS() },
        colorId: null,
      }),
      "presentationPatch: 이벤트 모름 → description 키 없음"
    );
    ok(
      !("description" in I.presentationPatch(engine, "A1", t)),
      "presentationPatch: description 키 자체가 없다"
    );
    eq(
      JSON.stringify(I.presentationPatch(engine, "A1", t, { description: "메모" })),
      JSON.stringify({
        summary: "☐ 샘플",
        extendedProperties: { private: PROPS() },
        description: `메모\n\n${BLOCK}\n🔗 ${LINK_NOTE}`,
        colorId: null,
      }),
      "presentationPatch: 이벤트 앎 → description 병합"
    );
    eq(
      JSON.stringify(I.presentationPatch(engine, "A1", t, {})),
      JSON.stringify({
        summary: "☐ 샘플",
        extendedProperties: { private: PROPS() },
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        colorId: null,
      }),
      "presentationPatch: 설명 없는 이벤트 → 블록만"
    );
    eq(
      JSON.stringify(
        I.presentationPatch(
          engine,
          "A1",
          { ...task("A1", true), done: "2026-08-05", recurrence: "every day" },
          { description: "" }
        )
      ),
      JSON.stringify({
        summary: "☑️ 🔁 샘플",
        extendedProperties: { private: PROPS({ tgsDone: "1", tgsDoneAt: "2026-08-05" }) },
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        colorId: "8",
      }),
      "presentationPatch: 완료 반복 + 완료일"
    );
    const off = mk({ doneColorId: "", deepLink: "off" }).engine;
    eq(
      JSON.stringify(I.presentationPatch(off, "A1", task("A1", true), { description: "x" })),
      JSON.stringify({
        summary: "☑️ 샘플",
        extendedProperties: { private: PROPS({ tgsDone: "1" }) },
        description: `x\n\n${BLOCK}`,
      }),
      "presentationPatch: 색 끔 → colorId 키 없음"
    );
  }
  {
    const { engine } = mk();
    const FUT = "2026-08-09";
    eq(
      JSON.stringify(I.buildEvent(engine, task("A1", false, FUT), "A1")),
      JSON.stringify({
        summary: "☐ 샘플",
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        start: { date: FUT },
        end: { date: "2026-08-10" },
        extendedProperties: { private: PROPS({ tgsDue: FUT, tgsStart: FUT }) },
        colorId: null,
      }),
      "buildEvent: 종일"
    );
    eq(
      JSON.stringify(
        I.buildEvent(engine, { ...task("A1", false, FUT), start: "2026-08-07" }, "A1")
      ),
      JSON.stringify({
        summary: "☐ 샘플",
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        start: { date: "2026-08-07" },
        end: { date: "2026-08-10" },
        extendedProperties: { private: PROPS({ tgsDue: FUT, tgsStart: "2026-08-07" }) },
        colorId: null,
      }),
      "buildEvent: 🛫 다중일 종일"
    );
    eq(
      JSON.stringify(tz(I.buildEvent(engine, { ...task("A1", false, FUT), time: "09:00-10:30" }, "A1"))),
      JSON.stringify({
        summary: "☐ 샘플",
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        start: { dateTime: "2026-08-09T09:00:00", timeZone: "<TZ>" },
        end: { dateTime: "2026-08-09T10:30:00", timeZone: "<TZ>" },
        extendedProperties: {
          private: PROPS({ tgsDue: FUT, tgsStart: FUT, tgsTime: "09:00-10:30" }),
        },
        colorId: null,
      }),
      "buildEvent: 시간지정"
    );
    eq(
      JSON.stringify(
        tz(
          I.buildEvent(
            engine,
            { ...task("A1", false, FUT), start: "2026-08-07", time: "09:00-10:30" },
            "A1"
          )
        )
      ),
      JSON.stringify({
        summary: "☐ 샘플",
        description: `${BLOCK}\n🔗 ${LINK_NOTE}`,
        start: { date: "2026-08-07" },
        end: { date: "2026-08-10" },
        extendedProperties: { private: PROPS({ tgsDue: FUT, tgsStart: "2026-08-07" }) },
        colorId: null,
      }),
      "buildEvent: 다중일이면 ⏰ 무시 → 종일"
    );
    const off = mk({ doneColorId: "", deepLink: "off" }).engine;
    eq(
      JSON.stringify(I.buildEvent(off, task("A1", true), "A1")),
      JSON.stringify({
        summary: "☑️ 샘플",
        description: BLOCK,
        start: { date: TODAY },
        end: { date: "2026-08-07" },
        extendedProperties: { private: PROPS({ tgsDone: "1" }) },
      }),
      "buildEvent: 색·링크 끔"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5) 시각·날짜 매핑
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    const T = (over: any) => ({ ...task("A1", false), ...over });
    eq(I.spanStart(engine, T({})), TODAY, "spanStart: 🛫 없음 → 📅");
    eq(I.spanStart(engine, T({ start: "2026-08-04" })), "2026-08-04", "spanStart: 🛫<📅 → 🛫");
    eq(I.spanStart(engine, T({ start: TODAY })), TODAY, "spanStart: 🛫=📅");
    eq(I.spanStart(engine, T({ start: "2026-08-09" })), TODAY, "spanStart: 🛫>📅 → 📅");
    eq(
      I.spanStart(engine, T({ start: "2026-08-04", due: undefined })),
      undefined,
      "spanStart: 📅 없음 → undefined"
    );

    eq(I.eventStartDate(engine, { start: { date: TODAY } }), TODAY, "eventStartDate: 종일");
    eq(
      I.eventStartDate(engine, { start: { dateTime: "2026-08-06T23:30:00+09:00" } }),
      TODAY,
      "eventStartDate: 시간지정은 앞 10자리(오프셋 무시)"
    );
    eq(I.eventStartDate(engine, {}), undefined, "eventStartDate: 없음");
    eq(
      I.eventStartDate(engine, { start: { date: TODAY, dateTime: "2026-08-01T09:00:00" } }),
      TODAY,
      "eventStartDate: date 가 우선"
    );

    eq(
      I.eventDueDate(engine, { start: { date: TODAY }, end: { date: "2026-08-07" } }),
      TODAY,
      "eventDueDate: 종일은 배타적 끝 −1"
    );
    eq(
      I.eventDueDate(engine, { start: { date: "2026-08-30" }, end: { date: "2026-09-01" } }),
      "2026-08-31",
      "eventDueDate: 월 경계"
    );
    eq(
      I.eventDueDate(engine, {
        start: { dateTime: "2026-08-06T09:00:00" },
        end: { dateTime: "2026-08-07T01:00:00" },
      }),
      "2026-08-07",
      "eventDueDate: 시간지정은 end 날짜 그대로"
    );
    eq(
      I.eventDueDate(engine, { start: { date: TODAY }, end: { dateTime: "2026-08-08T10:00:00" } }),
      "2026-08-08",
      "eventDueDate: 혼합형(end 만 dateTime)"
    );
    eq(
      I.eventDueDate(engine, { start: { dateTime: "2026-08-06T10:00:00" }, end: { date: "2026-08-08" } }),
      "2026-08-07",
      "eventDueDate: 혼합형(end 가 date)"
    );
    eq(I.eventDueDate(engine, { start: { date: TODAY } }), TODAY, "eventDueDate: end 없음 → 시작일");
    eq(I.eventDueDate(engine, {}), undefined, "eventDueDate: 둘 다 없음");

    const R = (s: any, e: any) => I.eventTimeRange(engine, { start: s, end: e });
    eq(R({ date: TODAY }, { date: "2026-08-07" }), "", "eventTimeRange: 종일 → \"\"");
    eq(
      R({ dateTime: `${TODAY}T09:00:00` }, { dateTime: `${TODAY}T11:00:00` }),
      "09:00-11:00",
      "eventTimeRange: 시간지정"
    );
    eq(
      R({ dateTime: `${TODAY}T09:05:00+09:00` }, { dateTime: `${TODAY}T10:00:00+09:00` }),
      "09:05-10:00",
      "eventTimeRange: 오프셋은 무시하고 벽시계 자리만"
    );
    eq(R({ date: TODAY }, { dateTime: `${TODAY}T11:00:00` }), undefined, "eventTimeRange: 혼합형 A");
    eq(R({ dateTime: `${TODAY}T09:00:00` }, { date: "2026-08-07" }), undefined, "eventTimeRange: 혼합형 B");
    eq(
      R({ dateTime: `${TODAY}T23:00:00` }, { dateTime: "2026-08-07T01:00:00" }),
      undefined,
      "eventTimeRange: 자정 넘김 → 판정 불가"
    );
    eq(
      R({ dateTime: `${TODAY}T09:00:00` }, { dateTime: `${TODAY}T09:00:00` }),
      undefined,
      "eventTimeRange: 길이 0 → 판정 불가"
    );
    eq(
      R({ dateTime: `${TODAY}T09:00:00` }, { dateTime: "2026-08-08T11:00:00" }),
      "09:00-11:00",
      "eventTimeRange: 여러 날 시간지정도 시각이 순서만 맞으면 범위로 읽는다(현재 동작 — 날짜는 안 본다)"
    );
    eq(R({ dateTime: TODAY }, { dateTime: TODAY }), undefined, "eventTimeRange: T 없는 dateTime");
    eq(R(undefined, undefined), undefined, "eventTimeRange: start/end 없음");
    eq(R({ date: TODAY }, undefined), undefined, "eventTimeRange: end 없음");

    eq(I.isMultiDay(engine, T({ start: "2026-08-05" })), true, "isMultiDay: 🛫<📅");
    eq(I.isMultiDay(engine, T({ start: TODAY })), false, "isMultiDay: 🛫=📅");
    eq(I.isMultiDay(engine, T({ start: "2026-08-07" })), false, "isMultiDay: 🛫>📅");
    eq(I.isMultiDay(engine, T({})), false, "isMultiDay: 🛫 없음");

    eq(I.taskTime(engine, T({ time: "09:00-11:00" })), "09:00-11:00", "taskTime: 유효");
    eq(I.taskTime(engine, T({ time: "09:00-11:00", start: TODAY })), "09:00-11:00", "taskTime: 🛫=📅");
    eq(I.taskTime(engine, T({ time: "09:00-11:00", start: "2026-08-05" })), "", "taskTime: 다중일 → \"\"");
    eq(I.taskTime(engine, T({ time: "11:00-09:00" })), "", "taskTime: 역순 → \"\"");
    eq(I.taskTime(engine, T({ time: "9:00-11:00" })), "", "taskTime: 정규화 안 된 값 → \"\"");
    eq(I.taskTime(engine, T({})), "", "taskTime: 없음 → \"\"");

    eq(I.timedDates(engine, T({})), null, "timedDates: ⏰ 없음 → null");
    eq(
      I.timedDates(engine, T({ time: "09:00-11:00", start: "2026-08-05" })),
      null,
      "timedDates: 다중일 → null"
    );
    eq(
      tz(I.timedDates(engine, T({ time: "09:00-11:00" }))),
      {
        start: { dateTime: `${TODAY}T09:00:00`, timeZone: "<TZ>" },
        end: { dateTime: `${TODAY}T11:00:00`, timeZone: "<TZ>" },
      },
      "timedDates: 하루짜리"
    );
    eq(
      tz(I.timedDates(engine, T({ time: "09:00-11:00", start: "2026-08-08" }))),
      {
        start: { dateTime: `${TODAY}T09:00:00`, timeZone: "<TZ>" },
        end: { dateTime: `${TODAY}T11:00:00`, timeZone: "<TZ>" },
      },
      "timedDates: 🛫>📅 → 📅 하루로"
    );
    const tzv = (I.timedDates(engine, T({ time: "09:00-11:00" })) as any).start.timeZone;
    ok(typeof tzv === "string" && tzv.length > 0, "timedDates: timeZone 은 비어 있지 않은 문자열");

    eq(
      JSON.stringify(I.exclusiveDates(engine, { start: { date: TODAY }, end: { date: "2026-08-07" } })),
      JSON.stringify({
        start: { date: TODAY, dateTime: null, timeZone: null },
        end: { date: "2026-08-07", dateTime: null, timeZone: null },
      }),
      "exclusiveDates: 종일 → 시간 표현 null"
    );
    eq(
      JSON.stringify(
        I.exclusiveDates(engine, {
          summary: "s",
          start: { dateTime: `${TODAY}T09:00:00`, timeZone: "Z" },
          end: { dateTime: `${TODAY}T10:00:00`, timeZone: "Z" },
          colorId: null,
        })
      ),
      JSON.stringify({
        summary: "s",
        start: { dateTime: `${TODAY}T09:00:00`, timeZone: "Z", date: null },
        end: { dateTime: `${TODAY}T10:00:00`, timeZone: "Z", date: null },
        colorId: null,
      }),
      "exclusiveDates: 시간지정 → date null, 다른 키 순서 유지"
    );
    eq(
      JSON.stringify(I.exclusiveDates(engine, { start: { date: TODAY, dateTime: null } })),
      JSON.stringify({ start: { date: TODAY, dateTime: null, timeZone: null } }),
      "exclusiveDates: end 없음 · dateTime null 은 종일로"
    );
    eq(
      JSON.stringify(I.exclusiveDates(engine, { summary: "x" })),
      JSON.stringify({ summary: "x" }),
      "exclusiveDates: 날짜 없음 → 그대로"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6) 스탬프 코덱: privateProps · isOurs · recordFromEvent(Only) · eventStamp
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    eq(
      JSON.stringify(I.privateProps(engine, "A1", task("A1", false))),
      JSON.stringify(PROPS()),
      "privateProps: 키 순서 · tgsTime \"\" 명시 · tgsDoneAt 없음"
    );
    ok(
      Object.keys(I.privateProps(engine, "A1", task("A1", false))).includes("tgsTime"),
      "privateProps: 종일도 tgsTime 키가 있다"
    );
    eq(
      JSON.stringify(
        I.privateProps(engine, "X9", {
          ...task("A1", true, "2026-08-09"),
          start: "2026-08-07",
          time: "09:00-10:00",
          done: "2026-08-06",
          title: "회의 #gcal/Growth",
        })
      ),
      JSON.stringify({
        tgsTaskId: "X9",
        tgsSource: "tasks-gcal-sync",
        tgsVault: "vault",
        tgsDue: "2026-08-09",
        tgsStart: "2026-08-07",
        tgsTime: "",
        tgsDone: "1",
        tgsTitle: "회의",
        tgsDoneAt: "2026-08-06",
      }),
      "privateProps: 다중일(⏰ 무시) · 완료일 포함 · 라우팅 태그 제거"
    );
    eq(
      I.privateProps(engine, "A1", { ...task("A1", false), time: "09:00-10:00" }).tgsTime,
      "09:00-10:00",
      "privateProps: 하루짜리 시각"
    );

    eq(I.isOurs(engine, {}), true, "isOurs: 확장속성 없음 → true");
    eq(I.isOurs(engine, { extendedProperties: {} }), true, "isOurs: private 없음 → true");
    eq(
      I.isOurs(engine, { extendedProperties: { private: { tgsTaskId: "A1" } } }),
      true,
      "isOurs: tgsVault 없음 → true"
    );
    eq(
      I.isOurs(engine, { extendedProperties: { private: { tgsVault: "" } } }),
      true,
      "isOurs: tgsVault 빈 값 → true"
    );
    eq(
      I.isOurs(engine, { extendedProperties: { private: { tgsVault: "vault" } } }),
      true,
      "isOurs: 같은 볼트"
    );
    eq(
      I.isOurs(engine, { extendedProperties: { private: { tgsVault: "other" } } }),
      false,
      "isOurs: 다른 볼트 → false"
    );
    eq(
      I.isOurs(engine, { extendedProperties: { private: { tgsVault: "Vault" } } }),
      false,
      "isOurs: 대소문자 구분"
    );
  }
  {
    const { engine } = mk();
    const ev = doneEvent("A1", true, "200");
    eq(
      JSON.stringify(I.recordFromEvent(engine, ev, CAL, task("A1", false, "2026-08-20"))),
      JSON.stringify({
        eventId: "ev-A1",
        calendarId: CAL,
        due: TODAY,
        start: TODAY,
        time: "",
        done: true,
        title: "샘플",
        gcalUpdated: "200",
      }),
      "recordFromEvent: 스탬프 우선(tgsTime 없음 → task 시각 폴백)"
    );
    eq(
      JSON.stringify(
        I.recordFromEvent(
          engine,
          { id: "ev-X", summary: "☐ 다른" },
          "cal-2",
          { ...task("A1", true, "2026-08-20"), start: "2026-08-18", time: "09:00-10:00", title: "제목 #gcal/G" }
        )
      ),
      JSON.stringify({
        eventId: "ev-X",
        calendarId: "cal-2",
        due: "2026-08-20",
        start: "2026-08-18",
        time: "",
        done: true,
        title: "제목",
      }),
      "recordFromEvent: 스탬프 없음 → 전부 task 값(다중일이라 time \"\", updated 없음)"
    );
    const tev = timedEvent("T1", "2026-08-10");
    eq(
      JSON.stringify(I.recordFromEvent(engine, tev, CAL, task("T1", false))),
      JSON.stringify({
        eventId: "ev-T1",
        calendarId: CAL,
        due: "2026-08-10",
        start: "2026-08-10",
        time: "09:00-11:00",
        done: false,
        title: "샘플",
        gcalUpdated: "100",
      }),
      "recordFromEvent: tgsTime 스탬프"
    );
    eq(
      I.recordFromEvent(
        engine,
        { id: "e", extendedProperties: { private: { tgsDone: "yes" } } },
        CAL,
        task("A1", true)
      ).done,
      false,
      "recordFromEvent: tgsDone 이 \"1\" 이 아니면 false(task 무시)"
    );

    eq(I.recordFromEventOnly(engine, { ...ev, id: undefined }, CAL), null, "recordFromEventOnly: id 없음 → null");
    eq(
      I.recordFromEventOnly(engine, { id: "e", extendedProperties: { private: { tgsTaskId: "A1" } } }, CAL),
      null,
      "recordFromEventOnly: tgsDue 없음 → null"
    );
    eq(I.recordFromEventOnly(engine, { id: "e" }, CAL), null, "recordFromEventOnly: 확장속성 없음 → null");
    eq(
      JSON.stringify(I.recordFromEventOnly(engine, ev, CAL)),
      JSON.stringify({
        eventId: "ev-A1",
        calendarId: CAL,
        due: TODAY,
        start: TODAY,
        time: "",
        done: true,
        title: "샘플",
        gcalUpdated: "200",
      }),
      "recordFromEventOnly: 스탬프 전부"
    );
    eq(
      JSON.stringify(
        I.recordFromEventOnly(
          engine,
          {
            id: "e",
            summary: "☑️ 🔁 제목에서",
            updated: "5",
            start: { dateTime: "2026-08-01T09:00:00" },
            end: { dateTime: "2026-08-01T10:00:00" },
            extendedProperties: { private: { tgsDue: "2026-08-02" } },
          },
          CAL
        )
      ),
      JSON.stringify({
        eventId: "e",
        calendarId: CAL,
        due: "2026-08-02",
        start: "2026-08-02",
        time: "",
        done: false,
        title: "제목에서",
        gcalUpdated: "5",
      }),
      "recordFromEventOnly: tgsDue 만 → start=due · 종일 · 미완료 · 제목은 summary 에서"
    );

    eq(I.eventStamp(engine, {}), undefined, "eventStamp: 확장속성 없음");
    eq(
      I.eventStamp(engine, { extendedProperties: { private: { tgsTaskId: "A1", tgsTitle: "t" } } }),
      undefined,
      "eventStamp: tgsDue 없음 → 통째로 undefined"
    );
    eq(
      I.eventStamp(engine, { extendedProperties: { private: { tgsDue: "" } } }),
      undefined,
      "eventStamp: tgsDue 빈 값 → undefined"
    );
    const s1 = I.eventStamp(engine, { extendedProperties: { private: { tgsDue: TODAY } } });
    eq(s1, { due: TODAY, start: TODAY }, "eventStamp: tgsDue 만 → start=due");
    eq(Object.keys(s1 as any), ["due", "start", "time", "title"], "eventStamp: time·title 키는 undefined 로 존재");
    eq(
      I.eventStamp(engine, tev),
      { due: "2026-08-10", start: "2026-08-10", time: "09:00-11:00", title: "샘플" },
      "eventStamp: 전부"
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7) 판정 입력: remoteView · localView · taskState · knownCalendarIds
  // ════════════════════════════════════════════════════════════════════════
  {
    const { engine } = mk();
    eq(I.remoteView(engine, undefined), undefined, "remoteView: 이벤트 없음");
    eq(
      JSON.stringify(I.remoteView(engine, doneEvent("A1", true, "200"))),
      JSON.stringify({
        updated: "200",
        due: TODAY,
        start: TODAY,
        time: "",
        title: "샘플",
        stamp: { due: TODAY, start: TODAY, title: "샘플" },
      }),
      "remoteView: 종일"
    );
    eq(
      JSON.stringify(I.remoteView(engine, timedEvent("T1", "2026-08-10", "13:00-14:30"))),
      JSON.stringify({
        updated: "100",
        due: "2026-08-10",
        start: "2026-08-10",
        time: "13:00-14:30",
        title: "샘플",
        stamp: { due: "2026-08-10", start: "2026-08-10", time: "13:00-14:30", title: "샘플" },
      }),
      "remoteView: 시간지정"
    );
    eq(
      JSON.stringify(
        I.remoteView(engine, {
          updated: "3",
          summary: "🔁 ☐ 반복",
          start: { date: "2026-08-04" },
          end: { date: "2026-08-07" },
        })
      ),
      JSON.stringify({ updated: "3", due: TODAY, start: "2026-08-04", time: "", title: "반복" }),
      "remoteView: 다중일 종일 · 스탬프 없음"
    );
    const nodates = I.remoteView(engine, { updated: "4", summary: "x" }) as any;
    eq(
      Object.keys(nodates),
      ["updated", "due", "start", "time", "title", "stamp"],
      "remoteView: 날짜 없음도 키는 모두 있다"
    );
    eq(
      [nodates.due, nodates.start, nodates.time, nodates.stamp, nodates.title],
      [undefined, undefined, undefined, undefined, "x"],
      "remoteView: 날짜 없음 → due/start/time undefined"
    );

    eq(
      JSON.stringify(I.localView(engine, task("A1", false))),
      JSON.stringify({
        due: TODAY,
        start: TODAY,
        time: "",
        done: false,
        title: "샘플",
        hasStart: false,
        multiDay: false,
      }),
      "localView: 기본"
    );
    eq(
      JSON.stringify(
        I.localView(engine, {
          ...task("A1", true, "2026-08-09"),
          start: "2026-08-07",
          time: "09:00-10:00",
          title: "a #gcal/B",
        })
      ),
      JSON.stringify({
        due: "2026-08-09",
        start: "2026-08-07",
        time: "",
        done: true,
        title: "a",
        hasStart: true,
        multiDay: true,
      }),
      "localView: 다중일"
    );
    eq(
      JSON.stringify(I.localView(engine, { ...task("A1", false), start: "2026-08-09", time: "09:00-10:00" })),
      JSON.stringify({
        due: TODAY,
        start: TODAY,
        time: "09:00-10:00",
        done: false,
        title: "샘플",
        hasStart: true,
        multiDay: false,
      }),
      "localView: 🛫>📅 → hasStart 이지만 하루짜리"
    );

    eq(I.taskState(engine, undefined), { kind: "missing" }, "taskState: 없음");
    eq(I.taskState(engine, { ...task("A1", false), due: undefined }), { kind: "due-invalid" }, "taskState: 📅 없음");
    eq(I.taskState(engine, task("A1", false, "2026-02-31")), { kind: "due-invalid" }, "taskState: 없는 날짜");
    eq(I.taskState(engine, task("A1", false, "2026-8-6")), { kind: "due-invalid" }, "taskState: 형식 오류");
    eq(
      JSON.stringify(I.taskState(engine, task("A1", false))),
      JSON.stringify({ kind: "ok", local: I.localView(engine, task("A1", false)) }),
      "taskState: ok → local"
    );
  }
  {
    const h = harness({
      tasks: [],
      events: [],
      records: {
        B: { eventId: "e", calendarId: "cal-r", due: TODAY, done: false, title: "" },
        C: { eventId: "e", calendarId: CAL, due: TODAY, done: false, title: "" },
        D: { eventId: "e", calendarId: "", due: TODAY, done: false, title: "" },
      },
      settings: {
        rules: [
          { tag: "G", calendarId: "cal-g", calendarName: "G" },
          { tag: "H", calendarId: "", calendarName: "H" },
          { tag: "I", calendarId: "cal-r", calendarName: "I" },
        ],
      },
    });
    eq(I.knownCalendarIds(h.engine), [CAL, "cal-g", "cal-r"], "knownCalendarIds: 기본 → 규칙 → record, 중복·빈 값 제외");
    eq(I.knownCalendarIds(mk({ defaultCalendarId: "" }).engine), [], "knownCalendarIds: 아무것도 없음");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 8) 설정은 **참조**다 — 생성 뒤 바꾼 값이 곧바로 보인다
  // ════════════════════════════════════════════════════════════════════════
  {
    const h = mk();
    const t = task("A1", true);
    eq(I.summary(h.engine, t), "☑️ 샘플", "설정 참조: 변경 전");
    h.settings.donePrefix = "✅";
    h.settings.doneColorId = "";
    h.settings.deepLink = "off";
    eq(I.summary(h.engine, t), "✅ 샘플", "설정 참조: donePrefix 변경이 반영된다");
    eq(I.gcalTitleBase(h.engine, { summary: "✅ 샘플" }), "샘플", "설정 참조: 떼는 쪽도 새 값");
    eq(I.gcalTitleBase(h.engine, { summary: "☑️ 샘플" }), "☑️ 샘플", "설정 참조: 옛 값은 더는 안 뗀다");
    eq(I.doneColor(h.engine, t), undefined, "설정 참조: doneColorId 변경");
    eq(I.noteBlock(h.engine, "A1", t), BLOCK, "설정 참조: deepLink 변경");
    h.settings.defaultCalendarId = "cal-new";
    eq(I.knownCalendarIds(h.engine), ["cal-new"], "설정 참조: defaultCalendarId 변경");
  }

  done();
})();
