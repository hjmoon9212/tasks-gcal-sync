/**
 * ---- 2) record 없는 새 task → 생성 ----
 *
 * 입양(다른 기기가 만든 이벤트 회수) → 보류(모바일 읽기 전용 · 정착 전 · 콜드 스타트 — **이 순서**) →
 * 새 🆔 발급 → 이벤트 생성. SyncEngine.run() 에서 그대로 옮겼다(0.12.7).
 */
import { isValidDate, genId } from "../../dates";
import { resolveCalendar } from "../../../settings/Settings";
import { taskWhere } from "../../../data/TaskRepository";
import { buildEvent } from "../../codec/payload";
import { titleBase } from "../../codec/presentation";
import { isOurs, recordFromEvent } from "../../codec/stamp";
import { spanStart, taskTime } from "../../codec/timeMapping";
import { addFailure, countSkip } from "../result";
import { SKIP_TEXT } from "../skipText";
import { errMsg } from "../../../util/errors";
import { RunContext } from "./context";

export async function createMissing(ctx: RunContext): Promise<void> {
  const { tasks, records, result, today, existingIds, dupIds } = ctx;
  const { remoteReadOnly, vaultUnsettled, coldHold } = ctx;
  for (const t of tasks) {
    if (!isValidDate(t.due)) continue; // due 없음/형식오류 → 스킵(잘못된 이벤트 생성 방지)
    if (t.id && dupIds.has(t.id)) continue; // 🆔 중복 노트 → 정본 불명, 손대지 않음
    if (t.id && records[t.id]) continue; // 이미 처리됨

    const target = resolveCalendar(t.tags, ctx.settings);
    if (!target) continue;
    // **완료된 task 에는 이벤트를 새로 만들지 않는다**(0.9.9).
    //
    // `drop-record`(GCal 에서 완료 회차 이벤트를 지웠을 때 매핑만 버리는 경로)의 전제가
    // *"완료 + 과거 due 는 여기서 걸러지므로 record 만 지워도 되살아나지 않는다"* 였는데,
    // 조건이 `t.due >= today` 라 **오늘·미래 마감의 완료 task 는 안 걸렸다.** 그래서
    // 오늘 완료한 일의 이벤트를 캘린더에서 지우면 같은 run 에서 곧바로 부활했다
    // (2026-09-10 실측: DROP 바로 다음 줄에 CREATE).
    //
    // 완료된 task 의 이벤트는 **기록**이다. 이미 있으면 회색+☑️ 로 유지하지만(조정 경로),
    // 없는 것을 새로 만들 이유는 없다 — 사람이 지웠으면 지운 것이다.
    const inWindow =
      !t.checked && (t.due >= today || ctx.settings.includeOverdue);
    if (!inWindow) continue;

    // task에 이미 🆔가 있는데 로컬 record가 없음 → 다른 기기가 이미 만든 이벤트일 수 있음.
    // GCal에서 tgsTaskId로 조회해 있으면 입양(record 복원), 중복은 삭제, 없을 때만 새로 생성.
    // → records(data.json)가 기기 간 늦게 동기화돼도 중복이 안 생김.
    if (t.id) {
      try {
        const existing = (
          await ctx.client.findByTaskId(target.id, t.id)
        ).filter((e) => isOurs(ctx.codec, e));
        if (existing.length > 0) {
          const [keep, ...dupes] = existing;
          // 이벤트에 심긴 스냅샷으로 복원 → 다음 sync에서 어느 쪽이 바뀌었는지 정확 판정.
          records[t.id] = recordFromEvent(keep, target.id, t);
          result.entries.push({
            action: "ADOPT",
            id: t.id,
            title: titleBase(t),
            calendar: target.name || target.id,
            eventId: keep.id,
            where: taskWhere(t),
            detail:
              "GCal에 이미 있던 이벤트를 매핑으로 회수(다른 기기가 만든 것) — " +
              "새로 만들지 않음",
          });
          for (const d of dupes) {
            try {
              await ctx.client.deleteEvent(target.id, d.id!);
              result.deleted++;
              result.entries.push({
                action: "DELETE",
                id: t.id,
                title: titleBase(t),
                calendar: target.name || target.id,
                eventId: d.id,
                where: taskWhere(t),
                detail: `같은 🆔의 중복 이벤트 정리 (정본 ${keep.id} 유지)`,
              });
            } catch (e) {
              console.warn("[tasks-gcal-sync] 중복 삭제 실패:", d.id, e);
              result.entries.push({
                action: "FAIL",
                id: t.id,
                calendar: target.name || target.id,
                eventId: d.id,
                detail: `중복 이벤트 삭제 실패: ${errMsg(e)}`,
              });
            }
          }
          continue;
        }
      } catch (e) {
        console.warn(
          "[tasks-gcal-sync] findByTaskId 실패(새로 생성 진행):",
          t.id,
          e
        );
        result.entries.push({
          action: "FAIL",
          id: t.id,
          title: titleBase(t),
          calendar: target.name || target.id,
          where: taskWhere(t),
          detail: `기존 이벤트 조회 실패 → 새로 생성 진행(중복 가능): ${errMsg(e)}`,
        });
      }
    }

    // 콜드 스타트에는 새 이벤트를 만들지 않는다. 노트가 아직 안 내려왔을 뿐인데
    // 만들면 다른 기기가 이미 만든 것과 겹치거나, 곧 사라질 task의 이벤트가 남는다.
    // 새 🆔 발급은 **노트에 쓰는** 동작이다. 볼트가 정착하기 전에 쓰면 사용자의 편집·
    // Sync 와 같은 파일을 두고 겹친다 — 2026-09-07 에 그 틈에서 쓴 🆔 가 그대로
    // 유실로 이어졌다. 이벤트만 만들고 🆔 를 못 쓰면 다음 run 이 또 만든다(중복).
    // ⛔ 수동 실행(리본·명령)은 **생성만** 연다(0.9.8).
    //
    // 사람이 노트를 고치는 동안 볼트는 계속 "따라잡는 중"이라 정착 30초가 잘 안 쌓인다
    // (2026-09-10 실측: 편집 중 run 의 약 60%가 보류). 그래서 새 task 를 적어도 캘린더에
    // 안 뜨는 구간이 길어진다.
    //
    // 생성은 위험의 크기가 다르다 — 최악이 **일시적 이벤트 중복**이고 전수 스캔이 하루
    // 안에 정리한다. 게다가 드리프트 가드가 "바뀐 줄에는 안 쓴다"를 이미 보장하고,
    // 실패하면 다음 run 이 재시도한다. **삭제·미일정화는 계속 막는다** — 그건 다른 기기가
    // 방금 만든 일정을 지우는 일이라 되돌리기 어렵다(destructiveAllowed 는 손대지 않았다).
    if (remoteReadOnly) {
      countSkip(result, "mobile-readonly");
      result.entries.push({
        action: "SKIP",
        id: t.id,
        title: titleBase(t),
        calendar: target.name || target.id,
        where: taskWhere(t),
        detail: SKIP_TEXT["mobile-readonly"],
      });
      continue;
    }
    if (vaultUnsettled && !ctx.force) {
      countSkip(result, "unsettled-create");
      result.entries.push({
        action: "HOLD",
        id: t.id,
        title: titleBase(t),
        calendar: target.name || target.id,
        where: taskWhere(t),
        detail: SKIP_TEXT["unsettled-create"],
      });
      continue;
    }
    if (coldHold) {
      countSkip(result, "cold-start-create");
      result.entries.push({
        action: "HOLD",
        id: t.id,
        title: titleBase(t),
        calendar: target.name || target.id,
        where: taskWhere(t),
        detail: SKIP_TEXT["cold-start-create"],
      });
      continue;
    }

    let id = t.id;
    const idWasNew = !id; // 로그용: 이번 run에서 🆔를 새로 부여했는가
    if (!id) {
      // 후보군에 records의 id도 넣는다. existingIds는 이번 run에 파싱된 task의 🆔뿐이라,
      // 파일이 아직 안 내려온 기기에서는 records에만 남은 id가 그대로 재발급될 수 있다.
      id = genId(new Set([...existingIds, ...Object.keys(records)]));
      try {
        await ctx.writer.ensureId(t, id);
      } catch (e) {
        console.warn("[tasks-gcal-sync] ensureId 실패, skip:", t.path, e);
        countSkip(result, "ensure-id-failed");
        addFailure(result, t.path, e);
        result.entries.push({
          action: "SKIP",
          title: titleBase(t),
          calendar: target.name || target.id,
          where: taskWhere(t),
          detail: `${SKIP_TEXT["ensure-id-failed"]}: ${errMsg(e)}`,
        });
        continue;
      }
      existingIds.add(id);
      t.id = id;
      if (records[id]) continue;
    }

    try {
      const ev = await ctx.client.insertEvent(
        target.id,
        buildEvent(ctx.codec, t, id)
      );
      records[id] = {
        eventId: ev.id!,
        calendarId: target.id,
        due: t.due,
        start: spanStart(t),
        // ⏰를 빠뜨리면 스냅샷이 "종일"로 남아, 바로 다음 run이 시간대를 바뀐 것으로
        // 읽고 불필요한 push를 한 번 더 한다(다른 복원 경로들은 이미 넣고 있다).
        time: taskTime(t),
        done: t.checked,
        title: titleBase(t),
        gcalUpdated: ev.updated,
      };
      result.created++;
      result.entries.push({
        action: "CREATE",
        id,
        title: titleBase(t),
        calendar: target.name || target.id,
        eventId: ev.id,
        where: taskWhere(t),
        detail:
          `due=${t.due}` +
          (spanStart(t) !== t.due ? ` start=${spanStart(t)}` : "") +
          (taskTime(t) ? ` time=${taskTime(t)}` : " (종일)") +
          (t.checked ? " done=완료" : "") +
          (idWasNew ? " · 🆔를 새로 부여해 노트에 기록" : ""),
      });
    } catch (e) {
      console.error("[tasks-gcal-sync] 생성 실패:", t.path, e);
      countSkip(result, "create-failed");
      addFailure(result, t.path, e);
      result.entries.push({
        action: "FAIL",
        id,
        title: titleBase(t),
        calendar: target.name || target.id,
        where: taskWhere(t),
        detail: `이벤트 생성 실패: ${errMsg(e)}`,
      });
    }
  }
}
