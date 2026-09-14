/**
 * 이벤트에 심는 `tgs*` 스냅샷과 record · 판단 입력(LocalView/RemoteView) 사이의 변환.
 *
 * SyncEngine 에서 그대로 옮겼다(0.12.3).
 * ⛔ `isOurs` 와 externalEvent 의 `isExternalEvent` 는 **계약이 정반대**다 — 섞어 쓰지 말 것.
 */
import { GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import { SyncRecord } from "../StateStore";
import { Field, LocalView, RemoteView, Snapshot, TaskState } from "../reconcile";
import { isValidDate } from "../dates";
import { CodecCtx } from "./ctx";
import { gcalTitleBase, titleBase } from "./presentation";
import { eventDueDate, eventStartDate, eventTimeRange, isMultiDay, spanStart, taskTime } from "./timeMapping";

/**
 * 이벤트에 심는 private 확장속성.
 *  - 식별용: tgsTaskId / tgsSource / tgsVault
 *  - 마지막 push 스냅샷: tgsDue / tgsStart / tgsDone / tgsTitle
 * 스냅샷을 이벤트에 함께 저장해 두면, 기기 간 data.json(records)이 유실/충돌해도
 * GCal에서 "마지막으로 동기화된 상태"를 그대로 복원할 수 있다(recordFromEvent).
 * patch 시에도 항상 전체 세트를 넣어 키 누락을 방지한다.
 */
export function privateProps(ctx: CodecCtx, id: string, t: VaultTask): Record<string, string> {
  const p: Record<string, string> = {
    tgsTaskId: id,
    tgsSource: "tasks-gcal-sync",
    tgsVault: ctx.vaultName(),
    tgsDue: t.due!,
    tgsStart: spanStart(t),
    // 종일이면 빈 문자열을 **명시적으로** 싣는다. patch는 키 단위 병합이라 키를 빼면
    // 이벤트에 직전 시각이 남아, 시간지정 → 종일로 되돌린 게 다음 판정에서 안 보인다.
    tgsTime: taskTime(t),
    tgsDone: t.checked ? "1" : "0",
    tgsTitle: titleBase(t),
  };
  // 완료일(✅)은 **있을 때만** 싣는다. patch는 키 단위로 병합되므로 이 키를 안 보내면
  // 이벤트엔 직전 완료일이 그대로 남는다 — 노트에서 체크가 풀려도 "언제 완료였는지"가
  // 남는 유일한 사본이다. 다시 체크하면 Tasks가 오늘 날짜를 쓰므로 원래 날짜는
  // 노트만으로는 복구되지 않는다(2026-08-09 CISS).
  if (t.done) p.tgsDoneAt = t.done;
  return p;
}

/**
 * 이 볼트가 만든 이벤트인가.
 *
 * 매핑키(tgsTaskId)는 볼트 안에서만 유일하다 — 볼트 두 개가 같은 캘린더를 쓰면
 * (`#gcal/` 라우팅은 태그 한 줄로 그렇게 된다) 남의 볼트 이벤트를 record로 입양하고,
 * 우리 볼트엔 대응 task가 없으므로 다음 사이클에 "task 없음 → 삭제"로 지워버린다.
 * tgsVault를 심어만 두고 아무도 읽지 않던 구멍(~0.3.15).
 *
 * tgsVault가 없는 옛 이벤트는 통과시킨다 — 다음 push에서 자연 backfill된다.
 */
export function isOurs(ctx: CodecCtx, ev: GCalEvent): boolean {
  const v = ev.extendedProperties?.private?.tgsVault;
  return !v || v === ctx.vaultName();
}

/**
 * GCal 이벤트에 심긴 스냅샷으로 record를 복원한다(구버전 이벤트엔 없으므로 현재 task값 폴백).
 * 기기 간 records 유실 시 "마지막 동기화 상태"를 되살려 잘못된 방향 판정을 막는다.
 */
export function recordFromEvent(
  ev: GCalEvent,
  calendarId: string,
  t: VaultTask
): SyncRecord {
  const p = ev.extendedProperties?.private ?? {};
  return {
    eventId: ev.id!,
    calendarId,
    due: p.tgsDue ?? t.due!,
    start: p.tgsStart ?? spanStart(t),
    time: p.tgsTime ?? taskTime(t),
    done: p.tgsDone != null ? p.tgsDone === "1" : t.checked,
    title: p.tgsTitle ?? titleBase(t),
    gcalUpdated: ev.updated,
  };
}

/**
 * task 없이 이벤트만으로 record 복원. 볼트에 대응 task가 없는 이벤트(삭제됐거나
 * 아직 동기화 안 된)도 record로 만들어야 조정 루프의 시야에 들어온다.
 * tgs* 스냅샷이 없는 옛 이벤트는 복원 불가 → null (backfill-ids로 채운 뒤 잡힌다).
 */
export function recordFromEventOnly(
  ctx: CodecCtx,
  ev: GCalEvent,
  calendarId: string
): SyncRecord | null {
  const p = ev.extendedProperties?.private ?? {};
  if (!ev.id || !p.tgsDue) return null;
  return {
    eventId: ev.id,
    calendarId,
    due: p.tgsDue,
    start: p.tgsStart ?? p.tgsDue,
    // 스냅샷(tgsTime)이 없는 옛 이벤트는 **종일로 본다.** 이벤트의 모양에서 읽으면,
    // GCal 에서 사람이 지정해 둔 시각이 "우리가 마지막에 올린 값" 으로 둔갑해
    // 노트에 ⏰ 가 없다는 이유로 다음 push 가 그 시각을 지운다. 실제로 시각이 바뀐
    // 이벤트라면 pull 경로(remote.time + gcalChanged)가 노트에 ⏰ 를 써 넣는다.
    time: p.tgsTime ?? "",
    done: p.tgsDone === "1",
    title: p.tgsTitle ?? gcalTitleBase(ctx, ev),
    gcalUpdated: ev.updated,
  };
}

/** 조정 판단에 넘길 노트 상태. due가 유효하지 않으면 별도 상태로 구분한다. */
export function taskState(task?: VaultTask): TaskState {
  if (!task) return { kind: "missing" };
  if (!isValidDate(task.due)) return { kind: "due-invalid" };
  return { kind: "ok", local: localView(task) };
}

export function localView(t: VaultTask): LocalView {
  return {
    due: t.due!,
    start: spanStart(t),
    time: taskTime(t),
    done: t.checked,
    title: titleBase(t),
    hasStart: !!t.start,
    multiDay: isMultiDay(t),
  };
}

/** 이벤트를 판단에 쓸 순수 값으로 환원. 설정 의존(완료 판정·제목 접두사)은 여기서 끝난다. */
export function remoteView(ctx: CodecCtx, ev?: GCalEvent): RemoteView | undefined {
  if (!ev) return undefined;
  const due = eventDueDate(ev); // 다중일 블록은 끝(배타적−1)
  return {
    updated: ev.updated,
    due,
    start: due ? eventStartDate(ev) ?? due : undefined,
    time: eventTimeRange(ev),
    title: gcalTitleBase(ctx, ev),
    stamp: eventStamp(ev),
  };
}

/**
 * 이벤트에 심긴 마지막 push 스냅샷(`tgs*`). **원격 변경이 사람의 GCal 편집인지
 * 메아리인지 가르는 유일한 근거**다 → RemoteView.stamp
 *
 * `tgsDue`가 없으면(우리가 올린 적 없는/아주 옛 이벤트) 통째로 undefined —
 * **판정 불가는 "사람이 편집했다"가 아니다.** 없는 키를 빈 문자열로 메우면 현재 값과
 * 무조건 달라 보여서 모든 메아리가 사람 편집으로 승격된다.
 */
export function eventStamp(ev: GCalEvent): RemoteView["stamp"] {
  const p = ev.extendedProperties?.private;
  if (!p?.tgsDue) return undefined;
  return {
    due: p.tgsDue,
    start: p.tgsStart ?? p.tgsDue,
    // 옛 이벤트는 이 키가 없다. "" 로 메우면 시각이 지정된 이벤트가 전부 사람 편집으로
    // 읽히므로 그대로 undefined 로 둬서 시각만 판정 불가로 남긴다.
    time: p.tgsTime,
    title: p.tgsTitle,
  };
}

/** 스냅샷 한 필드를 옮긴다. record(start가 optional)와 Snapshot 둘 다 대상이 된다. */
export function assignSnapshot(
  dst: {
    due: string;
    start?: string;
    time?: string;
    done: boolean;
    title: string;
  },
  f: Field,
  src: Snapshot
): void {
  if (f === "due") dst.due = src.due;
  else if (f === "start") dst.start = src.start;
  else if (f === "time") dst.time = src.time;
  else if (f === "done") dst.done = src.done;
  else dst.title = src.title;
}
