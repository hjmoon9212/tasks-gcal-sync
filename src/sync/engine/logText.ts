/**
 * 동기화 로그에 싣는 **문구**. 무엇을 남길지는 엔진이 정하고(SyncResult.entries), 파일에
 * 언제·어떻게 쓸지는 SyncLog 가 정한다 — 여기는 그 사이의 순수한 문자열 조립만 한다.
 *
 * SyncEngine 에서 그대로 옮겼다(0.12.4). ⛔ 문구는 **바이트 단위로** 사람이 읽고 검사 도구
 * (scripts/check-sync-log.mjs)가 읽는다 — 리팩토링에서 한 글자도 바꾸지 않는다.
 */
import { GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import { PluginSettings } from "../../settings/Settings";
import { SyncRecord } from "../StateStore";
import { SyncLogEntry } from "../SyncLog";
import { Field, MergePlan } from "../reconcile";

/** 스냅샷을 문구로 옮길 때 보는 필드. record · Snapshot · LocalView 모두 이 모양을 만족한다. */
export type SnapText = { due: string; start?: string; time?: string; done: boolean; title: string };

/** calendarId → 사람이 읽을 이름. 설정 캐시에 없으면 id 그대로. */
export function calName(settings: PluginSettings, calendarId: string): string {
  return (
    settings.calendars.find((c) => c.id === calendarId)?.name ??
    calendarId
  );
}

/** 스냅샷 한 필드를 로그에 적을 문자열로. 빈 값도 "없음"으로 보이게 한다. */
export function fieldText(
  s: SnapText,
  f: Field
): string {
  if (f === "due") return s.due || "(없음)";
  if (f === "start") return s.start ?? s.due;
  if (f === "time") return s.time || "(종일)";
  if (f === "done") return s.done ? "완료" : "미완료";
  return `"${s.title}"`;
}

/**
 * 되돌리기 위한 원문. 삭제·미일정화 기록에 붙인다.
 *
 * 로그의 존재 이유가 "되돌리기 힘든 일을 사후에 따라가는 것"인데, 정작 삭제 기록에
 * **무엇이 지워졌는지가 없었다.** 2026-09-07 에 편집·Sync 경합으로 노트에서 줄이
 * 사라졌을 때, 복구하려면 Obsidian 버전 기록을 뒤지는 수밖에 없었다. 이제 이 줄만
 * 복사해 노트에 붙이면 된다.
 */
export function lastLineText(rec: SyncRecord): string {
  if (!rec.lastLine) return "";
  const where = rec.lastWhere ? ` @${rec.lastWhere}` : "";
  return ` · 마지막으로 본 줄${where}: \`${rec.lastLine.trim()}\``;
}

/** `due 2026-08-14→2026-08-16` 형태로 필드별 변화를 나열. */
export function diffText(
  before: SnapText,
  after: SnapText,
  fields: Field[]
): string {
  return fields
    .map((f) => `${f} ${fieldText(before, f)}→${fieldText(after, f)}`)
    .join(", ");
}

/** before(직전 스냅샷) 대비 after에서 실제로 값이 달라진 필드만 추린다. */
export function changedFields(
  before: SnapText,
  after: SnapText,
  fields: readonly Field[] = ["due", "start", "time", "done", "title"]
): Field[] {
  return fields.filter(
    (f) => fieldText(before, f) !== fieldText(after, f)
  );
}

/** mergeEntry 의 입력 — applyMerge 가 병합 한 건을 실행한 뒤 넘긴다. */
export interface MergeLogInput {
  plan: MergePlan;
  id: string;
  rec: SyncRecord;
  task: VaultTask;
  before: SnapText;
  fromCalendar: string;
  applied: Field[];
  pushKind: "move" | "update" | "presentation" | null;
  blockedByCold: boolean;
  /** If-Match 412 로 push 를 포기했는가(0.9.0~). */
  precondFailed: boolean;
  /** 판정에 쓴 원본 이벤트 — 충돌 로그에 tgs* 스탬프 대조를 함께 싣는다. */
  ev?: GCalEvent;
  where: string;
}

/**
 * 병합 한 건이 실제로 무엇을 했는지 한 줄로 남긴다.
 *
 * 카운터(`~3`)로는 "무엇이 무엇으로 바뀌었는지"도, "무엇이 폐기됐는지"도 알 수 없다.
 * 특히 충돌은 한쪽 변경이 조용히 사라지는 유일한 경로라 근거를 남겨야 한다 —
 * 어느 필드가 겹쳤고, 노트/GCal이 각각 무엇으로 바꿨고, 무엇이 버려졌는지까지 적는다.
 */
export function mergeEntry(
  settings: PluginSettings,
  c: MergeLogInput
): SyncLogEntry | null {
  const { plan, before, applied, pushKind } = c;
  const parts: string[] = [];

  // 1) 충돌 — 같은 필드를 양쪽에서 **다른 값으로** 바꾼 것. 한쪽 변경이 조용히 사라지는
  //    유일한 경로라 폐기된 값까지 적는다. 어느 쪽이 이기는지는 원격 변경이 **사람의 GCal
  //    편집**이었는지 **메아리**였는지로 갈린다 → reconcile.ts § 충돌 판정
  //    (양쪽이 같은 값이면 애초에 충돌이 아니므로 여기 오지 않는다)
  const conflictText = (f: Field) =>
    `${f}(노트 ${fieldText(before, f)}→${fieldText(
      plan.local,
      f
    )} / GCal ${fieldText(before, f)}→${fieldText(plan.remote, f)})`;
  // ★ 승자를 **왜** 그렇게 정했는지까지 적는다. 판정 근거는 이벤트의 현재 값과 거기
  //   심긴 tgs* 스탬프의 대조 하나뿐인데, 그 두 값이 로그에 없으면 "왜 노트가 이겼지"를
  //   나중에 되짚을 방법이 없다 — 실제로 그것 때문에 한 번 헤맸다.
  const stampText = () => {
    const p = c.ev?.extendedProperties?.private;
    if (!p) return " [스탬프 없음 — 판정 불가]";
    const cur = plan.remote;
    const bits = [
      `tgsDue=${p.tgsDue ?? "-"}/현재 ${cur.due}`,
      `tgsStart=${p.tgsStart ?? "-"}/현재 ${cur.start}`,
    ];
    return ` [대조: ${bits.join(" · ")}]`;
  };
  if (plan.conflicts.length) {
    parts.push(
      `⚔️ 충돌 ${plan.conflicts
        .map(conflictText)
        .join(
          ", "
        )} → 노트 채택(GCal 변경은 메아리 — 스탬프와 값이 같다), GCal 변경 폐기${stampText()}`
    );
  }
  if (plan.gcalWins.length) {
    parts.push(
      `⚔️ 충돌 ${plan.gcalWins
        .map(conflictText)
        .join(", ")} → GCal 채택(사람이 캘린더에서 편집), 노트 변경 폐기${stampText()}`
    );
  }

  // 2) GCal → 노트로 실제로 쓴 것 / 쓰려다 실패한 것
  if (applied.length) {
    parts.push(`⬇ 노트 반영: ${diffText(before, plan.merged, applied)}`);
  }
  const pullFailed = plan.pulledFields.filter((f) => !applied.includes(f));
  if (pullFailed.length) {
    parts.push(
      `⚠ 노트 반영 실패(값 유지): ${diffText(before, plan.merged, pullFailed)}`
    );
  }

  // 3) 노트 → GCal. GCal이 가져가지 않은 노트 변경만 올라간다.
  if (pushKind === "presentation") {
    parts.push("⬆ 이벤트 표현만 재적용(제목 접두사 등)");
  } else if (pushKind) {
    const pushedFields = changedFields(before, plan.local).filter(
      (f) => !plan.pulledFields.includes(f)
    );
    if (pushedFields.length) {
      parts.push(`⬆ GCal 반영: ${diffText(before, plan.local, pushedFields)}`);
    }
    if (pushKind === "move") {
      parts.push(
        `↔ 캘린더 이동: ${calName(settings, c.fromCalendar)} → ${calName(settings, c.rec.calendarId
        )} (이벤트 재생성)`
      );
    }
  }

  // 4) 미룬 것 — 이번 run에 "아무 일도 안 일어난" 이유가 여기 있다.
  if (plan.holdDone) {
    const sec = Math.round((plan.retryAfterMs ?? 0) / 1000);
    parts.push(
      `⏸ 완료 해제(완료→미완료)를 한 사이클 보류 — ${sec}초 뒤 재확인`
    );
  }
  if (c.blockedByCold) {
    parts.push("⏸ 콜드 스타트 → GCal 쓰기 보류(다음 run에 올라감)");
  }
  if (plan.timeIgnoredMultiDay) {
    parts.push(
      "⚠ GCal이 시각을 지정했으나 여러 날에 걸친 task 라 받지 않음 " +
        "(🛫<📅 구간은 종일로만 표현된다 — 🛫를 떼면 시각을 쓸 수 있다)"
    );
  }
  if (c.precondFailed) {
    parts.push(
      "⏸ pull 이후 GCal이 또 바뀜 → push 포기(덮지 않는다. 다음 run이 새 상태로 재판정)"
    );
  }

  if (!parts.length) return null; // 실제로 한 일이 없으면 남기지 않는다

  const action = pushKind === "move"
    ? "MOVE"
    : pushKind
    ? "UPDATE"
    : applied.length
    ? "PULL"
    : "HOLD";
  return {
    action,
    id: c.id,
    title: plan.merged.title || plan.local.title,
    calendar: calName(settings, c.rec.calendarId),
    eventId: c.rec.eventId,
    where: c.where,
    detail: parts.join(" | "),
  };
}
