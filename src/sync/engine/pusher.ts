/**
 * 노트 변경을 GCal 이벤트에 올린다(PATCH). 날짜·표현 계산은 codec 이 하고 여기는 호출만 한다.
 * SyncEngine 에서 그대로 옮겼다(0.12.6). 모든 patch 는 **읽은 버전의 etag 로 조건부**다(If-Match → 412).
 */
import { CalendarClient, GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import { CodecCtx } from "../codec/ctx";
import { presentationPatch } from "../codec/payload";
import { DatesSnapshot, datePatch, datesChanged, exclusiveDates } from "../codec/timeMapping";

export class EventPusher {
  constructor(
    private readonly client: CalendarClient,
    private readonly codec: CodecCtx
  ) {}

  /**
   * 날짜는 건드리지 않고 표현만 다시 찍는다.
   *
   * GCal에서 날짜·제목을 고쳐 그쪽이 이긴 run에서는 push할 것이 없어 이벤트의 표현
   * (제목 접두사 ☐/☑️·완료색)이 낡은 채로 남는다. 제목으로 상태를 보는 모바일에서
   * 그게 그대로 드러나므로 한 번 더 찍는다. 날짜를 안 보내므로 GCal이 방금 정한
   * 일정을 되돌릴 위험이 없다.
   */
  pushPresentation(
    rec: { calendarId: string; eventId: string },
    task: VaultTask,
    id: string,
    ev?: GCalEvent
  ): Promise<GCalEvent> {
    return this.client.patchEvent(
      rec.calendarId,
      rec.eventId,
      presentationPatch(this.codec, id, task, ev),
      ev?.etag // 조건부: pull 이후 또 바뀌었으면 덮지 않고 412
    );
  }

  /**
   * Obsidian 변경분을 이벤트에 반영.
   *  - 제목/완료만 바뀌면 summary/description만 patch → 시간(타임블록) 보존.
   *  - 날짜가 바뀌면: 시간지정 이벤트는 시각 유지한 채 날짜만 이동, 종일이면 종일로(datePatch).
   */
  async pushUpdate(
    rec: DatesSnapshot & { calendarId: string; eventId: string },
    task: VaultTask,
    id: string,
    doneOverride?: boolean,
    ev?: GCalEvent
  ): Promise<GCalEvent> {
    // done 회귀를 보류한 채 다른 필드(날짜·제목)만 올리는 경우 — 완료 상태는 기존 값으로
    // 고정한다. 안 그러면 제목 push에 미완료가 딸려가 보류가 무의미해진다.
    const t = doneOverride === undefined ? task : { ...task, checked: doneOverride };
    let cur: GCalEvent | undefined = ev;
    let dates: Partial<GCalEvent> | undefined;
    if (datesChanged(rec, task)) {
      try {
        cur = await this.client.getEvent(rec.calendarId, rec.eventId);
      } catch (e) {
        console.warn("[tasks-gcal-sync] getEvent 실패(종일로 처리):", e);
      }
      dates = datePatch(rec, task, cur);
    }
    // 설명 병합은 현재 이벤트를 알아야 하므로 getEvent 뒤에 만든다.
    const patch = presentationPatch(this.codec, id, t, cur);
    if (dates) Object.assign(patch, exclusiveDates(dates));
    // 조건부 수정: 우리가 마지막으로 **읽은** 버전(getEvent를 탔으면 그쪽이 더 최신) 기준.
    // 그 사이 사람이 캘린더에서 고쳤으면 덮지 않고 412 → 이번 push 포기.
    return this.client.patchEvent(rec.calendarId, rec.eventId, patch, cur?.etag);
  }
}
