/**
 * GCal 로 보내는 이벤트 본문 — 새로 만들 때(buildEvent)와 표현만 고칠 때(presentationPatch).
 *
 * SyncEngine 에서 그대로 옮겼다(0.12.3). ⛔ patch 는 키 단위 병합이다 — **모르는 값은 키를
 * 아예 빼서**(description) 이벤트에 있던 것을 지키고, 지워야 할 표현은 null 로 명시한다.
 */
import { GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import { addDay } from "../dates";
import { CodecCtx } from "./ctx";
import { doneColor, mergeDescription, noteBlock, summary } from "./presentation";
import { privateProps } from "./stamp";
import { spanStart, timedDates } from "./timeMapping";

/**
 * 날짜를 뺀 "표현" patch — 제목(체크박스·반복 아이콘) · 설명 · 완료색 · free · 스냅샷.
 * pushUpdate와 아래 pushPresentation이 공유한다.
 */
export function presentationPatch(
  ctx: CodecCtx,
  id: string,
  t: VaultTask,
  ev?: GCalEvent
): Partial<GCalEvent> {
  const patch: Partial<GCalEvent> = {
    summary: summary(ctx, t),
    // 마지막 push 스냅샷을 이벤트에 갱신 기록(기기 간 상태 복원용).
    extendedProperties: { private: privateProps(ctx, id, t) },
  };
  // **현재 설명을 모르면 아예 안 보낸다.** patch 는 키 단위 병합이라 이 키를 빼면
  // 이벤트의 설명이 그대로 남는다 — 사용자가 적어 둔 메모를 날리느니 우리 블록이
  // 한 사이클 낡는 편이 낫다. 다음에 이벤트를 손에 쥐면 갱신된다.
  if (ev) patch.description = mergeDescription(ctx, ev.description ?? "", id, t);
  const color = doneColor(ctx, t);
  if (color !== undefined) patch.colorId = color; // 완료=완료색, 미완료=null(기본색 복귀)
  return patch;
}

export function buildEvent(ctx: CodecCtx, t: VaultTask, id: string): GCalEvent {
  const timed = timedDates(t);
  const ev: GCalEvent = {
    summary: summary(ctx, t),
    description: noteBlock(ctx, id, t),
    // ⏰ 가 있으면 시간지정, 없으면 종일. 🛫 start가 있으면 거기서부터(다중일)
    ...(timed ?? {
      start: { date: spanStart(t) },
      end: { date: addDay(t.due!) },
    }),
    extendedProperties: { private: privateProps(ctx, id, t) },
  };
  const color = doneColor(ctx, t);
  if (color !== undefined) ev.colorId = color;
  return ev;
}
