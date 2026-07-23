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
  autoPushOnEdit: boolean; // task 편집 시 자동 push(Obsidian→GCal, 디바운스)

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
  autoPushOnEdit: true,
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
