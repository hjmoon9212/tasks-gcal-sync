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
    ...o,
  } as DecideInput);
}

const merge = (o: Partial<DecideInput> = {}): MergePlan =>
  decide(o) as MergePlan;

// ── 파괴적 동작 가드: 셋 중 하나라도 서 있으면 막힌다 ──
{
  eq(destructiveAllowed(guards()), true, "가드 없음 → 허용");
  for (const k of ["holdWrites", "coldHold", "adopted"] as const) {
    eq(destructiveAllowed(guards({ [k]: true })), false, `${k} → 차단`);
  }
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
  eq(clash.pull.setDue, "2026-08-09", "충돌 시 GCal 채택");
  eq(clash.pushNeeded, false, "충돌 필드는 push하지 않는다");

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
  eq(conflict.pull.time, { value: T }, "충돌 시 GCal 채택");
  eq(conflict.pushNeeded, false, "GCal이 가져간 필드는 되돌려 쓰지 않는다");

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
