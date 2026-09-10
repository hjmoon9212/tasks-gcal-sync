export interface CalendarRef {
  id: string;
  name: string;
  /** 목록 불러오기가 가져온 Google 쪽 배경색. 캘린더 뷰 색의 첫 기본값으로만 쓴다 */
  color?: string;
}

/**
 * 캘린더 뷰(gcal-calendar-view)에 **읽기 전용으로 그릴** 캘린더.
 *
 * color가 로컬 설정인 이유: Google 이벤트의 colorId는 1~11 팔레트 인덱스일 뿐
 * 사용자가 캘린더에 지정한 커스텀 HEX를 주지 않는다.
 *
 * **`""` 는 "캘린더 뷰의 카테고리 색을 따른다"** 는 뜻이고 그게 기본값이다.
 * `#gcal/<이름>` 라우팅이 태그 이름과 캘린더 이름을 그대로 맞추므로, 캘린더
 * "Growth" 의 회의는 growth 카테고리 색이 되어 같은 캘린더의 task 막대와 저절로
 * 같아진다 — 색을 두 군데서 따로 맞출 필요가 없다. 여기에 값을 넣으면 그게 이긴다.
 */
export interface FeedCalendar {
  id: string;
  name: string;
  color: string; // "#rrggbb" | "" = 카테고리 색 따르기
}

/** 자동으로 채워 넣던 폴백 회색. 이 값은 "고른 색"이 아니라 "못 정한 색"이었다. */
export const FEED_COLOR_FALLBACK = "#7f8c8d";

/**
 * v0.7.0 은 캘린더를 켤 때 색을 반드시 채웠고, calendarList 의 backgroundColor 가
 * 없으면 폴백 회색을 넣었다. 그래서 고른 캘린더가 전부 같은 회색이 되는 일이 생겼다.
 * 그 회색은 **선택이 아니라 부재**였으므로 `""`(카테고리 색 따르기)로 되돌린다.
 * 일부러 그 회색을 원했다면 설정에서 다시 고르면 된다.
 */
export function migrateFeedColors(settings: PluginSettings): void {
  for (const f of settings.feedCalendars ?? []) {
    if (f.color === FEED_COLOR_FALLBACK) f.color = "";
  }
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

  // 캘린더 뷰에 읽기 전용으로 표시할 캘린더. [] = 기능 꺼짐(기본)
  feedCalendars: FeedCalendar[];
  // 그 일정들을 몇 분마다 조용히 다시 받아올지. 0 = 자동 갱신 없음(명령으로만).
  // **동기화 주기와 무관하다** — 회의는 우리 동기화와 상관없이 바뀐다.
  feedRefreshMinutes: number;

  // 라우팅 태그 prefix. 기본 "#gcal/" → task에 #gcal/Growth 식으로 캘린더 지정
  routingTagPrefix: string;

  // 동작
  globalFilter: string; // 기본 #task
  doneTag: string; // 완료 이벤트 제목에 붙일 표시, 기본 #done (색·접두사를 둘 다 껐을 때의 폴백)
  todoPrefix: string; // 미완료 task 이벤트 제목 접두사(예: ☐). "" = 없음
  donePrefix: string; // 완료 task 이벤트 제목 접두사(예: ☑️). "" = 없음
  recurringPrefix: string; // 🔁 반복(🔁) task 이벤트 제목 아이콘(예: 🔁). "" = 표시 안 함
  doneColorId: string; // 완료 task 이벤트를 칠할 색(1~11). **표시 전용** — 읽지 않는다(v0.4.0). "" = 색 안 건드림
  deepLink: "off" | "note" | "line"; // 이벤트 설명에 Obsidian 딥링크 추가. line은 Advanced URI 플러그인 필요
  includeOverdue: boolean; // overdue(오늘 이전 미완료)도 동기화

  // 동기화 타이밍 (각각 직접 설정)
  syncOnStartup: boolean;
  syncIntervalMinutes: number; // 0 = 주기 동기화 없음
  autoPushOnEdit: boolean; // task 편집 시 자동 push(Obsidian→GCal, 디바운스)
  autoPushDebounceSeconds: number; // 편집이 멎고 몇 초 뒤에 동기화할지
  /**
   * 자동 동기화 최소 간격(수동/리본은 무시). 0 = 제한 없음.
   *
   * ⚠️ **편집 트리거에는 걸리지 않는다**(0.9.0~). 이 값의 목적은 "빈 run 을 자주 돌리지
   * 말자" 인데 편집 트리거는 사용자가 실제로 뭔가 바꾼 시점이라 해당하지 않는다. 걸어 두면
   * 편집이 GCal 에 닿기까지 최대 이 시간만큼 밀리고, 그 사이 Obsidian 이 꺼지면 못 올린다.
   */
  minSyncIntervalSeconds: number;

  // 상세 로그 — Notice·상태바·console이 모두 휘발성이라, 사후 추적은 이 파일로만 가능하다
  syncLogEnabled: boolean;
  syncLogPath: string; // 볼트 루트 기준. 볼트 안이면 Obsidian에서 바로 열람 가능
  syncLogMaxKB: number; // 초과분은 오래된 것부터 삭제. 0 = 무제한
  syncLogSkips: boolean; // 보류·건너뜀·실패도 남길지

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
  feedCalendars: [], // 빈 배열 = 기능 꺼짐 → 업그레이드해도 동작이 바뀌지 않는다
  feedRefreshMinutes: 15,
  routingTagPrefix: "#gcal/",
  globalFilter: "#task",
  doneTag: "#done",
  todoPrefix: "☐",
  donePrefix: "☑️",
  recurringPrefix: "🔁",
  doneColorId: "8",
  deepLink: "note",
  includeOverdue: false,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  autoPushOnEdit: true,
  // 편집이 GCal에 닿기까지의 창이 곧 "Obsidian을 껐더니 안 올라갔다"의 크기다(0.9.0~).
  // 연속 편집을 합치는 데는 3초면 충분하다.
  autoPushDebounceSeconds: 3,
  minSyncIntervalSeconds: 60,
  syncLogEnabled: true,
  syncLogPath: "Logs/GCal 동기화 로그.md",
  syncLogMaxKB: 512,
  syncLogSkips: true,
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
