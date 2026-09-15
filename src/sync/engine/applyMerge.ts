/**
 * 병합 한 건의 **실행** — 판단(reconcile.decideReconcile 의 MergePlan)을 받아 노트 쓰기 ·
 * GCal push · 스냅샷 갱신 · 로그 항목을 만든다. SyncEngine 에서 그대로 옮겼다(0.12.6).
 *
 * ⛔ 이 파일에서 지켜야 할 것 — 사고로 배운 순서다:
 *   1. pull 쓰기가 먼저다. writer 가 쓰기 뒤 task 를 갱신하므로 push 는 병합된 값을 올린다
 *   2. **올리지 못한 변경은 스냅샷에 적지 않는다**(모바일 읽기 전용의 linchpin)
 *   3. 412 는 실패가 아니라 정보다 — 스냅샷도 gcalUpdated 도 그대로 둔다
 *   4. 412 가 아닌 예외는 삼키지 않는다 — run 의 레코드별 catch 가 reconcile-error 로 센다
 */
import { Notice } from "obsidian";
import { CalendarClient, GCalEvent, PreconditionFailedError } from "../../gcal/CalendarClient";
import { VaultTask, taskWhere } from "../../data/TaskRepository";
import { PluginSettings, resolveCalendar } from "../../settings/Settings";
import { TaskWriter } from "../../write/TaskWriter";
import { SyncRecord } from "../StateStore";
import { Field, MergePlan, Snapshot } from "../reconcile";
import { CodecCtx } from "../codec/ctx";
import { buildEvent } from "../codec/payload";
import { titleBase } from "../codec/presentation";
import { assignSnapshot } from "../codec/stamp";
import { spanStart, taskTime } from "../codec/timeMapping";
import { EventPusher } from "./pusher";
import { calName, mergeEntry } from "./logText";
import { SyncResult, countSkip, mergeRetry } from "./result";
import { SKIP_TEXT } from "./skipText";

/** applyMerge 가 쓰는 바깥 것. SyncEngine 이 한 번 만들어 넘긴다 — 객체는 **공유 참조**다. */
export interface MergeDeps {
  settings: PluginSettings;
  codec: CodecCtx;
  client: CalendarClient;
  writer: TaskWriter;
  pusher: EventPusher;
}

/** 병합 한 건의 입력. */
export interface MergeInput {
  plan: MergePlan;
  id: string;
  rec: SyncRecord;
  task: VaultTask;
  ev?: GCalEvent;
  result: SyncResult;
  coldHold: boolean;
  /** 이 기기는 GCal 에 쓰지 않는다(모바일 읽기 전용). */
  remoteReadOnly: boolean;
}

/** 병합 결정을 실행한다: 노트에 pull 반영 → 필요하면 push → 스냅샷 갱신. */
export async function applyMerge(d: MergeDeps, c: MergeInput): Promise<void> {
  const { plan, id, rec, task } = c;
  const where = taskWhere(task);
  // rec은 아래에서 갱신된다 → 로그에 "무엇이 무엇으로" 바뀌었는지 적으려면
  // 직전 스냅샷을 먼저 떠 둔다. 이게 양쪽 변경을 판정한 기준값이기도 하다.
  const before = {
    due: rec.due,
    start: rec.start,
    time: rec.time,
    done: rec.done,
    title: rec.title,
  };
  const fromCalendar = rec.calendarId;

  // ── 1) pull: GCal이 이긴 필드만 노트에 반영 ──
  // writer가 쓰기 후 task의 파싱 필드까지 갱신하므로, 아래 push는 병합된 값을 올린다.
  const applied: Field[] = [];
  const p = plan.pull;
  if (p.setDue !== undefined) {
    await d.writer.setDue(task, p.setDue);
    applied.push("due");
  }
  if (p.start) {
    if (p.start.write === "set") await d.writer.setStart(task, p.start.value);
    else if (p.start.write === "remove") await d.writer.removeStart(task);
    applied.push("start");
  }
  if (p.time) {
    if (p.time.value) await d.writer.setTime(task, p.time.value);
    else await d.writer.removeTime(task);
    applied.push("time");
  }
  if (p.title) {
    try {
      await d.writer.replaceTitle(task, p.title.from, p.title.to);
      applied.push("title");
    } catch (e) {
      console.warn("[tasks-gcal-sync] 제목 pull skip:", id, e);
    }
  }
  if (plan.conflicts.length) {
    console.warn(
      `[tasks-gcal-sync] 충돌 → 노트 채택, GCal은 메아리 (${plan.conflicts.join(
        ", "
      )}):`,
      where
    );
  }
  if (plan.gcalWins.length) {
    console.warn(
      `[tasks-gcal-sync] 충돌 → GCal 채택, 사람이 캘린더에서 편집함 (${plan.gcalWins.join(
        ", "
      )}):`,
      where
    );
  }
  if (applied.length) {
    c.result.pulled++;
    // 방금 노트에 써넣은 줄을 기억해 둔다. 이게 곧바로 옛 값으로 되돌아가면 그건
    // 사용자 편집이 아니라 되돌림이다 → run 의 되돌림 방어
    rec.pulledLine = task.raw;
    rec.pulledAt = Date.now();
  }

  if (plan.uncheckSeen === "set") rec.uncheckSeenAt = Date.now();
  else if (plan.uncheckSeen === "clear") delete rec.uncheckSeenAt;
  // 충돌이 실제로 해결됐다(또는 애초에 없었다) → 보류 시계를 끈다.
  if (plan.conflictHeldClear) delete rec.conflictHeldAt;
  // 이 record 를 실제로 판정했다 = 원격을 봤다. 재조회 표시를 끈다.
  delete rec.recheckRemote;
  if (plan.holdDone) {
    console.log(`[tasks-gcal-sync] 완료 해제 → 다음 사이클에 재확인: ${id}`);
  }
  if (plan.retryAfterMs !== undefined) {
    mergeRetry(c.result, plan.retryAfterMs);
  }

  // ── 2) push: GCal이 가져가지 않은 Obsidian 변경, 또는 표현 정규화 ──
  const normalizeNeeded = plan.normalizeIfPulled && applied.length > 0;
  const canWriteRemote = !c.coldHold && !c.remoteReadOnly;

  const m: Snapshot = { ...plan.merged };
  // pull이 실패한 필드는 노트가 안 바뀌었으므로 스냅샷도 노트 현재값이다.
  for (const f of plan.pulledFields) {
    if (!applied.includes(f)) assignSnapshot(m, f, plan.local);
  }

  let pushed = false;
  let pushKind: "move" | "update" | "presentation" | null = null;
  let precondFailed = false;
  if ((plan.pushNeeded || normalizeNeeded) && canWriteRemote) {
    try {
    // done을 보류 중이면 완료 상태만 기존 값으로 고정해서 올린다 —
    // 안 그러면 날짜/제목 push에 미완료가 딸려가 보류가 무의미해진다.
    const pushTask = plan.holdDone ? { ...task, checked: rec.done } : task;
    m.due = task.due!;
    m.start = spanStart(task);
    m.time = taskTime(task);
    m.done = pushTask.checked;
    m.title = titleBase(task);

    const target = resolveCalendar(task.tags, d.settings);
    if (!plan.pushNeeded) {
      const updatedEv = await d.pusher.pushPresentation(rec, pushTask, id, c.ev);
      rec.gcalUpdated = updatedEv.updated;
      c.result.updated++;
      pushKind = "presentation";
    } else if (target && target.id !== rec.calendarId) {
      // 대상 캘린더 변경 → 이동
      try {
        await d.client.deleteEvent(rec.calendarId, rec.eventId);
      } catch (e) {
        console.warn("[tasks-gcal-sync] 이동 중 삭제 실패(무시):", e);
      }
      const newEv = await d.client.insertEvent(
        target.id,
        buildEvent(d.codec, pushTask, id)
      );
      rec.eventId = newEv.id!;
      rec.calendarId = target.id;
      rec.gcalUpdated = newEv.updated; // 우리 push의 updated 저장 → 다음 pull에서 self-echo 제외
      c.result.moved++;
      pushKind = "move";
    } else {
      const updatedEv = await d.pusher.pushUpdate(
        rec,
        task,
        id,
        plan.holdDone ? rec.done : undefined,
        c.ev
      );
      rec.gcalUpdated = updatedEv.updated;
      c.result.updated++;
      pushKind = "update";
    }
    // 완료 해제가 실제로 GCal에 올라간 순간. 되돌리기 힘든 방향이라 조용히 넘기지 않는다 —
    // 노트에서 실수로 풀린 걸 이틀 뒤에 발견한 사고가 있었다(2026-08-09 CISS).
    if (rec.done && !pushTask.checked) {
      new Notice(`GCal 완료 해제: ${titleBase(task)}`, 8000);
      console.warn(`[tasks-gcal-sync] 완료 해제를 GCal에 반영: ${id} ${where}`);
    }
    pushed = true;
    } catch (e) {
      // **412 는 실패가 아니라 정보다.** pull 이후 사람이 캘린더를 또 고쳤다는 뜻이고,
      // 지금 우리가 든 값은 그 변경을 못 본 값이다. 덮지 않고 물러난다 — 스냅샷도
      // `rec.gcalUpdated` 도 그대로라 다음 run 이 새 상태로 처음부터 다시 판정한다.
      if (!(e instanceof PreconditionFailedError)) throw e;
      precondFailed = true;
      console.warn(
        `[tasks-gcal-sync] push 포기(412, pull 이후 GCal이 또 바뀜): ${id} ${where}`
      );
      countSkip(c.result, "push-precondition");
      c.result.entries.push({
        action: "SKIP",
        id,
        title: rec.title,
        calendar: calName(d.settings, rec.calendarId),
        eventId: rec.eventId,
        where,
        detail: SKIP_TEXT["push-precondition"],
      });
    }
  } else if (plan.gcalChanged) {
    // push하지 않았으면 GCal의 현재 updated가 다음 비교 기준.
    rec.gcalUpdated = c.ev!.updated;
  }

  // ── 3) 스냅샷 갱신 ──
  // **올리지 못한 변경은 스냅샷에 기록하지 않는다.** 여기서 덮으면 "이미 반영됨"으로
  // 남아 그 변경이 영영 안 올라간다(보류·콜드 스타트·구조 변경 스킵).
  if (pushed || (!plan.pushNeeded && !normalizeNeeded)) {
    rec.due = m.due;
    rec.start = m.start;
    rec.time = m.time;
    rec.done = m.done;
    rec.title = m.title;
  } else if (plan.pushNeeded) {
    // 부분 반영: pull이 실제로 고친 필드만 기록한다.
    for (const f of applied) assignSnapshot(rec, f, m);
  }
  // normalizeNeeded인데 못 찍었으면 스냅샷을 그대로 둔다 →
  // 다음 사이클에 "로컬이 바뀐 것"으로 읽혀 push되고, 그때 표현이 맞춰진다.

  const entry = mergeEntry(d.settings, {
    plan,
    id,
    rec,
    task,
    before,
    fromCalendar,
    applied,
    pushKind,
    blockedByCold: (plan.pushNeeded || normalizeNeeded) && !canWriteRemote,
    precondFailed,
    ev: c.ev,
    where,
  });
  if (entry) c.result.entries.push(entry);
}
