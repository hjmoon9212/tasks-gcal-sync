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
  done: false,
  title: "샘플",
  hasStart: false,
  ...o,
});

/** 기본 원격은 "우리가 마지막으로 본 그대로"(updated가 rec와 같음 → 외부 수정 없음). */
const remote = (o: Partial<RemoteView> = {}): RemoteView => ({
  updated: "100",
  done: false,
  due: DAY,
  start: DAY,
  title: "샘플",
  ...o,
});

const guards = (o: Partial<Guards> = {}): Guards => ({
  duplicateId: false,
  fileDirty: false,
  adopted: false,
  holdWrites: false,
  coldHold: false,
  remotePulled: true,
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
  eq(
    decide({ guards: guards({ fileDirty: true }) }),
    { kind: "skip", reason: "file-dirty" },
    "구조 변경된 파일은 손대지 않는다"
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

// ── 가짜 기준선 복구: 원격이 안 바뀌었어도 노트를 되살린다. 단 원격엔 쓰지 않는다 ──
{
  const p = merge({
    rec: rec({ done: true, baselineTrusted: false }),
    remote: remote({ done: true }), // updated 동일 → gcalChanged=false
  });
  eq(p.staleUncheck, true, "기준선 불신 + 원격 완료 + 노트 미체크");
  eq(p.pull.done, true, "노트를 완료로 복구");
  eq(p.pushNeeded, false, "GCal push 없음");
  eq(
    p.normalizeIfPulled,
    false,
    "표현 정규화도 안 한다 — 원격이 안 바뀐 상태에서 쓰기 시작하면 0.3.13 보장이 깨진다"
  );
  eq(p.merged.done, true, "스냅샷은 완료 유지");

  const trusted = merge({ rec: rec({ done: true }), remote: remote({ done: true }) });
  eq(trusted.staleUncheck, false, "신뢰 기준선이면 복구 경로 아님");
}

// ── done 회귀 보류 ──
{
  const unknown = merge({
    rec: rec({ done: true }),
    remote: undefined,
    guards: guards({ remotePulled: false }),
  });
  eq(unknown.holdDone, true, "원격 미확인: 무기한 보류");
  eq(unknown.holdReason, "remote-unknown", "보류 사유");
  eq(unknown.retryAfterMs, undefined, "무기한 보류엔 재시도 예약 안 함");
  eq(unknown.uncheckSeen, undefined, "대기 시계는 아직 시작 안 함");

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

// ── 기준선 승격은 "이벤트를 실제로 봤을 때"만 ──
{
  eq(merge({ remote: undefined }).promoteBaseline, false, "이벤트를 못 봤으면 승격 안 함");
  eq(merge().promoteBaseline, true, "이벤트를 봤으면 승격");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
