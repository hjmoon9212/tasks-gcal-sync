import { PluginSettings } from "./Settings";
import { SyncRecord } from "../sync/StateStore";

/** 지금은 없는 옛 설정들. 남아 있으면 지우기만 한다. */
export interface LegacySettings {
  syncPreset?: string; // 타이밍 프리셋(≤0.3.13) — 0.3.14에서 제거, 값은 직접 설정만
  pushOnly?: boolean; // 단방향 모드(≤0.3.13) — 0.3.14에서 제거, 항상 양방향
  doneOnFree?: boolean; // free(한가함)=완료 제스처(0.3.0~0.3.18) — 0.3.19에서 제거
  syncOnWindowSwitch?: boolean; // 창 전환 트리거(0.3.11~0.3.12) — 0.3.13에서 제거
  syncOnBlur?: boolean;
  syncOnFocus?: boolean;
  skipPullOnEdit?: boolean;
  routingTagPrefix?: string; // 라우팅 태그 접두사 — 0.11.2에서 상수로(#gcal/ 고정)
  doneTag?: string; // #done 폴백 태그 — 0.11.2에서 제거(색·접두사가 완료를 표시한다)
}

/**
 * 없어진 옵션을 settings에서 떼어낸다. 다음 저장 때 data.json에서도 빠진다.
 * 값은 읽지 않는다 — 타이밍은 각 항목을 직접 설정하고(프리셋 없음),
 * 동기화는 항상 양방향이다(단방향 없음). 기존 값이 남아 있어도 무시한다.
 *
 * ⚠️ **동작을 바꾸는 제거라면 승계 규칙을 따로 적을 것** — 여기는 지우기만 한다.
 * main.ts 의 migrateTiming 에서 옮겼다(0.12.8).
 */
export function stripLegacySettings(settings: PluginSettings): void {
  const dead: (keyof LegacySettings)[] = [
    "doneOnFree",
    "skipPullOnEdit",
    "syncOnBlur",
    "syncOnFocus",
    "syncOnWindowSwitch",
    "syncPreset",
    "pushOnly",
    "routingTagPrefix",
    "doneTag",
  ];
  for (const k of dead) delete (settings as Partial<LegacySettings>)[k];
}

/** 구버전(단일 대상 캘린더) → 기본 캘린더로. targetCalendarId 자체는 지우지 않는다(현재 동작). */
export function migrateTargetCalendar(settings: PluginSettings): void {
  if (settings.targetCalendarId && !settings.defaultCalendarId) {
    settings.defaultCalendarId = settings.targetCalendarId;
    settings.defaultCalendarName = settings.targetCalendarName ?? "";
  }
}

/** 구버전 records(calendarId 없음) → 기본 캘린더로 간주. */
export function backfillRecordCalendarIds(
  records: Record<string, SyncRecord>,
  defaultCalendarId: string
): void {
  for (const rec of Object.values(records)) {
    if (!rec.calendarId) rec.calendarId = defaultCalendarId;
  }
}
