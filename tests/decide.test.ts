/**
 * 조정 판단(decideReconcile)의 결정표.
 *
 * reconcile.test.ts가 엔진 전체를 스텁으로 돌려 "실제로 무엇이 호출됐나"를 보는 반면,
 * 여기서는 순수 함수에 값만 넣어 **가드 × 필드 조합**을 촘촘히 본다. I/O가 없으니
 * 새 규칙을 넣을 때 어느 경로가 영향받는지 표로 확인할 수 있다 — 이게 분리한 이유다.
 */
import {
  DecideInput,
  Guards,
  LocalView,
  MergePlan,
  RemoteView,
  ReconcilePlan,
  decideReconcile,
  destructiveAllowed,
  conflictResolutionAllowed,
} from "../src/sync/reconcile";
import { SyncRecord } from "../src/sync/StateStore";

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

const DAY = "2026-08-06";
const NOW = 1_800_000_000_000;
const HOLD = 60_000;
const CRETRY = 15_000;

const rec = (o: Partial<SyncRecord> = {}): SyncRecord => ({
  eventId: "ev-1",
  calendarId: "cal-1",
  due: DAY,
  start: DAY,
  done: false,
  title: "샘플",
  gcalUpdated: "100",
  ...o,
});

const local = (o: Partial<LocalView> = {}): LocalView => ({
  due: DAY,
  start: DAY,
  time: "",
  done: false,
  title: "샘플",
  hasStart: false,
  multiDay: false,
  ...o,
});

/** 기본 원격은 "우리가 마지막으로 본 그대로"(updated가 rec와 같음 → 외부 수정 없음). */
const remote = (o: Partial<RemoteView> = {}): RemoteView => ({
  updated: "100",
  due: DAY,
  start: DAY,
  time: "",
  title: "샘플",
  ...o,
});

const guards = (o: Partial<Guards> = {}): Guards => ({
  duplicateId: false,
  adopted: false,
  holdWrites: false,
  vaultUnsettled: false,
  coldHold: false,
  ...o,
});

function decide(o: Partial<DecideInput> = {}): ReconcilePlan {
  return decideReconcile({
    rec: rec(),
    task: { kind: "ok", local: local() },
    remote: remote(),
    evCancelled: false,
    guards: guards(),
    now: NOW,
    uncheckHoldMs: HOLD,
    conflictRetryMs: CRETRY,
    ...o,
  } as DecideInput);
}

const merge = (o: Partial<DecideInput> = {}): MergePlan =>
  decide(o) as MergePlan;

// ── 파괴적 동작 가드: 셋 중 하나라도 서 있으면 막힌다 ──
{
  eq(destructiveAllowed(guards()), true, "가드 없음 → 허용");
  for (const k of ["holdWrites", "coldHold", "adopted", "vaultUnsettled"] as const) {
    eq(destructiveAllowed(guards({ [k]: true })), false, `${k} → 차단`);
  }
  // ★ 2026-09-07 회귀선. 그날 삭제가 통과한 조건이 정확히 이것이다 —
  //   뒤처짐 판정은 순간적으로 false(=holdWrites false)였고, 그 2초 틈에 이벤트가 지워졌다.
  //   정착 시계가 없으면 여기서 true 가 돌아온다.
  eq(
    destructiveAllowed(guards({ holdWrites: false, vaultUnsettled: true })),
    false,
    "뒤처짐 구간 사이의 순간 틈으로는 삭제가 열리지 않는다 ★"
  );
}

// ── 진입 순서: 🆔 중복이 가장 먼저 (삭제 경로로 새면 안 된다) ──
{
  eq(
    decide({ task: { kind: "missing" }, guards: guards({ duplicateId: true }) }),
    { kind: "skip", reason: "duplicate-id" },
    "🆔 중복은 task 없음보다 먼저 막힌다"
  );
}

// ── task 없음 / due 유실: 같은 3종 가드가 걸린다 ──
{
  const cases: [string, Partial<DecideInput>, ReconcilePlan][] = [
    [
      "task 없음 → 이벤트 삭제",
      { task: { kind: "missing" } },
      { kind: "delete-event", reason: "task-gone" },
    ],
    [
      "due 유실 → 이벤트 삭제",
      { task: { kind: "due-invalid" } },
      { kind: "delete-event", reason: "due-invalid" },
    ],
  ];
  for (const [msg, input, expected] of cases) {
    eq(decide(input), expected, msg);
    for (const k of ["holdWrites", "coldHold", "adopted"] as const) {
      const plan = decide({ ...input, guards: guards({ [k]: true }) });
      eq(plan.kind, "skip", `${msg} — ${k}면 보류`);
    }
  }
}

// ── GCal에서 이벤트가 지워짐 ──
{
  eq(
    decide({ evCancelled: true, task: { kind: "ok", local: local({ done: true }) } }),
    { kind: "drop-record" },
    "완료 줄: 📅는 기록이므로 record만 정리"
  );
  eq(
    decide({ evCancelled: true }),
    { kind: "unschedule" },
    "미완료 줄: 미일정화"
  );
  eq(
    decide({ evCancelled: true, guards: guards({ adopted: true }) }),
    { kind: "skip", reason: "hold-unschedule" },
    "입양 직후엔 미일정화도 보류"
  );
}

// ── 한쪽만 바뀐 경우 ──
{
  const localOnly = merge({ task: { kind: "ok", local: local({ due: "2026-08-09" }) } });
  eq(localOnly.pull, {}, "로컬만 변경: pull 없음");
  eq(localOnly.pushNeeded, true, "로컬만 변경: push");
  eq(localOnly.conflicts, [], "로컬만 변경: 충돌 아님");

  const gcalOnly = merge({ remote: remote({ updated: "200", due: "2026-08-09", start: "2026-08-09" }) });
  eq(gcalOnly.pull.setDue, "2026-08-09", "GCal만 변경: 노트에 반영");
  eq(gcalOnly.pushNeeded, false, "GCal만 변경: push 불필요");
  eq(gcalOnly.normalizeIfPulled, true, "GCal만 변경: 이벤트 표현은 다시 찍는다");
  eq(gcalOnly.merged.due, "2026-08-09", "GCal만 변경: 스냅샷은 GCal 값");
}

// ── 같은 필드가 양쪽 다 → GCal 채택. 다른 필드면 둘 다 살아남는다 ──
{
  const clash = merge({
    task: { kind: "ok", local: local({ due: "2026-08-10" }) },
    remote: remote({ updated: "200", due: "2026-08-09", start: "2026-08-09" }),
  });
  eq(clash.conflicts, ["due"], "같은 필드 충돌 기록");
  eq(clash.pull.setDue, undefined, "충돌 시 노트 채택 → pull하지 않는다");
  eq(clash.pushNeeded, true, "충돌 필드는 노트 값으로 push된다");
  eq(clash.merged.due, "2026-08-10", "병합 결과는 노트 값");
  eq(clash.remote.due, "2026-08-09", "버려진 GCal 값은 remote에 남는다(로그용)");
  // 날짜 둘은 한 구간이다 — due가 노트로 결정났으면 start만 GCal에서 끌어오지 않는다.
  // 안 그러면 하루짜리 task에 🛫가 붙어 여러 날 span이 된다.
  eq(clash.pull.start, undefined, "날짜 충돌이면 start도 노트 값으로 둔다");
  eq(clash.merged.start, DAY, "start는 노트 값 유지");

  const split = merge({
    task: { kind: "ok", local: local({ done: true }) },
    remote: remote({ updated: "200", due: "2026-08-09", start: "2026-08-09" }),
  });
  eq(split.pull.setDue, "2026-08-09", "겹치지 않는 변경: GCal 날짜 반영");
  eq(split.pushNeeded, true, "겹치지 않는 변경: 로컬 완료는 그대로 올라간다");
  eq(split.conflicts, [], "겹치지 않으면 충돌 아님");
}

// ── 이벤트에서 날짜를 못 읽으면 날짜 계열은 아예 손대지 않는다 ──
{
  const p = merge({
    remote: remote({ updated: "200", due: undefined, start: undefined, title: "새 제목" }),
  });
  eq(p.pull.setDue, undefined, "날짜 파싱 실패: due 안 건드림");
  eq(p.pull.start, undefined, "날짜 파싱 실패: start 안 건드림");
  eq(p.pull.title?.to, "새 제목", "날짜 파싱 실패해도 제목은 반영");
}

// ── 🛫 처리: 단일일로 바뀌면 🛫가 있을 때만 제거 ──
{
  const shrink = merge({
    rec: rec({ start: "2026-08-04" }),
    task: { kind: "ok", local: local({ start: "2026-08-04", hasStart: true }) },
    remote: remote({ updated: "200" }),
  });
  eq(shrink.pull.start, { value: DAY, write: "remove" }, "🛫 있음 → 제거");

  const noStart = merge({
    rec: rec({ start: "2026-08-04" }),
    task: { kind: "ok", local: local({ start: "2026-08-04", hasStart: false }) },
    remote: remote({ updated: "200" }),
  });
  eq(noStart.pull.start?.write, "none", "🛫 없음 → 줄은 안 건드리고 값만 채택");

  const grow = merge({
    remote: remote({ updated: "200", start: "2026-08-04" }),
  });
  eq(grow.pull.start, { value: "2026-08-04", write: "set" }, "다중일로 늘면 🛫 기록");
}

// ── 완료는 GCal에서 가져오지 않는다(노트가 소유) ──
{
  // 이벤트가 완료색·☑️로 바뀌어도 노트는 건드리지 않는다.
  const p = merge({ remote: remote({ updated: "200", title: "샘플" }) });
  eq(p.pull, {}, "이벤트가 완료로 보여도 노트에 쓰지 않는다");
  eq(p.pulledFields, [], "완료는 pull 대상이 아니다");

  // 반대 방향(노트 → 이벤트)은 그대로다.
  const up = merge({
    task: { kind: "ok", local: local({ done: true }) },
    remote: remote({ updated: "200" }),
  });
  eq(up.pushNeeded, true, "노트 완료는 push");
  eq(up.conflicts, [], "완료는 충돌 대상이 아니다");
}

// ── done 회귀 보류 ──
{
  const first = merge({ rec: rec({ done: true }), remote: undefined });
  eq(first.holdDone, true, "읽었어도 첫 관측은 한 사이클 보류");
  eq(first.uncheckSeen, "set", "관측 시각 기록");
  eq(first.retryAfterMs, HOLD + 2_000, "보류가 풀리는 시점을 알린다");
  eq(first.merged.done, true, "보류 중엔 스냅샷을 안 내린다");
  eq(first.pushNeeded, false, "보류 중엔 push하지 않는다");

  const after = merge({
    rec: rec({ done: true, uncheckSeenAt: NOW - HOLD - 1 }),
    remote: undefined,
  });
  eq(after.holdDone, false, "대기가 지나면 보류 해제");
  eq(after.pushNeeded, true, "해제 후 push");
  eq(after.merged.done, false, "해제 후 스냅샷도 미완료");

  const cleared = merge({ rec: rec({ uncheckSeenAt: NOW - 1000 }), remote: undefined });
  eq(cleared.uncheckSeen, "clear", "회귀가 아니게 되면 시계를 지운다");
}

// ── 완료 방향(미완료 → 완료)은 보류 대상이 아니다 ──
{
  const p = merge({ task: { kind: "ok", local: local({ done: true }) }, remote: undefined });
  eq(p.holdDone, false, "완료 방향은 보류 없음");
  eq(p.pushNeeded, true, "완료는 즉시 push");
}

// ── ⏰ 타임블록: 날짜와 독립된 필드로 판정된다 ──
{
  const T = "14:00-15:00";

  // 노트에서 시각 지정 → push (GCal은 그대로)
  const obsOnly = merge({
    task: { kind: "ok", local: local({ time: T }) },
    remote: undefined,
  });
  eq(obsOnly.pushNeeded, true, "노트에 ⏰ 생김 → push");
  eq(obsOnly.merged.time, T, "스냅샷에 시각 반영");
  eq(obsOnly.pull.time, undefined, "pull 없음");

  // GCal에서 시각만 변경 → pull (due/start는 그대로)
  const gcOnly = merge({
    remote: remote({ updated: "200", time: T }),
  });
  eq(gcOnly.pull.time, { value: T }, "GCal 시각 변경 → 노트로 pull");
  eq(gcOnly.pulledFields, ["time"], "시각만 GCal이 가져감");
  eq(gcOnly.pushNeeded, false, "pull만 있으면 push 불필요");
  eq(gcOnly.merged.time, T, "병합 스냅샷은 GCal 값");

  // GCal에서 종일로 되돌림 → ⏰ 제거 지시("")
  const cleared = merge({
    rec: rec({ time: T }),
    task: { kind: "ok", local: local({ time: T }) },
    remote: remote({ updated: "200", time: "" }),
  });
  eq(cleared.pull.time, { value: "" }, "GCal이 종일로 → ⏰ 제거");
  eq(cleared.merged.time, "", "스냅샷도 종일");

  // 양쪽 다 바뀜 → GCal 채택 + 충돌 보고
  const conflict = merge({
    task: { kind: "ok", local: local({ time: "09:00-10:00" }) },
    remote: remote({ updated: "200", time: T }),
  });
  eq(conflict.conflicts, ["time"], "시각 충돌 보고");
  eq(conflict.pull.time, undefined, "시각 충돌도 노트 채택 → pull하지 않는다");
  eq(conflict.pushNeeded, true, "노트의 시각이 GCal로 올라간다");
  eq(conflict.merged.time, "09:00-10:00", "병합 결과는 노트 시각");
  eq(conflict.remote.time, T, "버려진 GCal 시각이 remote에 남는다");

  // 읽지 못한 이벤트(혼합형 등, time=undefined)는 손대지 않는다 —
  // 이걸 ""로 뭉개면 근거 없이 노트의 ⏰를 지운다.
  const unknown = merge({
    rec: rec({ time: T }),
    task: { kind: "ok", local: local({ time: T }) },
    remote: remote({ updated: "200", time: undefined }),
  });
  eq(unknown.pull.time, undefined, "time 판정 불가 → pull 없음");
  eq(unknown.pushNeeded, false, "판정 불가여도 push를 유발하지 않는다");

  // 0.4.5 이전 record엔 time 키가 없다 → 종일로 읽어야 한다(불필요한 push 방지)
  const legacy = merge({ rec: rec({ time: undefined }), remote: undefined });
  eq(legacy.pushNeeded, false, "구버전 record + 종일 노트 → 변경 없음");
}

// ── 값이 같으면 충돌이 아니다 (0.8.0~) ──
//
// 기기를 며칠 꺼두면 기준선만 뒤처진다. 그 상태로 켜면 노트도 GCal도 "기준선과 다르다"가
// 되지만 **둘의 값은 같다.** 예전엔 이걸 충돌로 세어 "노트 변경 폐기"를 찍고 같은 값을
// 노트에 다시 썼다(→ modify → 자동 push). 2026-09-07 실측: 충돌 127건 중 122건이 이것.
{
  const agreedPlan = merge({
    rec: rec({ due: "2026-08-06", start: "2026-08-06" }),
    task: { kind: "ok", local: local({ due: "2026-08-20", start: "2026-08-20" }) },
    remote: remote({ updated: "200", due: "2026-08-20", start: "2026-08-20" }),
  });
  eq(agreedPlan.conflicts, [], "값이 같으면 충돌이 아니다");
  eq(agreedPlan.agreed, ["due", "start"], "합의된 필드로 기록된다");
  eq(agreedPlan.pull.setDue, undefined, "합의: 노트에 다시 쓰지 않는다");
  eq(agreedPlan.pull.start, undefined, "합의: 🛫도 건드리지 않는다");
  eq(agreedPlan.pushNeeded, false, "합의: GCal에도 올리지 않는다");
  eq(agreedPlan.merged.due, "2026-08-20", "합의: 기준선만 그 값으로 앞당긴다");

  // 제목도 마찬가지 — 양쪽이 같은 제목으로 바뀌었으면 폐기할 것이 없다.
  const sameTitle = merge({
    task: { kind: "ok", local: local({ title: "새 제목" }) },
    remote: remote({ updated: "200", title: "새 제목" }),
  });
  eq(sameTitle.conflicts, [], "제목이 같으면 충돌 아님");
  eq(sameTitle.pull.title, undefined, "제목 합의: 노트에 다시 쓰지 않는다");
  eq(sameTitle.pushNeeded, false, "제목 합의: push도 없다");

  // 값이 **다르면** 그때는 진짜 충돌이다.
  const real = merge({
    task: { kind: "ok", local: local({ title: "노트 제목" }) },
    remote: remote({ updated: "200", title: "GCal 제목" }),
  });
  eq(real.conflicts, ["title"], "값이 다르면 진짜 충돌");
  eq(real.agreed, [], "진짜 충돌은 합의가 아니다");
  eq(real.pushNeeded, true, "진짜 충돌: 노트 제목이 올라간다");
}

// ── 진짜 충돌은 볼트가 정착한 뒤에만 해결한다 ──
//
// 노트 우선은 "스테일한 노트가 원격을 덮는" 경로를 연다. 그래서 콜드 스타트/볼트 뒤처짐
// 중에는 판정 자체를 미룬다 — 어느 쪽도 쓰지 않고 record를 통째로 건너뛴다.
{
  const clashing = {
    task: { kind: "ok" as const, local: local({ due: "2026-08-10" }) },
    remote: remote({ updated: "200", due: "2026-08-09", start: "2026-08-09" }),
  };

  for (const k of ["coldHold", "vaultUnsettled"] as const) {
    const held = decide({ ...clashing, guards: guards({ [k]: true }) });
    eq(held.kind, "skip", `${k} → 충돌 해결 보류`);
    if (held.kind === "skip") {
      eq(held.reason, "hold-conflict", `${k} → hold-conflict`);
      eq(held.fields, ["due"], `${k} → 갈린 필드를 남긴다`);
      eq(held.retryAfterMs, CRETRY, `${k} → 후속 run을 예약한다`);
      eq(held.local?.due, "2026-08-10", `${k} → 노트 값을 로그용으로 남긴다`);
      eq(held.remote?.due, "2026-08-09", `${k} → GCal 값을 로그용으로 남긴다`);
    }
  }

  // ★ fail-open 상한이 열려도 충돌 해결만은 계속 보류한다.
  //   holdWrites는 상한(10분)을 넘기면 false로 떨어진다. 그건 "충돌 아닌 변경까지 영영
  //   막지는 말자"는 뜻이지 "이제 노트를 믿어도 된다"는 뜻이 아니다.
  const failOpen = decide({
    ...clashing,
    guards: guards({ holdWrites: false, vaultUnsettled: true }),
  });
  eq(failOpen.kind, "skip", "fail-open 통과 중이어도 충돌은 보류 ★");

  // 반대로 뒤처짐이 풀렸으면 보류하지 않는다(가드가 기능을 죽이면 안 된다).
  const settled = merge({ ...clashing, guards: guards() });
  eq(settled.conflicts, ["due"], "정착 후에는 충돌을 해결한다");

  // 합의는 보류 중이어도 그대로 합의다 — 버려지는 값이 없으니 미룰 이유가 없다.
  const agreedWhileBehind = merge({
    task: { kind: "ok", local: local({ due: "2026-08-20", start: "2026-08-20" }) },
    remote: remote({ updated: "200", due: "2026-08-20", start: "2026-08-20" }),
    guards: guards({ coldHold: true, vaultUnsettled: true }),
  });
  eq(agreedWhileBehind.kind, "merge", "보류 중에도 합의는 그냥 합의");
  eq(agreedWhileBehind.agreed, ["due", "start"], "보류 중 합의도 기준선을 앞당긴다");
}

// ── 정착 전에는 삭제하지 않는다 (v0.8.1~) ──
//
// 2026-09-07: 갤탭에서 추가 → Windows 로 Sync → 사용자가 다른 md 로 잘라내기·붙여넣기
// → 편집이 Sync 경합으로 되돌아가 노트에서 줄이 사라짐 → 플러그인이 그 상태를 정확히
// 읽고 이벤트를 지웠다. 볼트가 40분째 따라잡는 중이었고, 삭제가 통과한 건 그 사이의
// 2초짜리 틈이었다.
{
  const gone = { task: { kind: "missing" as const } };
  eq(decide({ ...gone, guards: guards({ vaultUnsettled: true }) }),
     { kind: "skip", reason: "hold-task-gone" },
     "task 줄이 사라져도 정착 전이면 이벤트를 지우지 않는다 ★");
  eq(decide({ ...gone, guards: guards() }),
     { kind: "delete-event", reason: "task-gone" },
     "정착 후에는 정상적으로 지운다(가드가 기능을 죽이면 안 된다)");

  // 📅 유실과 미일정화도 같은 문 하나를 지난다.
  eq(decide({ task: { kind: "due-invalid" }, guards: guards({ vaultUnsettled: true }) }),
     { kind: "skip", reason: "hold-due-invalid" },
     "📅 유실도 정착 전이면 보류");
  eq(decide({ evCancelled: true, guards: guards({ vaultUnsettled: true }) }),
     { kind: "skip", reason: "hold-unschedule" },
     "이벤트 삭제 → 미일정화도 정착 전이면 보류");
}

// ── 충돌 해결 허용 조건표 ──
{
  eq(conflictResolutionAllowed(guards()), true, "가드 없음 → 해결 허용");
  eq(conflictResolutionAllowed(guards({ coldHold: true })), false, "콜드 스타트 → 보류");
  eq(conflictResolutionAllowed(guards({ vaultUnsettled: true })), false, "정착 전 → 보류");
  // holdWrites는 fail-open 상한이 반영된 값이라 이 판정의 근거가 아니다.
  eq(
    conflictResolutionAllowed(guards({ holdWrites: false, vaultUnsettled: true })),
    false,
    "fail-open 통과 중(holdWrites=false)이어도 정착 전이면 보류 ★"
  );
  eq(
    conflictResolutionAllowed(guards({ adopted: true })),
    true,
    "입양 여부는 충돌 해결과 무관(파괴적 동작 가드다)"
  );
}

// ── 원격 변경이 **사람의 GCal 편집**인가, **메아리**인가 (0.9.0~) ──
//
// 이벤트의 현재 값 vs 그 이벤트에 심긴 마지막 push 스냅샷(tgs*). 이 한 가지 대조가
// "충돌 시 누가 이기는가"를 통째로 결정한다 → RemoteView.stamp
//
// 이게 없던 0.8.0은 둘을 구분하지 못해 **무조건 노트**였다. 구분 없이 GCal을 채택하면
// 기준선만 뒤처진 기기에서 메아리가 노트의 최신 편집을 덮는다.
{
  const MOVED = "2026-08-20"; // GCal 쪽 값
  const NOTED = "2026-08-19"; // 노트 쪽 값

  // (1) 스탬프가 이벤트의 현재 값과 **같다** = 어느 기기가 올린 그대로 = 메아리
  const echo = merge({
    task: { kind: "ok", local: local({ due: NOTED, start: NOTED }) },
    remote: remote({
      updated: "200",
      due: MOVED,
      start: MOVED,
      stamp: { due: MOVED, start: MOVED, time: "", title: "샘플" },
    }),
  });
  eq(echo.conflicts, ["due", "start"], "메아리: 노트 채택");
  eq(echo.gcalWins, [], "메아리: GCal은 이기지 않는다");
  eq(echo.pull.setDue, undefined, "메아리: 노트에 쓰지 않는다");
  eq(echo.pushNeeded, true, "메아리: 노트 값을 올린다");

  // (2) 스탬프가 **옛 값** = 우리가 올린 뒤 사람이 캘린더에서 옮겼다
  const human = merge({
    task: { kind: "ok", local: local({ due: NOTED, start: NOTED }) },
    remote: remote({
      updated: "200",
      due: MOVED,
      start: MOVED,
      stamp: { due: DAY, start: DAY, time: "", title: "샘플" },
    }),
  });
  eq(human.gcalWins, ["due", "start"], "사람 편집: GCal 채택 ★");
  eq(human.conflicts, [], "사람 편집: 노트는 이기지 않는다");
  eq(human.pull.setDue, MOVED, "사람 편집: GCal 값을 노트에 쓴다 ★");
  eq(human.pushNeeded, false, "사람 편집: 노트 값을 되올리지 않는다 ★");
  eq(human.merged.due, MOVED, "사람 편집: 스냅샷도 GCal 값");

  // (3) ★ 스탬프가 **없는** 옛 이벤트 = 판정 불가. 사람 편집으로 치지 않는다.
  //     없는 키를 ""로 메우면 모든 메아리가 사람 편집으로 승격된다 → SyncEngine.eventStamp
  const unknown = merge({
    task: { kind: "ok", local: local({ due: NOTED, start: NOTED }) },
    remote: remote({ updated: "200", due: MOVED, start: MOVED }),
  });
  eq(unknown.gcalWins, [], "스탬프 없음: 사람 편집으로 치지 않는다 ★");
  eq(unknown.conflicts, ["due", "start"], "스탬프 없음: 노트 채택(0.8.0 동작 유지)");

  // (4) ★★ 날짜 둘은 **한 구간**이다 — 🛫만 사람이 옮겨도 📅까지 GCal 것으로 맞춘다.
  //     한쪽만 채택하면 아무도 정한 적 없는 구간이 만들어진다.
  const spanPair = merge({
    task: { kind: "ok", local: local({ due: NOTED, start: NOTED, hasStart: true }) },
    remote: remote({
      updated: "200",
      due: MOVED,
      start: "2026-08-18", // 사람이 🛫만 당겼다
      stamp: { due: MOVED, start: DAY, time: "", title: "샘플" }, // 📅는 메아리, 🛫만 사람
    }),
  });
  eq(spanPair.gcalWins.includes("due"), true, "구간: 📅도 GCal 것으로 ★");
  eq(spanPair.pull.setDue, MOVED, "구간: 📅를 노트에 쓴다");
  eq(spanPair.pull.start?.value, "2026-08-18", "구간: 🛫도 노트에 쓴다");
  eq(spanPair.pushNeeded, false, "구간: 노트 날짜를 되올리지 않는다 ★");

  // (5) 시각은 날짜와 **독립**으로 판정한다(GCal에서 시간만 드래그하는 게 가장 흔하다)
  const timeOnly = merge({
    rec: rec({ time: "09:00-10:00" }),
    task: { kind: "ok", local: local({ time: "13:00-14:00" }) },
    remote: remote({
      updated: "200",
      time: "15:00-16:00",
      stamp: { due: DAY, start: DAY, time: "09:00-10:00", title: "샘플" },
    }),
  });
  eq(timeOnly.gcalWins, ["time"], "시각: 사람이 GCal에서 옮겼다 → GCal 채택");
  eq(timeOnly.pull.time?.value, "15:00-16:00", "시각: GCal 값을 노트에 쓴다");
}

// ── 여러 날 span 에는 시각을 받지 않는다 (0.9.0~) ──
//
// push 쪽은 `taskTime()`이 이미 ""로 막고 있었지만 **pull 쪽에 관문이 없었다.** 그래서
// GCal에서 여러 날 이벤트에 시각을 주면 노트에 ⏰가 써지고 다음 push가 곧바로 종일로
// 되돌렸다 — 사용자에게는 "GCal에서 준 시각이 그냥 사라진다"로 보인다.
{
  const base = {
    rec: rec({ start: "2026-08-04" }),
    remote: remote({
      updated: "200",
      time: "09:00-11:00",
      stamp: { due: DAY, start: DAY, time: "", title: "샘플" },
    }),
  };
  const multi = merge({
    ...base,
    task: {
      kind: "ok",
      local: local({ start: "2026-08-04", hasStart: true, multiDay: true }),
    },
  });
  eq(multi.pull.time, undefined, "여러 날 span: 시각을 받지 않는다 ★");
  eq(multi.timeIgnoredMultiDay, true, "여러 날 span: 이유를 로그에 남긴다");

  // 하루짜리면 그대로 받는다 — 막는 것은 표현할 수 없는 경우뿐이다.
  const single = merge({
    ...base,
    task: {
      kind: "ok",
      local: local({ start: "2026-08-04", hasStart: true, multiDay: false }),
    },
  });
  eq(single.pull.time?.value, "09:00-11:00", "하루짜리: 시각을 받는다");
  eq(single.timeIgnoredMultiDay, false, "하루짜리: 무시한 것이 없다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
