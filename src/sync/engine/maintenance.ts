/**
 * 사람이 명령으로 부르는 일괄 작업 — 설명 백필 · 중복 이벤트 정리. SyncEngine 에서 그대로 옮겼다(0.12.7).
 */
import { CalendarClient, GCalEvent } from "../../gcal/CalendarClient";
import { TaskRepository } from "../../data/TaskRepository";
import { PluginSettings, resolveCalendar } from "../../settings/Settings";
import { PersistedState } from "../StateStore";
import { CodecCtx } from "../codec/ctx";
import { mergeDescription, titleBase } from "../codec/presentation";
import { isOurs, recordFromEvent } from "../codec/stamp";
import { spanStart } from "../codec/timeMapping";

export interface MaintenanceDeps {
  settings: PluginSettings;
  codec: CodecCtx;
  state: PersistedState;
  client: CalendarClient;
  repo: TaskRepository;
  saveState: () => Promise<void>;
}

/** 기존 모든 record의 이벤트 설명(note)에 🆔 ID를 일괄 기록. */
export async function backfillDescriptions(
  d: MaintenanceDeps
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const id of Object.keys(d.state.records)) {
    const rec = d.state.records[id];
    try {
      // 설명을 다시 쓰는 명령이므로 현재 값을 읽어 사용자 텍스트를 보존한다.
      const cur = await d.client.getEvent(rec.calendarId, rec.eventId);
      await d.client.patchEvent(rec.calendarId, rec.eventId, {
        description: mergeDescription(d.codec, cur.description ?? "", id),
      });
      ok++;
    } catch (e) {
      console.warn("[tasks-gcal-sync] 백필 실패:", id, e);
      fail++;
    }
  }
  return { ok, fail };
}

/**
 * 이미 생긴 중복 이벤트 일괄 정리.
 * 모든 task를 GCal에서 tgsTaskId로 조회 → 같은 id 이벤트가 2개↑면 정본 1개만 남기고 삭제.
 * 정본은 현재 record의 eventId(있으면), 없으면 첫 번째.
 */
export async function cleanupDuplicates(
  d: MaintenanceDeps
): Promise<{ removed: number; checked: number }> {
  const tasks = await d.repo.getTasks();
  let removed = 0;
  let checked = 0;
  for (const t of tasks) {
    if (!t.id || !t.due) continue;
    const target = resolveCalendar(t.tags, d.settings);
    if (!target) continue;
    let evs: GCalEvent[];
    try {
      // 다른 볼트의 이벤트는 "중복"이 아니다 — 지우면 남의 일정을 없앤다.
      evs = (await d.client.findByTaskId(target.id, t.id)).filter((e) =>
        isOurs(d.codec, e)
      );
    } catch (e) {
      console.warn("[tasks-gcal-sync] 중복 조회 실패:", t.id, e);
      continue;
    }
    checked++;
    if (evs.length <= 1) continue;
    const rec = d.state.records[t.id];
    const keepId =
      rec && evs.some((e) => e.id === rec.eventId) ? rec.eventId : evs[0].id!;
    const keepEv = evs.find((e) => e.id === keepId);
    for (const e of evs) {
      if (e.id === keepId) continue;
      try {
        await d.client.deleteEvent(target.id, e.id!);
        removed++;
      } catch (err) {
        console.warn("[tasks-gcal-sync] 중복 삭제 실패:", e.id, err);
      }
    }
    d.state.records[t.id] = keepEv
      ? recordFromEvent(keepEv, target.id, t)
      : {
          eventId: keepId,
          calendarId: target.id,
          due: t.due,
          start: spanStart(t),
          done: t.checked,
          title: titleBase(t),
          gcalUpdated: undefined,
        };
  }
  await d.saveState();
  return { removed, checked };
}
