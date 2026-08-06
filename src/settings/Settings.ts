export interface CalendarRef {
  id: string;
  name: string;
}

/**
 * (선택) 보정 규칙: #gcal/<이름>의 <이름>이 실제 캘린더명과 다를 때만 사용.
 * tag에는 prefix 뒤의 이름(예: "Growth")을 넣는다.
 */
export interface RoutingRule {
  tag: string; // #gcal/ 뒤의 이름. 예: Growth
  calendarId: string;
  calendarName: string;
}

/** 동기화 타이밍 프리셋. custom = 세부 값을 직접 만진 상태. */
export type SyncPreset = "realtime" | "balanced" | "economy" | "manual" | "custom";

/** 프리셋이 정하는 타이밍 값들. 이 6개 밖의 설정은 프리셋과 무관하다. */
export type TimingSettings = Pick<
  PluginSettings,
  | "autoPushOnEdit"
  | "autoPushDebounceSeconds"
  | "minSyncIntervalSeconds"
  | "syncOnWindowSwitch"
  | "syncOnStartup"
  | "syncIntervalMinutes"
>;

export const SYNC_PRESETS: Record<
  Exclude<SyncPreset, "custom">,
  { label: string; desc: string; timing: TimingSettings }
> = {
  realtime: {
    label: "실시간",
    desc: "편집 5초 뒤 반영, 2분마다 확인. 반응은 가장 빠르지만 API 호출이 많다.",
    timing: {
      autoPushOnEdit: true,
      autoPushDebounceSeconds: 5,
      minSyncIntervalSeconds: 30,
      syncOnWindowSwitch: true,
      syncOnStartup: true,
      syncIntervalMinutes: 2,
    },
  },
  balanced: {
    label: "균형 (기본)",
    desc: "편집 20초 뒤 반영, 5분마다 확인, 창 전환 때 즉시. 대부분 이걸로 충분하다.",
    timing: {
      autoPushOnEdit: true,
      autoPushDebounceSeconds: 20,
      minSyncIntervalSeconds: 60,
      syncOnWindowSwitch: true,
      syncOnStartup: true,
      syncIntervalMinutes: 5,
    },
  },
  economy: {
    label: "절약",
    desc: "편집 60초 뒤 반영, 30분마다 확인. 창 전환 때는 여전히 즉시 — 모바일 배터리/데이터 아낄 때.",
    timing: {
      autoPushOnEdit: true,
      autoPushDebounceSeconds: 60,
      minSyncIntervalSeconds: 300,
      syncOnWindowSwitch: true,
      syncOnStartup: true,
      syncIntervalMinutes: 30,
    },
  },
  manual: {
    label: "수동만",
    desc: "리본 아이콘이나 명령으로 직접 실행할 때만 동기화한다.",
    timing: {
      autoPushOnEdit: false,
      autoPushDebounceSeconds: 20,
      minSyncIntervalSeconds: 60,
      syncOnWindowSwitch: false,
      syncOnStartup: false,
      syncIntervalMinutes: 0,
    },
  },
};

/** 현재 타이밍 값이 어느 프리셋과 일치하는지 — 하나도 안 맞으면 "custom". */
export function derivePreset(s: PluginSettings): SyncPreset {
  for (const [key, p] of Object.entries(SYNC_PRESETS)) {
    const match = (Object.keys(p.timing) as (keyof TimingSettings)[]).every(
      (k) => s[k] === p.timing[k]
    );
    if (match) return key as SyncPreset;
  }
  return "custom";
}

export interface PluginSettings {
  // OAuth (사용자 자신의 Google Cloud 프로젝트 자격증명)
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;

  // 라우팅: 규칙에 매칭되는 태그가 있으면 그 캘린더로, 없으면 기본 캘린더로
  rules: RoutingRule[];
  defaultCalendarId: string;
  defaultCalendarName: string;

  // 설정 UI 드롭다운용 캐시(목록 불러오기 시 저장)
  calendars: CalendarRef[];

  // 라우팅 태그 prefix. 기본 "#gcal/" → task에 #gcal/Growth 식으로 캘린더 지정
  routingTagPrefix: string;

  // 동작
  globalFilter: string; // 기본 #task
  doneTag: string; // 완료 표시 prefix, 기본 #done (doneColorId 미설정 시 폴백)
  todoPrefix: string; // 미완료 task 이벤트 제목 접두사(예: ☐). "" = 없음
  donePrefix: string; // 완료 task 이벤트 제목 접두사(예: ☑️). "" = 없음
  recurringPrefix: string; // 🔁 반복(🔁) task 이벤트 제목 아이콘(예: 🔁). "" = 표시 안 함
  doneColorId: string; // 완료 색(1~11). 이 색이면 완료로 간주. "" = 색 완료 비활성(제목 #done 폴백)
  doneOnFree: boolean; // 이벤트를 free(한가함, transparency=transparent)로 바꾸면 완료로 간주(색과 OR). 아이폰 기본앱 대응.
  deepLink: "off" | "note" | "line"; // 이벤트 설명에 Obsidian 딥링크 추가. line은 Advanced URI 플러그인 필요
  pushOnly: boolean; // true면 Obsidian→GCal 단방향(GCal 변경 무시)
  includeOverdue: boolean; // overdue(오늘 이전 미완료)도 동기화
  syncOnStartup: boolean;
  syncIntervalMinutes: number; // 0 = 수동만
  syncPreset: SyncPreset; // 아래 6개 타이밍 값의 묶음. 하나라도 손대면 "custom"
  autoPushOnEdit: boolean; // task 편집 시 자동 push(Obsidian→GCal, 디바운스)
  autoPushDebounceSeconds: number; // 편집이 멎고 몇 초 뒤에 동기화할지
  minSyncIntervalSeconds: number; // 자동 동기화 최소 간격(수동/리본은 무시). 0 = 제한 없음
  syncOnWindowSwitch: boolean; // 창을 벗어날 때 밀린 편집 push + 돌아올 때 GCal pull

  // (구버전 호환) 단일 대상 캘린더 — 마이그레이션에만 사용
  targetCalendarId?: string;
  targetCalendarName?: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: null,
  rules: [],
  defaultCalendarId: "",
  defaultCalendarName: "",
  calendars: [],
  routingTagPrefix: "#gcal/",
  globalFilter: "#task",
  doneTag: "#done",
  todoPrefix: "☐",
  donePrefix: "☑️",
  recurringPrefix: "🔁",
  doneColorId: "8",
  doneOnFree: true,
  deepLink: "note",
  pushOnly: true,
  includeOverdue: false,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  syncPreset: "balanced",
  autoPushOnEdit: true,
  autoPushDebounceSeconds: 20,
  minSyncIntervalSeconds: 60,
  syncOnWindowSwitch: true,
};

/**
 * task의 #gcal/<이름> 태그로 대상 캘린더 결정.
 *  1) prefix(#gcal/) 태그의 <이름>을 추출
 *  2) 보정 규칙(rules)에 <이름>이 있으면 그 캘린더
 *  3) 없으면 캘린더 목록에서 이름이 같은 캘린더(자동 매칭, 대소문자 무시)
 *  4) 그래도 없으면 기본 캘린더. 기본도 없으면 null.
 */
export function resolveCalendar(
  tags: string[],
  settings: PluginSettings
): CalendarRef | null {
  const prefix = settings.routingTagPrefix || "#gcal/";
  const tag = tags.find((t) => t.startsWith(prefix) && t.length > prefix.length);
  if (tag) {
    const name = tag.slice(prefix.length);
    const rule = settings.rules.find(
      (r) => r.calendarId && (r.tag === name || r.tag === tag)
    );
    if (rule) return { id: rule.calendarId, name: rule.calendarName };
    const cal = settings.calendars.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    if (cal) return { id: cal.id, name: cal.name };
  }
  if (settings.defaultCalendarId) {
    return { id: settings.defaultCalendarId, name: settings.defaultCalendarName };
  }
  return null;
}
