/**
 * ---- 1) 기존 record 양방향 조정 ----
 *
 * 판단은 전부 reconcile.ts 의 순수 함수(decideReconcile)가 한다. 여기서는 그 결정을 **실행만** 한다.
 * SyncEngine.run() 에서 그대로 옮겼다(0.12.7).
 */
import { taskWhere } from "../../../data/TaskRepository";
import { decideReconcile, RunGuards } from "../../reconcile";
import { remoteView, taskState } from "../../codec/stamp";
import { BEHIND_RECHECK_MS, CONFLICT_HOLD_MAX_MS, REVERT_WINDOW_MS, UNCHECK_HOLD_MS } from "../constants";
import { calName, fieldText, lastLineText } from "../logText";
import { addFailure, countSkip, mergeRetry } from "../result";
import { SKIP_TEXT } from "../skipText";
import { applyMerge } from "../applyMerge";
import { PullAll } from "../puller";
import { errMsg } from "../../../util/errors";
import { RunContext } from "./context";

export async function reconcileRecords(
  ctx: RunContext,
  pulled: PullAll,
  guards: RunGuards
): Promise<void> {
  const { records, result, tasksById, dupWhere, coldHold, remoteReadOnly } = ctx;
  const { pullByCal, pullFailedCals } = pulled;
  for (const id of Object.keys(records)) {
    const rec = records[id];

    // **읽지 못한 캘린더에는 쓰지 않는다.** pull 이 실패하면 그 캘린더의 이벤트는
    // `remote = undefined` 로 들어와 `gcalChanged = false` 가 되고, 그러면 노트 변경만
    // 참이라 **원격을 못 본 채로 push 가 나간다** — 그 사이 사람이 GCal 에서 고쳐 뒀다면
    // 그대로 덮인다. `vaultBehind` 에만 걸어 두었던 *"읽지 못할 때는 쓰지도 않는다"* 를
    // 캘린더 단위에도 적용한다. 다음 run 이 같은 상태를 다시 본다(스냅샷 무변경).
    if (pullFailedCals.has(rec.calendarId)) {
      countSkip(result, "pull-failed");
      result.entries.push({
        action: "SKIP",
        id,
        title: rec.title,
        calendar: calName(ctx.settings, rec.calendarId),
        eventId: rec.eventId,
        where: tasksById.get(id)
          ? taskWhere(tasksById.get(id)!)
          : undefined,
        detail: SKIP_TEXT["pull-failed"],
      });
      continue;
    }

    const task = tasksById.get(id);
    const calData = pullByCal.get(rec.calendarId);
    let ev = calData?.byTaskId.get(id);
    let evCancelled = calData?.cancelledEventIds.has(rec.eventId) ?? false;

    // ★★ **보류한 원격 관측은 다음 run 에 되살려야 한다**(0.9.4).
    //
    // `pullCalendar` 는 syncToken 증분이다. 이벤트를 한 번 받으면 토큰이 그 다음으로
    // 넘어가고, **다음 run 의 델타에는 그 이벤트가 없다.** 그래서 이번 run 이 보류하면
    // (충돌 해결 보류·미일정화 보류) 다음 run 은 `remote = undefined` 로 들어와
    // `gcalChanged = false` 가 되고 — "노트만 바뀜"으로 읽혀 **노트 값을 그냥 올린다.**
    //
    // 결과적으로 **보류한 충돌은 100% 노트 승으로 끝났다.** 2026-09-10 실측:
    //   16:36:20  HOLD ⚔️⏸ 충돌 해결 보류 — due(노트 09-11 / GCal 09-10)
    //   16:36:38  UPDATE ⬆ GCal 반영: 09-12→09-11        ← ⚔️ 가 사라졌다
    // "GCal 우선"으로 규칙을 바꿔도 이 경로 때문에 한 번도 적용되지 않았다.
    //
    // 보류할 때 `recheckRemote` 를 세워 두고, 델타에 없으면 **이벤트를 직접 조회한다.**
    // 보류 중인 record 만 해당하므로 호출 수는 자연히 몇 건으로 제한된다.
    if (calData && !ev && !evCancelled && rec.recheckRemote) {
      const seen = await ctx.puller.recheckRemote(rec, id);
      if (seen.cancelled) evCancelled = true;
      else if (seen.ev) ev = seen.ev;
    }

    // ── 되돌림 의심 관측 ──
    //
    // pull 이 노트에 써넣은 줄이 **짧은 시간 안에 사라지는** 일을 2026-09-10 에 두 번
    // 봤다(14초·4분). 되돌아간 값을 다음 run 이 "사용자 편집"으로 읽어 GCal 에 올리면
    // 되돌림이 원격까지 전파되므로, 사실이라면 GCal 기준이 무너지는 경로다.
    //
    // ⛔ **그런데 그게 되돌림인지 사용자 편집인지 지금 데이터로는 구분되지 않는다.**
    //    두 사례 모두 사람이 리본을 누르며 날짜를 돌려가며 테스트하던 중이었고, 버전
    //    기록도 "같은 기기"라 본인 편집과 완전히 일치한다.
    //
    // 0.9.6 은 여기서 줄을 **다시 썼는데**, 그러면 충돌 해결 직후의 진짜 편집을 한 번
    // 되돌려 버린다 — 근거가 없는 채로 사용자와 싸우는 쪽이 더 나쁘다. 0.9.7 부터는
    // **관측만 한다.** 같은 줄이 반복해서 나오고 그때 사용자가 "나는 안 건드렸다"면
    // 그때 되돌림으로 확정하고 다시 쓰면 된다.
    if (
      task &&
      rec.pulledLine !== undefined &&
      task.raw !== rec.pulledLine &&
      Date.now() - (rec.pulledAt ?? 0) < REVERT_WINDOW_MS &&
      (!ev || ev.updated === rec.gcalUpdated)
    ) {
      const sec = Math.round((Date.now() - (rec.pulledAt ?? 0)) / 1000);
      result.entries.push({
        action: "SKIP",
        id,
        title: rec.title,
        calendar: calName(ctx.settings, rec.calendarId),
        eventId: rec.eventId,
        where: taskWhere(task),
        detail:
          `※ 관측: ${sec}초 전 pull 로 쓴 줄이 달라졌다(GCal 은 그대로). ` +
          `사용자 편집이면 정상이고, 건드린 적이 없다면 되돌림이다 — ` +
          `쓴 줄 \`${rec.pulledLine}\` → 지금 \`${task.raw}\``,
      });
      console.warn(
        `[tasks-gcal-sync] pull 로 쓴 줄이 ${sec}초 만에 달라짐(되돌림 의심): ${id} ${taskWhere(task)}`
      );
      delete rec.pulledLine;
      delete rec.pulledAt;
      // **막지 않는다.** 아래 정상 판정으로 그대로 흘려보낸다.
    }

    // 줄이 보이는 동안 원문을 보관해 둔다. 지우는 시점에는 이미 노트에 없어서
    // "무엇을 지웠는지"를 로그에 남길 방법이 이것뿐이다.
    if (task) {
      rec.lastLine = task.raw;
      rec.lastWhere = taskWhere(task);
    }

    try {
      const plan = decideReconcile({
        rec,
        task: taskState(task),
        remote: remoteView(ctx.codec, ev),
        evCancelled,
        guards: guards.for(id),
        now: Date.now(),
        uncheckHoldMs: UNCHECK_HOLD_MS,
        conflictRetryMs: BEHIND_RECHECK_MS,
        // 사람이 누른 실행이면 충돌 보류를 우회한다 — "지금 맞춰라"가 곧 그 뜻이다.
        force: !!ctx.force,
        conflictHoldMaxMs: CONFLICT_HOLD_MAX_MS,
      });

      if (plan.kind === "merge") {
        await applyMerge(ctx.mergeDeps, {
          plan,
          id,
          rec,
          task: task!,
          ev,
          result,
          coldHold,
          remoteReadOnly,
        });
        continue;
      }

      const logWhere = task ? taskWhere(task) : undefined;
      switch (plan.kind) {
        case "skip": {
          countSkip(result, plan.reason);
          // 보류로 끝난 run은 그대로 두면 다음 주기(기본 5분)까지 방치된다.
          if (plan.retryAfterMs !== undefined) {
            mergeRetry(result, plan.retryAfterMs);
          }
          let detail = SKIP_TEXT[plan.reason];
          // 중복은 **어디에 있는지**가 곧 조치 방법이다. 콘솔에만 두면 재시작하면 사라진다.
          if (plan.reason === "duplicate-id" && dupWhere.has(id)) {
            detail = `${detail} — ${dupWhere.get(id)}`;
          }
          if (plan.reason === "hold-conflict" && plan.local && plan.remote) {
            const sec = Math.round((plan.retryAfterMs ?? 0) / 1000);
            const each = (plan.fields ?? [])
              .map(
                (f) =>
                  `${f}(노트 ${fieldText(plan.local!, f)} / GCal ${fieldText(
                    plan.remote!,
                    f
                  )})`
              )
              .join(", ");
            const held =
              rec.conflictHeldAt === undefined
                ? ""
                : ` · ${Math.round(
                    (Date.now() - rec.conflictHeldAt) / 1000
                  )}초째 보류(상한 ${CONFLICT_HOLD_MAX_MS / 60_000}분 · 리본으로 즉시 해결)`;
            detail = `⚔️⏸ ${detail} — ${each}, ${sec}초 뒤 재확인${held}`;
          }
          // 보류 시계는 **처음 미룬 시각**에 시작한다 → conflictResolutionAllowed 의 상한
          if (plan.conflictHeldSeen === "set") rec.conflictHeldAt = Date.now();
          // 원격 관측에 기대는 보류는 다음 run 에 그 관측을 되살려야 한다 — 증분 pull 은
          // 같은 이벤트를 두 번 주지 않는다. → 위 § 보류한 원격 관측
          if (plan.reason === "hold-conflict" || plan.reason === "hold-unschedule") {
            rec.recheckRemote = true;
          }
          result.entries.push({
            // 되돌아올 보류와 영영 손대지 않는 스킵은 사후 추적에서 다르게 읽힌다.
            action: plan.reason === "hold-conflict" ? "HOLD" : "SKIP",
            id,
            title: rec.title,
            calendar: calName(ctx.settings, rec.calendarId),
            eventId: rec.eventId,
            where: logWhere,
            detail,
          });
          break;
        }
        case "delete-event":
          await ctx.client.deleteEvent(rec.calendarId, rec.eventId);
          delete records[id];
          result.deleted++;
          result.entries.push({
            action: "DELETE",
            id,
            title: rec.title,
            calendar: calName(ctx.settings, rec.calendarId),
            eventId: rec.eventId,
            where: logWhere,
            detail:
              (plan.reason === "task-gone"
                ? `노트에서 task 줄이 사라짐 → 이벤트 삭제 (마지막 스냅샷 due=${rec.due}${
                    rec.time ? ` ${rec.time}` : ""
                  })`
                : `task는 있으나 📅가 없음 → 이벤트 삭제 (마지막 스냅샷 due=${rec.due})`) +
              lastLineText(rec),
          });
          break;
        case "drop-record":
          delete records[id];
          result.entries.push({
            action: "DROP",
            id,
            title: rec.title,
            calendar: calName(ctx.settings, rec.calendarId),
            eventId: rec.eventId,
            where: logWhere,
            detail:
              "GCal에서 이벤트가 삭제됨 + 완료된 줄 → 매핑만 폐기(📅는 기록이므로 유지)",
          });
          break;
        case "unschedule":
          await ctx.writer.unschedule(task!);
          delete records[id];
          result.pulled++;
          result.entries.push({
            action: "UNSCHEDULE",
            id,
            title: rec.title,
            calendar: calName(ctx.settings, rec.calendarId),
            eventId: rec.eventId,
            where: logWhere,
            detail: `GCal에서 이벤트가 삭제됨 → 노트의 📅 ${rec.due} · 🆔 ${id} 제거(미일정화)`,
          });
          break;
      }
    } catch (e) {
      console.error("[tasks-gcal-sync] reconcile 실패:", id, e);
      countSkip(result, "reconcile-error");
      addFailure(result, id, e);
      result.entries.push({
        action: "FAIL",
        id,
        title: rec.title,
        calendar: calName(ctx.settings, rec.calendarId),
        eventId: rec.eventId,
        where: task ? taskWhere(task) : undefined,
        detail: `조정 중 예외: ${errMsg(e)}`,
      });
    }
  }
}
