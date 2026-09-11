import { App, Notice, Platform } from "obsidian";
import { PluginSettings, resolveCalendar } from "../settings/Settings";
import { PersistedState, SyncRecord } from "./StateStore";
import { TaskRepository, VaultTask } from "../data/TaskRepository";
import {
  CalendarClient,
  GCalEvent,
  PreconditionFailedError,
} from "../gcal/CalendarClient";
import { TaskWriter } from "../write/TaskWriter";
import { SyncLogEntry } from "./SyncLog";
import {
  decideReconcile,
  Field,
  LocalView,
  MergePlan,
  RemoteView,
  RunGuards,
  Snapshot,
  TaskState,
} from "./reconcile";
import {
  addDay,
  addDays,
  daysBetween,
  fmt,
  genId,
  isoDaysAgo,
  isValidDate,
  isValidTimeRange,
  localTimeZone,
  shiftDateTime,
  timeOfDateTime,
  toDateTime,
  todayStr,
} from "./dates";

/**
 * 이번 run 에서 무엇을 못 했는가. `skipped` 는 합계일 뿐이라 원인을 못 알려준다 —
 * 2026-07-21 의 "동기화가 도는 것 같은데 아무것도 안 바뀐다" 가 정확히 이 사각지대였다
 * (인증이 통째로 깨졌는데 항목별 catch 가 조용히 삼키고 있었다).
 */
export type SkipKind =
  | "vault-behind" // 볼트가 Sync 중 → run 전체 보류
  | "duplicate-id" // 같은 🆔 가 두 줄 → 정본 불명
  | "hold-task-gone" // task 없음, 그러나 지우기엔 이른 상태
  | "hold-due-invalid" // 📅 유실, 그러나 지우기엔 이른 상태
  | "hold-unschedule" // 이벤트 삭제됨, 그러나 미일정화하기엔 이른 상태
  | "hold-conflict" // 값이 갈렸으나 볼트가 정착 전 → 충돌 해결 보류
  | "cold-start-create" // 콜드 스타트라 새 이벤트를 안 만듦
  | "unsettled-create" // 볼트가 아직 정착 전이라 새 🆔·이벤트를 안 만듦
  | "ensure-id-failed" // 🆔 쓰기 실패(줄이 그 사이 바뀜 등)
  | "create-failed" // 이벤트 생성 실패
  | "pull-failed" // 그 캘린더를 읽지 못함 → 읽지 못한 곳에는 쓰지 않는다
  | "mobile-readonly" // 이 기기는 GCal 에 쓰지 않는다(모바일)
  | "push-precondition" // If-Match 412 — pull 이후 원격이 또 바뀌었다
  | "reconcile-error"; // 조정 중 예외

export interface SyncFailure {
  where: string; // task 🆔 또는 경로
  message: string;
}

/** skip 사유를 로그에 적을 한국어 라벨. main의 SKIP_LABEL과 같은 문구를 쓴다. */
const SKIP_TEXT: Record<SkipKind, string> = {
  "vault-behind": "볼트가 Obsidian Sync로 아직 따라잡는 중 → run 전체 보류",
  "duplicate-id": "같은 🆔가 두 줄 이상 → 정본 불명, 손대지 않음",
  "hold-task-gone": "task가 안 보이지만 지우기엔 이름 → 이벤트 유지",
  "hold-due-invalid": "📅가 없지만 지우기엔 이름 → 이벤트 유지",
  "hold-unschedule": "이벤트가 삭제됐지만 미일정화하기엔 이름 → 📅 유지",
  "hold-conflict":
    "노트·GCal 값이 갈렸으나 볼트가 아직 정착 전 → 충돌 해결 보류(어느 쪽도 쓰지 않음)",
  "cold-start-create": "콜드 스타트 → 새 이벤트 생성 보류",
  "unsettled-create":
    "볼트가 아직 정착 전 → 새 🆔 발급·이벤트 생성 보류(노트에 쓰는 순간 편집·Sync와 겹친다)",
  "ensure-id-failed": "🆔를 노트에 쓰지 못함",
  "create-failed": "이벤트 생성 실패",
  "pull-failed":
    "캘린더를 읽지 못함 → 그 캘린더의 record는 손대지 않음(읽지 못할 때는 쓰지도 않는다)",
  "mobile-readonly":
    "모바일 읽기 전용 → GCal에 쓰지 않음(pull은 정상. 반영은 데스크탑이 맡는다)",
  "push-precondition":
    "pull 이후 GCal이 또 바뀜 → push 포기(다음 run이 새 상태로 다시 판정한다)",
  "reconcile-error": "조정 중 예외",
};

export interface SyncResult {
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  pulled: number; // GCal → Obsidian 반영 건수
  skipped: number;
  /** 사유별 skip 건수. 합이 `skipped` 다. */
  skips: Partial<Record<SkipKind, number>>;
  /** 실제로 터진 것. 콘솔에만 남기면 못 본다 — 호출부가 사용자에게 보여준다. */
  failures: SyncFailure[];
  /**
   * 건별 기록. 카운터는 "몇 건"만 알려주므로 사후에 원인을 못 찾는다 —
   * 무엇이 어느 캘린더에서 왜 바뀌었는지는 여기에만 남는다(호출부가 파일로 적는다).
   */
  entries: SyncLogEntry[];
  /**
   * 이 시간(ms) 뒤에 다시 돌면 반영될 것이 있다. 없으면 undefined.
   * 사유는 셋 — **done 회귀 보류 · 볼트 뒤처짐 보류 · 콜드 스타트 쓰기 잠금**.
   * 호출부(main)가 후속 run을 예약한다 — 안 그러면 보류가 풀려도 다음 주기(기본 5분)
   * 까지 GCal이 그대로라 "아무 변화가 없다"로 보인다.
   *
   * 여러 보류가 겹치면 **가장 이른 시각**을 쓴다(`Math.min`). 각 run이 남아 있는 보류를
   * 매번 다시 알리므로, 이르게 깨어나도 그 run이 다음 재확인을 또 예약해 수렴한다.
   */
  retryAfterMs?: number;
}

interface CalPull {
  byTaskId: Map<string, GCalEvent>;
  cancelledEventIds: Set<string>;
}

/**
 * 양방향 동기화 엔진.
 *  Push (Obsidian → GCal): 📅 task → 종일 이벤트(태그→캘린더 라우팅), 완료 시 #done prefix.
 *  Pull (GCal → Obsidian): syncToken 증분으로 날짜이동/#done/삭제를 감지해 반영.
 *  충돌: 필드(due/start/done/title) 단위로 병합한다. 한쪽에서만 바뀐 필드는 그대로 살리고,
 *        같은 필드가 양쪽에서 바뀐 경우에만 GCal을 채택(직접 조작한 화면)하고 warn을 남긴다.
 *  매핑 스냅샷(records)으로 어느 쪽 어느 필드가 바뀌었는지 판정.
 */
/** 콜드 스타트 push 잠금이 풀리는 최소 시간(ms). pull 1회 완주 + 이 시간 둘 다 필요. */
const COLD_START_MS = 60_000;
/** done 회귀를 처음 본 뒤 실제로 push하기까지 최소 대기(ms). 그 사이 Sync가 정착한다. */
const UNCHECK_HOLD_MS = 60_000;
/**
 * 캘린더 전수 스캔(rebuildRecords)의 자동 실행 간격.
 * records 가 비었으면 간격과 무관하게 즉시 돈다 — 그때는 스캔이 유일한 복구 경로다.
 */
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * vaultBehind가 계속 참일 때 보류를 포기하고 통과시키는 상한.
 *
 * **시간만 센다.** 예전엔 횟수(5회) 상한도 있었는데, 그건 run 간격이 주기 동기화
 * (기본 5분)뿐이라 "5회 ≈ 25분"이던 시절의 값이다. 보류할 때마다 재확인을 예약하는
 * 지금은 5회가 75초밖에 안 돼 보호가 사실상 사라진다. 예산의 목적은 "영원히 막히지
 * 않기"이므로 원래 시간 개념이 맞다.
 */
const BEHIND_MAX_MS = 10 * 60_000;
/**
 * 볼트 뒤처짐으로 run을 보류했을 때 다시 확인하기까지의 간격.
 *
 * 보류 run은 네트워크 호출 전에 반환되므로 사실상 공짜다. 이게 없으면 Sync가 3초 만에
 * 정착해도 다음 트리거(주기 5분)까지 아무 일도 안 일어난다.
 */
const BEHIND_RECHECK_MS = 15_000;
/**
 * 충돌 해결 보류의 **상한**(fail-open). 이보다 오래 끌면 정착 전이라도 해결한다.
 *
 * `vaultBehind` 의 10분 상한과 같은 성격이고 더 길다 — 충돌 해결은 한쪽 값을 버리는
 * 일이라 더 참아야 하지만, **영영 미루면 그건 판정이 아니라 고장이다.** 2026-09-10 에
 * 만성적으로 따라잡는 볼트에서 `⚔️` 기록이 전부 보류로만 남았고, 어느 쪽도 안 쓰니
 * 사용자에게는 "언제나 Obsidian 이 이긴다"로 보였다 → reconcile.conflictResolutionAllowed
 */
const CONFLICT_HOLD_MAX_MS = 15 * 60_000;
/**
 * pull 로 쓴 줄이 되돌아간 것으로 볼 수 있는 시간 창(ms).
 *
 * 이보다 늦게 달라졌으면 사용자 편집으로 본다 — 우리가 쓴 직후가 아니면 근거가 약하다.
 */
const REVERT_WINDOW_MS = 3 * 60_000;
/**
 * 뒤처짐이 풀린 뒤 "정착했다"로 인정하기까지 이어져야 하는 시간.
 *
 * **한 번의 표본은 정착이 아니다.** 2026-09-07 에 40분짜리 보류 구간 두 개 사이의 2초
 * 틈에서 `vaultBehind()`가 false 를 돌려줬고, 그 틈에 (a) 새 🆔 를 노트에 써넣고
 * (b) 40분 뒤 같은 틈에서 이벤트를 지웠다. 되돌리기 힘든 동작은 구간을 보고 결정한다.
 */
const SETTLE_MS = 30_000;

export class SyncEngine {
  /** 플러그인 로드 시각. 콜드 스타트 판정 기준(인스턴스는 로드마다 새로 만들어진다). */
  private readonly loadedAt = Date.now();
  /** 알려진 캘린더 전부를 예외 없이 pull한 run이 한 번 끝났는가. */
  private pullCycleDone = false;
  /** 볼트 뒤처짐 판정이 **연속으로** 참이기 시작한 시각. fail-open 상한의 기준. */
  private behindSince: number | null = null;
  /**
   * 뒤처짐 판정이 **연속으로** 거짓이기 시작한 시각. 정착(SETTLE_MS) 판정의 기준.
   * 뒤처짐이 한 번이라도 관측되면 다시 null 이 된다 — 시계를 처음부터 다시 센다.
   */
  private settledSince: number | null = null;

  constructor(
    private app: App,
    private settings: PluginSettings,
    private state: PersistedState,
    private repo: TaskRepository,
    private client: CalendarClient,
    private writer: TaskWriter,
    private saveState: () => Promise<void>
  ) {}

  private titleBase(t: VaultTask): string {
    const prefix = this.settings.routingTagPrefix || "#gcal/";
    return t.title
      .split(/\s+/)
      .filter((w) => !w.startsWith(prefix))
      .join(" ")
      .trim();
  }

  private summary(t: VaultTask): string {
    const base = this.titleBase(t);
    // 반복(🔁) task는 아이콘으로 표시 → 캘린더에서 반복 할일임을 한눈에.
    const recur = t.recurrence ? this.settings.recurringPrefix?.trim() : "";
    const withIcon = recur ? `${recur} ${base}` : base;
    // 상태별 체크박스 접두사: 미완료=☐, 완료=☑️ → 모바일에서 제목만 보고 완료 확인.
    const box = (
      t.checked ? this.settings.donePrefix : this.settings.todoPrefix
    )?.trim();
    const title = box ? `${box} ${withIcon}` : withIcon;
    // 색·박스 둘 다 없을 때만 #done 폴백으로 완료 표시.
    if (!this.settings.doneColorId && t.checked && !this.settings.donePrefix)
      return `${this.settings.doneTag} ${title}`;
    return title;
  }

  /** 완료 상태에 대응하는 colorId. 색 완료 활성 시: 완료=완료색, 미완료=null(기본색). 비활성 시 undefined(색 안 건드림). */
  private doneColor(t: VaultTask): string | null | undefined {
    if (!this.settings.doneColorId) return undefined;
    return t.checked ? this.settings.doneColorId : null;
  }

  /** GCal 이벤트 제목에서 체크박스/반복 아이콘/완료 접두사를 떼어 순수 제목 추출(pull용). */
  private gcalTitleBase(ev: GCalEvent): string {
    let s = (ev.summary ?? "").trim();
    const prefixes = [
      this.settings.donePrefix,
      this.settings.todoPrefix,
      this.settings.recurringPrefix,
      this.settings.doneTag,
    ]
      .map((p) => p?.trim())
      .filter((p): p is string => !!p);
    // ☐/☑️ 와 🔁 가 어떤 순서로 붙어도 앞에서부터 반복 제거.
    let changed = true;
    while (changed) {
      changed = false;
      for (const pp of prefixes) {
        if (s.startsWith(pp)) {
          s = s.slice(pp.length).trim();
          changed = true;
        }
      }
    }
    return s;
  }

  /** task로 점프하는 Obsidian 딥링크. note=노트까지, line=정확한 줄(Advanced URI 필요). */
  private deepLink(t: VaultTask): string | null {
    const mode = this.settings.deepLink;
    if (mode === "off") return null;
    const vault = encodeURIComponent(this.app.vault.getName());
    const fp = encodeURIComponent(t.path);
    if (mode === "line") {
      // Advanced URI의 line은 1-based(에디터 표시 줄). VaultTask.line은 0-based.
      return `obsidian://adv-uri?vault=${vault}&filepath=${fp}&line=${t.line + 1}`;
    }
    return `obsidian://open?vault=${vault}&file=${fp}`;
  }

  /** 우리가 관리하는 설명 블록의 시작 표시. 이 줄부터 끝까지가 플러그인 영역이다. */
  private static readonly NOTE_MARKER = "— tasks-gcal-sync —";

  /** 우리 블록: 볼트 이름 + task ID (+ 딥링크). */
  private noteBlock(id: string, t?: VaultTask): string {
    const base = `${SyncEngine.NOTE_MARKER}\n📁 ${this.app.vault.getName()}\n🆔 ${id}`;
    const link = t ? this.deepLink(t) : null;
    return link ? `${base}\n🔗 ${link}` : base;
  }

  /**
   * 기존 설명에서 **사용자가 쓴 부분만** 남긴다.
   *
   * 예전에는 설명을 통째로 우리 블록으로 갈아치웠다 — GCal 이벤트에 적어 둔 메모가
   * 다음 push 마다 사라졌다. 이제 우리 영역은 마커 아래로 한정한다.
   * 마커가 없는 구버전 이벤트는 **끝에 붙은 📁/🆔/🔗 줄만** 걷어낸다(그 시절 설명은
   * 그 줄들이 전부였다).
   */
  private userDescription(prev: string): string {
    const lines = prev.split("\n");
    const i = lines.findIndex((l) => l.trim() === SyncEngine.NOTE_MARKER);
    if (i >= 0) return lines.slice(0, i).join("\n").trimEnd();
    let end = lines.length;
    while (end > 0) {
      const t = lines[end - 1].trim();
      if (t === "" || /^(📁|🆔|🔗)/u.test(t)) end--;
      else break;
    }
    return lines.slice(0, end).join("\n").trimEnd();
  }

  /** 사용자 텍스트를 보존한 채 우리 블록만 갱신한 설명. */
  private mergeDescription(prev: string, id: string, t?: VaultTask): string {
    const user = this.userDescription(prev);
    const block = this.noteBlock(id, t);
    return user ? `${user}\n\n${block}` : block;
  }

  /** 이벤트 시작일: 🛫 start가 있고 due보다 같거나 앞이면 start, 아니면 due. (다중일 블록 시작) */
  private spanStart(t: VaultTask): string {
    if (t.start && t.due && t.start <= t.due) return t.start;
    return t.due!;
  }

  /** 종일/시간지정 모두에서 시작 날짜(YYYY-MM-DD) 추출. */
  private eventStartDate(ev: GCalEvent): string | undefined {
    if (ev.start?.date) return ev.start.date;
    if (ev.start?.dateTime) return ev.start.dateTime.slice(0, 10);
    return undefined;
  }

  /** 이벤트에서 due(마감일) 추출: all-day는 end.date(배타적)−1, 시간지정은 end 날짜(없으면 start). */
  private eventDueDate(ev: GCalEvent): string | undefined {
    if (ev.end?.date) return addDays(ev.end.date, -1);
    if (ev.end?.dateTime) return ev.end.dateTime.slice(0, 10);
    return this.eventStartDate(ev);
  }

  /**
   * 이벤트의 타임블록 "HH:MM-HH:MM". 종일이면 "", 판정 불가면 undefined.
   *
   * 양끝이 모두 dateTime 일 때만 시각으로 인정한다. 한쪽만 dateTime 인 혼합형은
   * (iPhone 기본 캘린더 등이 만든다) 애초에 patch 하면 400 이 나는 모양이라 손대지 않는다.
   * 자정을 넘기거나 여러 날에 걸친 시간지정 이벤트도 "HH:MM-HH:MM" 한 줄로는 표현할 수
   * 없으므로 판정 불가로 둔다 — 억지로 접으면 노트의 ⏰ 를 엉뚱한 값으로 덮어쓴다.
   */
  private eventTimeRange(ev: GCalEvent): string | undefined {
    if (ev.start?.date && ev.end?.date) return "";
    const s = ev.start?.dateTime;
    const e = ev.end?.dateTime;
    if (!s || !e) return undefined;
    const st = timeOfDateTime(s);
    const et = timeOfDateTime(e);
    if (!st || !et) return undefined;
    const range = `${st}-${et}`;
    return isValidTimeRange(range) ? range : undefined;
  }

  /** 🛫 가 📅 보다 앞서 이벤트가 여러 날에 걸치는가. (같은 날이면 하루짜리) */
  private isMultiDay(t: VaultTask): boolean {
    return !!(t.start && t.due && t.start < t.due);
  }

  /**
   * 노트의 타임블록("" = 종일). 유효하지 않은 값은 종일로 본다.
   *
   * **다중일(🛫 < 📅)이면 ⏰ 가 있어도 종일로 본다.** GCal 의 시간지정 이벤트는
   * "첫날 시작시각 → 마지막날 종료시각" 한 덩어리라, ⏰ 09:00-11:00 에 🛫/📅 가 3일이면
   * 매일 09-11시가 아니라 50시간짜리 통짜 블록이 된다. "여러 날 · 매일 같은 시간대"는
   * 반복 이벤트라야 표현되므로, 표현 못 하는 것을 억지로 만들지 않고 종일 다중일 블록으로 둔다.
   *
   * 노트의 ⏰ 는 지우지 않는다 — 🛫 를 떼거나 📅 를 당겨 하루짜리로 돌아오면 시각이 그대로
   * 살아난다. 이 함수가 시각의 **단일 관문**이라 여기서 "" 를 주면 push(timedDates) ·
   * 스냅샷(tgsTime) · 비교(local.time)가 모두 같은 값을 보고, 노트와 이벤트가 서로 밀지 않는다.
   */
  private taskTime(t: VaultTask): string {
    if (this.isMultiDay(t)) return "";
    return isValidTimeRange(t.time) ? t.time : "";
  }

  /**
   * ⏰ 가 있으면 시간지정 이벤트의 start/end 를, 없으면 null.
   * timeZone 을 반드시 함께 보낸다 — 안 보내면 캘린더 기본 타임존으로 해석돼
   * 기기 타임존이 다를 때 시각이 밀린다(DST 포함).
   */
  private timedDates(t: VaultTask): Partial<GCalEvent> | null {
    const range = this.taskTime(t);
    if (!range) return null;
    const [st, et] = range.split("-");
    const tz = localTimeZone();
    return {
      start: { dateTime: toDateTime(this.spanStart(t), st), timeZone: tz },
      end: { dateTime: toDateTime(t.due!, et), timeZone: tz },
    };
  }

  /**
   * Obsidian 변경분을 이벤트에 반영.
   *  - 제목/완료만 바뀌면 summary/description만 patch → 시간(타임블록) 보존.
   *  - 날짜가 바뀌면: 시간지정 이벤트는 시각 유지한 채 날짜만 이동, 종일이면 종일로.
   */
  /**
   * 날짜를 뺀 "표현" patch — 제목(체크박스·반복 아이콘) · 설명 · 완료색 · free · 스냅샷.
   * pushUpdate와 아래 pushPresentation이 공유한다.
   */
  private presentationPatch(
    id: string,
    t: VaultTask,
    ev?: GCalEvent
  ): Partial<GCalEvent> {
    const patch: Partial<GCalEvent> = {
      summary: this.summary(t),
      // 마지막 push 스냅샷을 이벤트에 갱신 기록(기기 간 상태 복원용).
      extendedProperties: { private: this.privateProps(id, t) },
    };
    // **현재 설명을 모르면 아예 안 보낸다.** patch 는 키 단위 병합이라 이 키를 빼면
    // 이벤트의 설명이 그대로 남는다 — 사용자가 적어 둔 메모를 날리느니 우리 블록이
    // 한 사이클 낡는 편이 낫다. 다음에 이벤트를 손에 쥐면 갱신된다.
    if (ev) patch.description = this.mergeDescription(ev.description ?? "", id, t);
    const color = this.doneColor(t);
    if (color !== undefined) patch.colorId = color; // 완료=완료색, 미완료=null(기본색 복귀)
    return patch;
  }

  /**
   * 날짜는 건드리지 않고 표현만 다시 찍는다.
   *
   * GCal에서 날짜·제목을 고쳐 그쪽이 이긴 run에서는 push할 것이 없어 이벤트의 표현
   * (제목 접두사 ☐/☑️·완료색)이 낡은 채로 남는다. 제목으로 상태를 보는 모바일에서
   * 그게 그대로 드러나므로 한 번 더 찍는다. 날짜를 안 보내므로 GCal이 방금 정한
   * 일정을 되돌릴 위험이 없다.
   */
  private pushPresentation(
    rec: { calendarId: string; eventId: string },
    task: VaultTask,
    id: string,
    ev?: GCalEvent
  ): Promise<GCalEvent> {
    return this.client.patchEvent(
      rec.calendarId,
      rec.eventId,
      this.presentationPatch(id, task, ev),
      ev?.etag // 조건부: pull 이후 또 바뀌었으면 덮지 않고 412
    );
  }

  /**
   * PATCH 용 start/end 를 **한 가지 표현만 남게** 만든다.
   *
   * PATCH 는 객체를 병합한다. 종일 이벤트(`start.date`)에 시각 표현(`start.dateTime`)만
   * 보내면 서버 쪽 start 에는 date 와 dateTime 이 **함께** 남고, Google 은 그걸
   * `400 Invalid start time` 으로 거절한다 — 노트에 ⏰ 를 새로 붙인 task 가 매 sync 마다
   * 이 400 을 반복했다(2026-08-16). 반대 방향(시간 → 종일)도 같은 이유로 깨진다.
   * 그래서 쓰지 않는 쪽을 null 로 명시해 지운다.
   */
  private exclusiveDates(d: Partial<GCalEvent>): Partial<GCalEvent> {
    const one = (v: GCalEvent["start"]): GCalEvent["start"] => {
      if (!v) return v;
      return v.dateTime
        ? { ...v, date: null } // 시간지정 → 종일 표현 제거
        : { ...v, dateTime: null, timeZone: null }; // 종일 → 시간 표현 제거
    };
    const out: Partial<GCalEvent> = { ...d };
    if (d.start) out.start = one(d.start);
    if (d.end) out.end = one(d.end);
    return out;
  }

  private async pushUpdate(
    rec: {
      calendarId: string;
      eventId: string;
      due: string;
      start?: string;
      time?: string;
    },
    task: VaultTask,
    id: string,
    doneOverride?: boolean,
    ev?: GCalEvent
  ): Promise<GCalEvent> {
    // done 회귀를 보류한 채 다른 필드(날짜·제목)만 올리는 경우 — 완료 상태는 기존 값으로
    // 고정한다. 안 그러면 제목 push에 미완료가 딸려가 보류가 무의미해진다.
    const t = doneOverride === undefined ? task : { ...task, checked: doneOverride };
    const startDate = this.spanStart(task);
    const dateChanged =
      task.due !== rec.due ||
      startDate !== (rec.start ?? rec.due) ||
      this.taskTime(task) !== (rec.time ?? "");
    let cur: GCalEvent | undefined = ev;
    let dates: Partial<GCalEvent> | undefined;
    if (dateChanged) {
      try {
        cur = await this.client.getEvent(rec.calendarId, rec.eventId);
      } catch (e) {
        console.warn("[tasks-gcal-sync] getEvent 실패(종일로 처리):", e);
      }
      // 노트에 ⏰ 가 있으면 그 값이 이긴다 — 시각도 노트가 소유하는 필드가 됐다.
      const timed = this.timedDates(task);
      // 노트에서 ⏰ 를 **뗀** 경우인가. 기준은 마지막 동기화 스냅샷이다:
      //   rec.time 이 비어 있음  = 우리가 시각을 올린 적이 없다 → 이벤트의 시각은 GCal 에서
      //                            사람이 지정한 것이므로 보존한다(0.5.0 설계).
      //   rec.time 이 차 있음    = 우리가 올렸던 시각이 노트에서 사라졌다 → 종일로 되돌린다.
      // 이 구분이 없으면 아래 보존 분기가 "⏰ 제거" 까지 삼켜, 노트에서 지워도 GCal 은
      // 계속 시간지정으로 남는다(2026-08-16).
      const timeRemoved = !this.taskTime(task) && !!(rec.time ?? "");
      if (timed) {
        dates = timed;
      }
      // ⏰ 가 없고 제거된 것도 아니면 예전 동작을 유지한다: GCal 에서 사람이 지정해 둔 시각을
      // 날짜만 밀어 보존한다. 순수 timed(양끝 모두 dateTime)일 때만 — 한쪽만 dateTime 인
      // 혼합형을 그대로 patch 하면 타입 불일치로 GCal 400 → 종일로 정규화.
      else if (!timeRemoved && cur?.start?.dateTime && cur?.end?.dateTime) {
        const oldDate = cur.start.dateTime.slice(0, 10);
        const delta = daysBetween(oldDate, task.due!);
        dates = {
          start: {
            dateTime: shiftDateTime(cur.start.dateTime, delta),
            timeZone: cur.start.timeZone,
          },
          end: {
            dateTime: shiftDateTime(cur.end.dateTime, delta),
            timeZone: cur.end.timeZone,
          },
        };
      } else {
        dates = {
          start: { date: startDate },
          end: { date: addDay(task.due!) },
        };
      }
    }
    // 설명 병합은 현재 이벤트를 알아야 하므로 getEvent 뒤에 만든다.
    const patch = this.presentationPatch(id, t, cur);
    if (dates) Object.assign(patch, this.exclusiveDates(dates));
    // 조건부 수정: 우리가 마지막으로 **읽은** 버전(getEvent를 탔으면 그쪽이 더 최신) 기준.
    // 그 사이 사람이 캘린더에서 고쳤으면 덮지 않고 412 → 이번 push 포기.
    return this.client.patchEvent(rec.calendarId, rec.eventId, patch, cur?.etag);
  }

  /**
   * 이벤트에 심는 private 확장속성.
   *  - 식별용: tgsTaskId / tgsSource / tgsVault
   *  - 마지막 push 스냅샷: tgsDue / tgsStart / tgsDone / tgsTitle
   * 스냅샷을 이벤트에 함께 저장해 두면, 기기 간 data.json(records)이 유실/충돌해도
   * GCal에서 "마지막으로 동기화된 상태"를 그대로 복원할 수 있다(recordFromEvent).
   * patch 시에도 항상 전체 세트를 넣어 키 누락을 방지한다.
   */
  private privateProps(id: string, t: VaultTask): Record<string, string> {
    const p: Record<string, string> = {
      tgsTaskId: id,
      tgsSource: "tasks-gcal-sync",
      tgsVault: this.app.vault.getName(),
      tgsDue: t.due!,
      tgsStart: this.spanStart(t),
      // 종일이면 빈 문자열을 **명시적으로** 싣는다. patch는 키 단위 병합이라 키를 빼면
      // 이벤트에 직전 시각이 남아, 시간지정 → 종일로 되돌린 게 다음 판정에서 안 보인다.
      tgsTime: this.taskTime(t),
      tgsDone: t.checked ? "1" : "0",
      tgsTitle: this.titleBase(t),
    };
    // 완료일(✅)은 **있을 때만** 싣는다. patch는 키 단위로 병합되므로 이 키를 안 보내면
    // 이벤트엔 직전 완료일이 그대로 남는다 — 노트에서 체크가 풀려도 "언제 완료였는지"가
    // 남는 유일한 사본이다. 다시 체크하면 Tasks가 오늘 날짜를 쓰므로 원래 날짜는
    // 노트만으로는 복구되지 않는다(2026-08-09 CISS).
    if (t.done) p.tgsDoneAt = t.done;
    return p;
  }

  /**
   * 이 볼트가 만든 이벤트인가.
   *
   * 매핑키(tgsTaskId)는 볼트 안에서만 유일하다 — 볼트 두 개가 같은 캘린더를 쓰면
   * (`#gcal/` 라우팅은 태그 한 줄로 그렇게 된다) 남의 볼트 이벤트를 record로 입양하고,
   * 우리 볼트엔 대응 task가 없으므로 다음 사이클에 "task 없음 → 삭제"로 지워버린다.
   * tgsVault를 심어만 두고 아무도 읽지 않던 구멍(~0.3.15).
   *
   * tgsVault가 없는 옛 이벤트는 통과시킨다 — 다음 push에서 자연 backfill된다.
   */
  private isOurs(ev: GCalEvent): boolean {
    const v = ev.extendedProperties?.private?.tgsVault;
    return !v || v === this.app.vault.getName();
  }

  /**
   * GCal 이벤트에 심긴 스냅샷으로 record를 복원한다(구버전 이벤트엔 없으므로 현재 task값 폴백).
   * 기기 간 records 유실 시 "마지막 동기화 상태"를 되살려 잘못된 방향 판정을 막는다.
   */
  private recordFromEvent(
    ev: GCalEvent,
    calendarId: string,
    t: VaultTask
  ): SyncRecord {
    const p = ev.extendedProperties?.private ?? {};
    return {
      eventId: ev.id!,
      calendarId,
      due: p.tgsDue ?? t.due!,
      start: p.tgsStart ?? this.spanStart(t),
      time: p.tgsTime ?? this.taskTime(t),
      done: p.tgsDone != null ? p.tgsDone === "1" : t.checked,
      title: p.tgsTitle ?? this.titleBase(t),
      gcalUpdated: ev.updated,
    };
  }

  /**
   * task 없이 이벤트만으로 record 복원. 볼트에 대응 task가 없는 이벤트(삭제됐거나
   * 아직 동기화 안 된)도 record로 만들어야 조정 루프의 시야에 들어온다.
   * tgs* 스냅샷이 없는 옛 이벤트는 복원 불가 → null (backfill-ids로 채운 뒤 잡힌다).
   */
  private recordFromEventOnly(
    ev: GCalEvent,
    calendarId: string
  ): SyncRecord | null {
    const p = ev.extendedProperties?.private ?? {};
    if (!ev.id || !p.tgsDue) return null;
    return {
      eventId: ev.id,
      calendarId,
      due: p.tgsDue,
      start: p.tgsStart ?? p.tgsDue,
      // 스냅샷(tgsTime)이 없는 옛 이벤트는 **종일로 본다.** 이벤트의 모양에서 읽으면,
      // GCal 에서 사람이 지정해 둔 시각이 "우리가 마지막에 올린 값" 으로 둔갑해
      // 노트에 ⏰ 가 없다는 이유로 다음 push 가 그 시각을 지운다. 실제로 시각이 바뀐
      // 이벤트라면 pull 경로(remote.time + gcalChanged)가 노트에 ⏰ 를 써 넣는다.
      time: p.tgsTime ?? "",
      done: p.tgsDone === "1",
      title: p.tgsTitle ?? this.gcalTitleBase(ev),
      gcalUpdated: ev.updated,
    };
  }

  /** 우리가 이벤트를 올리는 캘린더 전부(기본 + 라우팅 규칙 + 기존 record). */
  private knownCalendarIds(): string[] {
    const ids = new Set<string>();
    if (this.settings.defaultCalendarId) ids.add(this.settings.defaultCalendarId);
    for (const r of this.settings.rules) if (r.calendarId) ids.add(r.calendarId);
    for (const rec of Object.values(this.state.records)) {
      if (rec.calendarId) ids.add(rec.calendarId);
    }
    return [...ids];
  }

  /**
   * records를 캘린더에서 재구성한다.
   *
   * records는 진실원천이 아니라 **캐시**다 — 매핑(tgsTaskId)도 스냅샷(tgsDue/tgsStart/
   * tgsDone/tgsTitle)도 이미 이벤트에 심겨 있다(privateProps). 그래서 캐시가 비었거나
   * 캘린더보다 좁아도 한 번 훑으면 그대로 복원된다. 이 스캔이 없으면 record를 잃은
   * 이벤트는 조정 루프(records만 순회)의 시야 밖으로 영구히 빠진다.
   *
   * @returns 이번에 새로 주운 id 집합. 호출부는 이 id들을 같은 run에서 삭제하지 않는다.
   */
  private async rebuildRecords(
    lookbackDays = 730,
    lookaheadDays = 730
  ): Promise<Set<string>> {
    const adopted = new Set<string>();
    const timeMin = isoDaysAgo(lookbackDays);
    const timeMax = isoDaysAgo(-lookaheadDays);
    let complete = true;
    for (const cal of this.knownCalendarIds()) {
      let items: GCalEvent[];
      try {
        ({ items } = await this.client.listEvents(cal, {
          singleEvents: "true",
          showDeleted: "false",
          maxResults: "2500",
          timeMin,
          timeMax,
        }));
      } catch (e) {
        console.warn("[tasks-gcal-sync] 재구성 스캔 실패:", cal, e);
        complete = false; // 한 캘린더라도 못 읽었으면 "훑었다" 고 기록하지 않는다
        continue;
      }
      for (const ev of items) {
        const tid = ev.extendedProperties?.private?.tgsTaskId;
        if (!tid || ev.status === "cancelled") continue;
        if (!this.isOurs(ev)) continue; // 다른 볼트의 이벤트 — 입양하면 지워버린다
        if (this.state.records[tid]) continue; // 이미 알고 있음
        const rec = this.recordFromEventOnly(ev, cal);
        if (!rec) continue;
        this.state.records[tid] = rec;
        adopted.add(tid);
      }
    }
    if (complete) this.state.lastFullScanAt = Date.now();
    if (adopted.size) {
      console.log(`[tasks-gcal-sync] records 재구성: ${adopted.size}건 복원`);
    }
    return adopted;
  }

  /**
   * 이 기기의 볼트가 뒤처져 있으면 true. Obsidian Sync 코어 플러그인의 상태를 읽는다
   * (비공식 API — 없거나 모양이 바뀌면 판단을 포기하고 false).
   *
   * 뒤처진 볼트에서 "task가 없다 → 이벤트 삭제"를 돌리면, 다른 기기가 방금 만든
   * task의 이벤트를 지운다. 확실히 동기화 중일 때만 삭제를 미룬다.
   */
  private vaultBehind(): boolean {
    try {
      const inst = (this.app as any).internalPlugins?.plugins?.sync?.instance;
      if (!inst) return false;
      // getStatus()는 표시용 문구(syncStatus: "Fully synced")가 아니라 토큰("synced")을
      // 준다. 판정 전에 먼저 읽어두는 이유는 **로그 때문**이다 — 어느 신호로 걸렸든
      // "Sync가 뭐라고 했는지"가 콘솔에 남아야 사후에 원인을 좁힐 수 있다.
      const raw =
        typeof inst.getStatus === "function" ? inst.getStatus() : inst.syncStatus;
      const say = (why: string) =>
        console.log(`[tasks-gcal-sync] Sync 진행 중(${why}):`, raw);
      if (inst.pause === true) {
        say("pause");
        return true;
      }
      // 불리언 신호가 문자열보다 직접적이다(실측: 인스턴스에 syncing/pause/error/ready가 있다).
      // `=== true`로만 받아 fail-open을 지킨다 — 필드가 없어지면 undefined라 통과한다.
      if (inst.syncing === true) {
        say("syncing");
        return true;
      }
      const s = String(raw ?? "").toLowerCase();
      if (!s) return false;
      // **fail-open**: "진행 중"이라고 확실히 읽힐 때만 true.
      // 반대로 "완료"를 인식하는 방식으로 짜면, 비공식 API의 문구가 바뀌거나 다른
      // 언어로 나올 때 영원히 true가 되어 pull과 삭제가 조용히 멈춘다.
      // 판단이 안 서면 통과시키고, 오삭제는 2단계 삭제 가드가 막는다.
      const busy =
        /syncing|synchronizing|uploading|downloading|pending|queued|동기화\s*중|업로드|다운로드/.test(
          s
        );
      if (busy) say("상태");
      return busy;
    } catch {
      return false;
    }
  }

  /**
   * vaultBehind 보류가 너무 오래 이어지면 포기하고 통과시킨다(**fail-open 상한**).
   *
   * `vaultBehind()`는 비공식 API의 상태에 기대고, Sync를 수동 일시정지해두면
   * `pause === true`가 영구히 참이다. 상한이 없으면 동기화가 조용히 영영 멈춘다.
   * 가드가 기능을 끄는 쪽으로 실패하면 안 된다 — 0.3.9→0.3.10에서 배운 것.
   *
   * 재는 것은 **run 횟수가 아니라 경과 시간**이다(BEHIND_MAX_MS 주석 참고).
   */
  private behindBudgetExceeded(): boolean {
    if (this.behindSince === null) this.behindSince = Date.now();
    const over = Date.now() - this.behindSince > BEHIND_MAX_MS;
    if (over) {
      console.warn(
        "[tasks-gcal-sync] 볼트 뒤처짐 판정이 계속됨 → 상한 초과, 이번 run은 통과시킴"
      );
    }
    return over;
  }

  /** skip 을 사유와 함께 센다. 합계(`skipped`)와 내역이 항상 같이 움직이게 한다. */
  private skip(r: SyncResult, kind: SkipKind): void {
    r.skipped++;
    r.skips[kind] = (r.skips[kind] ?? 0) + 1;
  }

  /** 실제로 터진 것. 콘솔에만 남기면 못 본다. */
  private fail(r: SyncResult, where: string, e: unknown): void {
    r.failures.push({
      where,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  /** calendarId → 사람이 읽을 이름. 설정 캐시에 없으면 id 그대로. */
  private calName(calendarId: string): string {
    return (
      this.settings.calendars.find((c) => c.id === calendarId)?.name ??
      calendarId
    );
  }

  /** 스냅샷 한 필드를 로그에 적을 문자열로. 빈 값도 "없음"으로 보이게 한다. */
  private fieldText(
    s: { due: string; start?: string; time?: string; done: boolean; title: string },
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
  private lastLineText(rec: SyncRecord): string {
    if (!rec.lastLine) return "";
    const where = rec.lastWhere ? ` @${rec.lastWhere}` : "";
    return ` · 마지막으로 본 줄${where}: \`${rec.lastLine.trim()}\``;
  }

  /** `due 2026-08-14→2026-08-16` 형태로 필드별 변화를 나열. */
  private diffText(
    before: { due: string; start?: string; time?: string; done: boolean; title: string },
    after: { due: string; start?: string; time?: string; done: boolean; title: string },
    fields: Field[]
  ): string {
    return fields
      .map((f) => `${f} ${this.fieldText(before, f)}→${this.fieldText(after, f)}`)
      .join(", ");
  }

  /** before(직전 스냅샷) 대비 after에서 실제로 값이 달라진 필드만 추린다. */
  private changedFields(
    before: { due: string; start?: string; time?: string; done: boolean; title: string },
    after: { due: string; start?: string; time?: string; done: boolean; title: string },
    fields: readonly Field[] = ["due", "start", "time", "done", "title"]
  ): Field[] {
    return fields.filter(
      (f) => this.fieldText(before, f) !== this.fieldText(after, f)
    );
  }

  private resetBehindBudget(): void {
    this.behindSince = null;
  }

  /**
   * 지금 push해도 되는가(콜드 스타트 잠금).
   *
   * 플러그인이 막 로드된 직후의 노트는 Obsidian Sync가 아직 내려쓰는 중일 수 있다.
   * 그 상태로 push하면 다른 기기의 최신 변경을 **낡은 로컬 상태로 덮어쓴다.**
   * "Sync 완료를 감지"하는 방법은 비공식 API뿐이고 fail-open이어야 하므로 순서를
   * 보장할 수 없다 → 대신 **첫 행동을 무해하게** 만든다: pull 한 사이클을 완주하고
   * 로드 후 최소 시간이 지나기 전까지 원격에 쓰지 않는다.
   */
  private pushArmed(): boolean {
    if (Date.now() - this.loadedAt < COLD_START_MS) return false;
    return this.pullCycleDone;
  }

  private buildEvent(t: VaultTask, id: string): GCalEvent {
    const timed = this.timedDates(t);
    const ev: GCalEvent = {
      summary: this.summary(t),
      description: this.noteBlock(id, t),
      // ⏰ 가 있으면 시간지정, 없으면 종일. 🛫 start가 있으면 거기서부터(다중일)
      ...(timed ?? {
        start: { date: this.spanStart(t) },
        end: { date: addDay(t.due!) },
      }),
      extendedProperties: { private: this.privateProps(id, t) },
    };
    const color = this.doneColor(t);
    if (color !== undefined) ev.colorId = color;
    return ev;
  }

  /** 기존 모든 record의 이벤트 설명(note)에 🆔 ID를 일괄 기록. */
  async backfillDescriptions(): Promise<{ ok: number; fail: number }> {
    let ok = 0;
    let fail = 0;
    for (const id of Object.keys(this.state.records)) {
      const rec = this.state.records[id];
      try {
        // 설명을 다시 쓰는 명령이므로 현재 값을 읽어 사용자 텍스트를 보존한다.
        const cur = await this.client.getEvent(rec.calendarId, rec.eventId);
        await this.client.patchEvent(rec.calendarId, rec.eventId, {
          description: this.mergeDescription(cur.description ?? "", id),
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
  async cleanupDuplicates(): Promise<{ removed: number; checked: number }> {
    const tasks = await this.repo.getTasks();
    let removed = 0;
    let checked = 0;
    for (const t of tasks) {
      if (!t.id || !t.due) continue;
      const target = resolveCalendar(t.tags, this.settings);
      if (!target) continue;
      let evs: GCalEvent[];
      try {
        // 다른 볼트의 이벤트는 "중복"이 아니다 — 지우면 남의 일정을 없앤다.
        evs = (await this.client.findByTaskId(target.id, t.id)).filter((e) =>
          this.isOurs(e)
        );
      } catch (e) {
        console.warn("[tasks-gcal-sync] 중복 조회 실패:", t.id, e);
        continue;
      }
      checked++;
      if (evs.length <= 1) continue;
      const rec = this.state.records[t.id];
      const keepId =
        rec && evs.some((e) => e.id === rec.eventId) ? rec.eventId : evs[0].id!;
      const keepEv = evs.find((e) => e.id === keepId);
      for (const e of evs) {
        if (e.id === keepId) continue;
        try {
          await this.client.deleteEvent(target.id, e.id!);
          removed++;
        } catch (err) {
          console.warn("[tasks-gcal-sync] 중복 삭제 실패:", e.id, err);
        }
      }
      this.state.records[t.id] = keepEv
        ? this.recordFromEvent(keepEv, target.id, t)
        : {
            eventId: keepId,
            calendarId: target.id,
            due: t.due,
            start: this.spanStart(t),
            done: t.checked,
            title: this.titleBase(t),
            gcalUpdated: undefined,
          };
    }
    await this.saveState();
    return { removed, checked };
  }

  /** 캘린더의 변경분/삭제를 syncToken 증분으로 가져옴. */
  private async pullCalendar(cal: string): Promise<CalPull> {
    const tokens = this.state.syncTokens;
    const base: Record<string, string> = {
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    };
    let res;
    try {
      const params = tokens[cal]
        ? { ...base, syncToken: tokens[cal] }
        : { ...base, timeMin: isoDaysAgo(30) };
      res = await this.client.listEvents(cal, params);
    } catch (e: any) {
      if (e?.gone) {
        delete tokens[cal];
        res = await this.client.listEvents(cal, { ...base, timeMin: isoDaysAgo(30) });
      } else throw e;
    }
    if (res.nextSyncToken) tokens[cal] = res.nextSyncToken;

    const byTaskId = new Map<string, GCalEvent>();
    const cancelledEventIds = new Set<string>();
    for (const ev of res.items) {
      if (ev.status === "cancelled") {
        if (ev.id) cancelledEventIds.add(ev.id);
        continue;
      }
      const tid = ev.extendedProperties?.private?.tgsTaskId;
      if (tid && this.isOurs(ev)) byTaskId.set(tid, ev);
    }
    return { byTaskId, cancelledEventIds };
  }

  /** 조정 판단에 넘길 노트 상태. due가 유효하지 않으면 별도 상태로 구분한다. */
  private taskState(task?: VaultTask): TaskState {
    if (!task) return { kind: "missing" };
    if (!isValidDate(task.due)) return { kind: "due-invalid" };
    return { kind: "ok", local: this.localView(task) };
  }

  private localView(t: VaultTask): LocalView {
    return {
      due: t.due!,
      start: this.spanStart(t),
      time: this.taskTime(t),
      done: t.checked,
      title: this.titleBase(t),
      hasStart: !!t.start,
      multiDay: this.isMultiDay(t),
    };
  }

  /** 이벤트를 판단에 쓸 순수 값으로 환원. 설정 의존(완료 판정·제목 접두사)은 여기서 끝난다. */
  private remoteView(ev?: GCalEvent): RemoteView | undefined {
    if (!ev) return undefined;
    const due = this.eventDueDate(ev); // 다중일 블록은 끝(배타적−1)
    return {
      updated: ev.updated,
      due,
      start: due ? this.eventStartDate(ev) ?? due : undefined,
      time: this.eventTimeRange(ev),
      title: this.gcalTitleBase(ev),
      stamp: this.eventStamp(ev),
    };
  }

  /**
   * 이벤트에 심긴 마지막 push 스냅샷(`tgs*`). **원격 변경이 사람의 GCal 편집인지
   * 메아리인지 가르는 유일한 근거**다 → RemoteView.stamp
   *
   * `tgsDue`가 없으면(우리가 올린 적 없는/아주 옛 이벤트) 통째로 undefined —
   * **판정 불가는 "사람이 편집했다"가 아니다.** 없는 키를 빈 문자열로 메우면 현재 값과
   * 무조건 달라 보여서 모든 메아리가 사람 편집으로 승격된다.
   */
  private eventStamp(ev: GCalEvent): RemoteView["stamp"] {
    const p = ev.extendedProperties?.private;
    if (!p?.tgsDue) return undefined;
    return {
      due: p.tgsDue,
      start: p.tgsStart ?? p.tgsDue,
      // 옛 이벤트는 이 키가 없다. "" 로 메우면 시각이 지정된 이벤트가 전부 사람 편집으로
      // 읽히므로 그대로 undefined 로 둬서 시각만 판정 불가로 남긴다.
      time: p.tgsTime,
      title: p.tgsTitle,
    };
  }

  /** 스냅샷 한 필드를 옮긴다. record(start가 optional)와 Snapshot 둘 다 대상이 된다. */
  private assignSnapshot(
    dst: {
      due: string;
      start?: string;
      time?: string;
      done: boolean;
      title: string;
    },
    f: Field,
    src: Snapshot
  ): void {
    if (f === "due") dst.due = src.due;
    else if (f === "start") dst.start = src.start;
    else if (f === "time") dst.time = src.time;
    else if (f === "done") dst.done = src.done;
    else dst.title = src.title;
  }

  /** 병합 결정을 실행한다: 노트에 pull 반영 → 필요하면 push → 스냅샷 갱신. */
  private async applyMerge(c: {
    plan: MergePlan;
    id: string;
    rec: SyncRecord;
    task: VaultTask;
    ev?: GCalEvent;
    result: SyncResult;
    coldHold: boolean;
    /** 이 기기는 GCal 에 쓰지 않는다(모바일 읽기 전용). */
    remoteReadOnly: boolean;
  }): Promise<void> {
    const { plan, id, rec, task } = c;
    const where = `${task.path}:${task.line + 1}`;
    // rec은 아래에서 갱신된다 → 로그에 "무엇이 무엇으로" 바뀌었는지 적으려면
    // 직전 스냅샷을 먼저 떠 둔다. 이게 양쪽 변경을 판정한 기준값이기도 하다.
    const before = {
      due: rec.due,
      start: rec.start,
      time: rec.time,
      done: rec.done,
      title: rec.title,
    };
    const fromCalendar = rec.calendarId;

    // ── 1) pull: GCal이 이긴 필드만 노트에 반영 ──
    // writer가 쓰기 후 task의 파싱 필드까지 갱신하므로, 아래 push는 병합된 값을 올린다.
    const applied: Field[] = [];
    const p = plan.pull;
    if (p.setDue !== undefined) {
      await this.writer.setDue(task, p.setDue);
      applied.push("due");
    }
    if (p.start) {
      if (p.start.write === "set") await this.writer.setStart(task, p.start.value);
      else if (p.start.write === "remove") await this.writer.removeStart(task);
      applied.push("start");
    }
    if (p.time) {
      if (p.time.value) await this.writer.setTime(task, p.time.value);
      else await this.writer.removeTime(task);
      applied.push("time");
    }
    if (p.title) {
      try {
        await this.writer.replaceTitle(task, p.title.from, p.title.to);
        applied.push("title");
      } catch (e) {
        console.warn("[tasks-gcal-sync] 제목 pull skip:", id, e);
      }
    }
    if (plan.conflicts.length) {
      console.warn(
        `[tasks-gcal-sync] 충돌 → 노트 채택, GCal은 메아리 (${plan.conflicts.join(
          ", "
        )}):`,
        where
      );
    }
    if (plan.gcalWins.length) {
      console.warn(
        `[tasks-gcal-sync] 충돌 → GCal 채택, 사람이 캘린더에서 편집함 (${plan.gcalWins.join(
          ", "
        )}):`,
        where
      );
    }
    if (applied.length) {
      c.result.pulled++;
      // 방금 노트에 써넣은 줄을 기억해 둔다. 이게 곧바로 옛 값으로 되돌아가면 그건
      // 사용자 편집이 아니라 되돌림이다 → run 의 되돌림 방어
      rec.pulledLine = task.raw;
      rec.pulledAt = Date.now();
    }

    if (plan.uncheckSeen === "set") rec.uncheckSeenAt = Date.now();
    else if (plan.uncheckSeen === "clear") delete rec.uncheckSeenAt;
    // 충돌이 실제로 해결됐다(또는 애초에 없었다) → 보류 시계를 끈다.
    if (plan.conflictHeldClear) delete rec.conflictHeldAt;
    // 이 record 를 실제로 판정했다 = 원격을 봤다. 재조회 표시를 끈다.
    delete rec.recheckRemote;
    if (plan.holdDone) {
      console.log(`[tasks-gcal-sync] 완료 해제 → 다음 사이클에 재확인: ${id}`);
    }
    if (plan.retryAfterMs !== undefined) {
      c.result.retryAfterMs = Math.min(
        c.result.retryAfterMs ?? plan.retryAfterMs,
        plan.retryAfterMs
      );
    }

    // ── 2) push: GCal이 가져가지 않은 Obsidian 변경, 또는 표현 정규화 ──
    const normalizeNeeded = plan.normalizeIfPulled && applied.length > 0;
    const canWriteRemote = !c.coldHold && !c.remoteReadOnly;

    const m: Snapshot = { ...plan.merged };
    // pull이 실패한 필드는 노트가 안 바뀌었으므로 스냅샷도 노트 현재값이다.
    for (const f of plan.pulledFields) {
      if (!applied.includes(f)) this.assignSnapshot(m, f, plan.local);
    }

    let pushed = false;
    let pushKind: "move" | "update" | "presentation" | null = null;
    let precondFailed = false;
    if ((plan.pushNeeded || normalizeNeeded) && canWriteRemote) {
      try {
      // done을 보류 중이면 완료 상태만 기존 값으로 고정해서 올린다 —
      // 안 그러면 날짜/제목 push에 미완료가 딸려가 보류가 무의미해진다.
      const pushTask = plan.holdDone ? { ...task, checked: rec.done } : task;
      m.due = task.due!;
      m.start = this.spanStart(task);
      m.time = this.taskTime(task);
      m.done = pushTask.checked;
      m.title = this.titleBase(task);

      const target = resolveCalendar(task.tags, this.settings);
      if (!plan.pushNeeded) {
        const updatedEv = await this.pushPresentation(rec, pushTask, id, c.ev);
        rec.gcalUpdated = updatedEv.updated;
        c.result.updated++;
        pushKind = "presentation";
      } else if (target && target.id !== rec.calendarId) {
        // 대상 캘린더 변경 → 이동
        try {
          await this.client.deleteEvent(rec.calendarId, rec.eventId);
        } catch (e) {
          console.warn("[tasks-gcal-sync] 이동 중 삭제 실패(무시):", e);
        }
        const newEv = await this.client.insertEvent(
          target.id,
          this.buildEvent(pushTask, id)
        );
        rec.eventId = newEv.id!;
        rec.calendarId = target.id;
        rec.gcalUpdated = newEv.updated; // 우리 push의 updated 저장 → 다음 pull에서 self-echo 제외
        c.result.moved++;
        pushKind = "move";
      } else {
        const updatedEv = await this.pushUpdate(
          rec,
          task,
          id,
          plan.holdDone ? rec.done : undefined,
          c.ev
        );
        rec.gcalUpdated = updatedEv.updated;
        c.result.updated++;
        pushKind = "update";
      }
      // 완료 해제가 실제로 GCal에 올라간 순간. 되돌리기 힘든 방향이라 조용히 넘기지 않는다 —
      // 노트에서 실수로 풀린 걸 이틀 뒤에 발견한 사고가 있었다(2026-08-09 CISS).
      if (rec.done && !pushTask.checked) {
        new Notice(`GCal 완료 해제: ${this.titleBase(task)}`, 8000);
        console.warn(`[tasks-gcal-sync] 완료 해제를 GCal에 반영: ${id} ${where}`);
      }
      pushed = true;
      } catch (e) {
        // **412 는 실패가 아니라 정보다.** pull 이후 사람이 캘린더를 또 고쳤다는 뜻이고,
        // 지금 우리가 든 값은 그 변경을 못 본 값이다. 덮지 않고 물러난다 — 스냅샷도
        // `rec.gcalUpdated` 도 그대로라 다음 run 이 새 상태로 처음부터 다시 판정한다.
        if (!(e instanceof PreconditionFailedError)) throw e;
        precondFailed = true;
        console.warn(
          `[tasks-gcal-sync] push 포기(412, pull 이후 GCal이 또 바뀜): ${id} ${where}`
        );
        this.skip(c.result, "push-precondition");
        c.result.entries.push({
          action: "SKIP",
          id,
          title: rec.title,
          calendar: this.calName(rec.calendarId),
          eventId: rec.eventId,
          where,
          detail: SKIP_TEXT["push-precondition"],
        });
      }
    } else if (plan.gcalChanged) {
      // push하지 않았으면 GCal의 현재 updated가 다음 비교 기준.
      rec.gcalUpdated = c.ev!.updated;
    }

    // ── 3) 스냅샷 갱신 ──
    // **올리지 못한 변경은 스냅샷에 기록하지 않는다.** 여기서 덮으면 "이미 반영됨"으로
    // 남아 그 변경이 영영 안 올라간다(보류·콜드 스타트·구조 변경 스킵).
    if (pushed || (!plan.pushNeeded && !normalizeNeeded)) {
      rec.due = m.due;
      rec.start = m.start;
      rec.time = m.time;
      rec.done = m.done;
      rec.title = m.title;
    } else if (plan.pushNeeded) {
      // 부분 반영: pull이 실제로 고친 필드만 기록한다.
      for (const f of applied) this.assignSnapshot(rec, f, m);
    }
    // normalizeNeeded인데 못 찍었으면 스냅샷을 그대로 둔다 →
    // 다음 사이클에 "로컬이 바뀐 것"으로 읽혀 push되고, 그때 표현이 맞춰진다.

    this.logMerge({
      plan,
      id,
      rec,
      task,
      before,
      fromCalendar,
      applied,
      pushKind,
      blockedByCold: (plan.pushNeeded || normalizeNeeded) && !canWriteRemote,
      precondFailed,
      ev: c.ev,
      result: c.result,
      where,
    });
  }

  /**
   * 병합 한 건이 실제로 무엇을 했는지 한 줄로 남긴다.
   *
   * 카운터(`~3`)로는 "무엇이 무엇으로 바뀌었는지"도, "무엇이 폐기됐는지"도 알 수 없다.
   * 특히 충돌은 한쪽 변경이 조용히 사라지는 유일한 경로라 근거를 남겨야 한다 —
   * 어느 필드가 겹쳤고, 노트/GCal이 각각 무엇으로 바꿨고, 무엇이 버려졌는지까지 적는다.
   */
  private logMerge(c: {
    plan: MergePlan;
    id: string;
    rec: SyncRecord;
    task: VaultTask;
    before: { due: string; start?: string; time?: string; done: boolean; title: string };
    fromCalendar: string;
    applied: Field[];
    pushKind: "move" | "update" | "presentation" | null;
    blockedByCold: boolean;
    /** If-Match 412 로 push 를 포기했는가(0.9.0~). */
    precondFailed: boolean;
    /** 판정에 쓴 원본 이벤트 — 충돌 로그에 tgs* 스탬프 대조를 함께 싣는다. */
    ev?: GCalEvent;
    result: SyncResult;
    where: string;
  }): void {
    const { plan, before, applied, pushKind } = c;
    const parts: string[] = [];

    // 1) 충돌 — 같은 필드를 양쪽에서 **다른 값으로** 바꾼 것. 한쪽 변경이 조용히 사라지는
    //    유일한 경로라 폐기된 값까지 적는다. 어느 쪽이 이기는지는 원격 변경이 **사람의 GCal
    //    편집**이었는지 **메아리**였는지로 갈린다 → reconcile.ts § 충돌 판정
    //    (양쪽이 같은 값이면 애초에 충돌이 아니므로 여기 오지 않는다)
    const conflictText = (f: Field) =>
      `${f}(노트 ${this.fieldText(before, f)}→${this.fieldText(
        plan.local,
        f
      )} / GCal ${this.fieldText(before, f)}→${this.fieldText(plan.remote, f)})`;
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
      parts.push(`⬇ 노트 반영: ${this.diffText(before, plan.merged, applied)}`);
    }
    const pullFailed = plan.pulledFields.filter((f) => !applied.includes(f));
    if (pullFailed.length) {
      parts.push(
        `⚠ 노트 반영 실패(값 유지): ${this.diffText(before, plan.merged, pullFailed)}`
      );
    }

    // 3) 노트 → GCal. GCal이 가져가지 않은 노트 변경만 올라간다.
    if (pushKind === "presentation") {
      parts.push("⬆ 이벤트 표현만 재적용(제목 접두사 등)");
    } else if (pushKind) {
      const pushedFields = this.changedFields(before, plan.local).filter(
        (f) => !plan.pulledFields.includes(f)
      );
      if (pushedFields.length) {
        parts.push(`⬆ GCal 반영: ${this.diffText(before, plan.local, pushedFields)}`);
      }
      if (pushKind === "move") {
        parts.push(
          `↔ 캘린더 이동: ${this.calName(c.fromCalendar)} → ${this.calName(
            c.rec.calendarId
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

    if (!parts.length) return; // 실제로 한 일이 없으면 남기지 않는다

    const action = pushKind === "move"
      ? "MOVE"
      : pushKind
      ? "UPDATE"
      : applied.length
      ? "PULL"
      : "HOLD";
    c.result.entries.push({
      action,
      id: c.id,
      title: plan.merged.title || plan.local.title,
      calendar: this.calName(c.rec.calendarId),
      eventId: c.rec.eventId,
      where: c.where,
      detail: parts.join(" | "),
    });
  }

  async run(
    opts: { pull?: boolean; fullScan?: boolean; force?: boolean } = {}
  ): Promise<SyncResult> {
    const empty: SyncResult = {
      created: 0,
      updated: 0,
      moved: 0,
      deleted: 0,
      pulled: 0,
      skipped: 0,
      skips: {},
      failures: [],
      entries: [],
    };

    // 볼트가 아직 동기화 중이면 **run 전체를 건너뛴다**(0.3.13~).
    // 예전엔 pull만 껐는데, 그러면 gc.* 판정이 전부 false가 되어 "로컬만 바뀜"으로
    // 결론나고 **낡은 로컬 상태가 그대로 GCal로 올라갔다** — 보호 장치를 끄면서
    // 파괴 경로는 열어두는 구조였다. 읽지 못할 때는 쓰지도 않는다.
    const behind = this.vaultBehind();
    // 정착 시계. 뒤처짐이 보이면 처음부터 다시 센다 — 조용한 순간이 아니라 **조용한
    // 구간**이어야 되돌리기 힘든 동작을 연다. 아래 early return 보다 먼저 갱신해야
    // 보류로 끝나는 run 도 시계를 리셋한다.
    if (behind) this.settledSince = null;
    else if (this.settledSince === null) this.settledSince = Date.now();
    const settledFor =
      this.settledSince === null ? 0 : Date.now() - this.settledSince;
    const vaultUnsettled = settledFor < SETTLE_MS;
    const overBudget = behind && this.behindBudgetExceeded();
    if (behind && !overBudget && !opts.force) {
      console.log("[tasks-gcal-sync] 볼트 동기화 중 → 이번 run 보류");
      // 보류만 하고 끝내면 Sync가 3초 뒤 정착해도 다음 트리거(주기 5분)까지 방치된다.
      // 호출부(main)가 이 값을 보고 재확인을 예약한다.
      const sec = Math.round(BEHIND_RECHECK_MS / 1000);
      return {
        ...empty,
        skipped: 1,
        skips: { "vault-behind": 1 },
        retryAfterMs: BEHIND_RECHECK_MS,
        entries: [
          {
            action: "SKIP",
            detail: `${SKIP_TEXT["vault-behind"]}(${sec}초 뒤 재확인)`,
          },
        ],
      };
    }
    if (!behind) this.resetBehindBudget();
    // 상한 초과 시엔 뒤처짐 판정을 무시하고 평소대로 돈다(fail-open).
    // 수동 실행(force)만 "뒤처진 채 강행"이므로 노트 쓰기/삭제는 계속 보류한다.
    const holdWrites = behind && !overBudget;
    if (holdWrites) {
      console.log("[tasks-gcal-sync] 볼트 동기화 중 강행 → 노트 쓰기/삭제 보류");
    }
    // 콜드 스타트 잠금: 로드 직후에는 원격에 아무것도 쓰지 않는다(pushArmed 주석 참고).
    const coldHold = !opts.force && !this.pushArmed();
    /**
     * 이 기기에서는 GCal 에 쓰지 않는다(모바일 읽기 전용).
     *
     * `coldHold` 와 달리 **시간이 지나도 안 풀리고 수동 실행도 우회하지 못한다.**
     * pull 은 그대로 돈다 — 모바일이 얻는 것(📆 일정 표시 · GCal 편집이 노트에 바로
     * 반영)은 전부 그쪽이고, 위험한 것은 전부 push 쪽이다 → Settings.mobileReadOnly
     */
    const remoteReadOnly = Platform.isMobile && this.settings.mobileReadOnly;
    if (remoteReadOnly) {
      console.log("[tasks-gcal-sync] 모바일 읽기 전용 → GCal 쓰기 없음(pull 만)");
    }
    if (coldHold) {
      console.log("[tasks-gcal-sync] 콜드 스타트 → 이번 run은 pull 전용");
    }
    // 동기화는 항상 양방향. opts.pull로만 끌 수 있고(내부 호출용), 뒤처진 볼트면 보류.
    const doPull = opts.pull !== false && !holdWrites;
    if (!this.settings.defaultCalendarId && this.settings.rules.length === 0) {
      throw new Error("설정에서 기본 캘린더 또는 라우팅 규칙을 먼저 지정하세요.");
    }

    const tasks = await this.repo.getTasks();
    const tasksById = new Map<string, VaultTask>();
    const existingIds = new Set<string>();
    // 같은 🆔가 두 줄 이상이면 병합이 덜 끝난 노트다(Sync가 블록을 중복시킨 경우 등).
    // 어느 줄이 정본인지 알 수 없으므로 그 id는 이번 run에서 통째로 건드리지 않는다 —
    // 임의의 줄에 쓰면 중복이 조용히 누적된다.
    const dupIds = new Set<string>();
    for (const t of tasks) {
      if (!t.id) continue;
      if (existingIds.has(t.id)) dupIds.add(t.id);
      tasksById.set(t.id, t);
      existingIds.add(t.id);
    }
    /** 중복 🆔의 위치 — 로그 파일에도 실어야 재시작 뒤에 찾을 수 있다. */
    const dupWhere = new Map<string, string>();
    for (const id of dupIds) {
      const where = tasks
        .filter((t) => t.id === id)
        .map((t) => `${t.path}:${t.line + 1}`)
        .join(", ");
      dupWhere.set(id, where);
      console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 → 건너뜀: ${where}`);
    }

    // ── 반복(🔁) 완료가 만든 🆔 중복은 **스스로 푼다**(0.9.5) ──
    //
    // Tasks 는 반복 task 를 완료하면 다음 회차 줄을 만들면서 **원본 🆔를 그대로 복사한다.**
    // 그러면 같은 id 가 두 줄이 되어 정본을 특정할 수 없고, 그 id 는 손으로 고칠 때까지
    // **영영 동기화가 멈춘다.** `TaskLine.removeId` 의 주석이 처음부터 이 경우를 위한
    // 것이라고 적고 있었지만 호출부가 없었다.
    //
    // 새 회차 줄에서 id 를 뗀다 — 기존 이벤트는 완료된 원래 회차의 것이고, 새 회차는
    // 다음 run 이 새 🆔 와 새 이벤트를 준다.
    //
    // ⛔ **모양이 정확히 이것일 때만 손댄다**: 두 줄뿐이고, 그중 **하나만 완료**이며,
    //    둘 다 반복(🔁)이다. Sync 가 블록을 통째로 복제한 경우는 두 줄의 완료 상태가
    //    같으므로 여기 걸리지 않는다 — 그때는 사람이 봐야 한다.
    //    노트 쓰기이므로 볼트가 정착한 뒤에만 한다.
    const dupRepairs: { id: string; where: string; why: string }[] = [];
    // 노트 쓰기라 정착 뒤에만 한다. 다만 **수동 실행은 연다** — 이 볼트처럼 정착이 잘
    // 안 잡히면 중복이 영영 안 풀리고, 그 사이 그 task 는 통째로 멈춘다(0.9.10).
    if ((!vaultUnsettled && !coldHold) || opts.force) {
      for (const id of [...dupIds]) {
        const lines = tasks.filter((t) => t.id === id);
        if (lines.length !== 2) continue;
        const rec = this.state.records[id];

        // (a) 반복(🔁) 완료가 만든 중복 — Tasks 가 새 회차 줄에 원본 id 를 복사한 경우.
        //     기존 이벤트는 완료된 원래 회차의 것이므로 **새 회차 줄**에서 id 를 뗀다.
        let victim: VaultTask | undefined;
        let why = "";
        const open = lines.filter((t) => !t.checked);
        const done = lines.filter((t) => t.checked);
        if (lines.every((t) => t.recurrence) && open.length === 1 && done.length === 1) {
          victim = open[0];
          why = "반복(🔁) 완료가 만든 중복 → 새 회차 줄에서 🆔 제거";
        }
        // (b) **서로 다른 task 가 같은 🆔** — 줄을 복사하며 🆔까지 딸려온 경우.
        //     record 가 마지막으로 동기화한 제목과 맞는 쪽이 원본이다. 정확히 한 쪽만
        //     맞을 때만 손댄다 — 둘 다 맞거나 둘 다 아니면 사람이 봐야 한다.
        else if (rec?.title) {
          const mine = lines.filter((t) => this.titleBase(t) === rec.title);
          if (mine.length === 1) {
            victim = lines.find((t) => t !== mine[0]);
            why = `서로 다른 task 가 같은 🆔 → 원본(제목 "${rec.title}")이 아닌 줄에서 🆔 제거`;
          }
        }
        if (!victim) continue;

        try {
          await this.writer.removeId(victim);
          dupIds.delete(id);
          const keep = lines.find((t) => t !== victim)!;
          tasksById.set(id, keep);
          const where = `${victim.path}:${victim.line + 1}`;
          dupRepairs.push({ id, where, why });
          console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 자동 정리: ${why} ${where}`);
        } catch (e) {
          console.warn("[tasks-gcal-sync] 🆔 중복 자동 정리 실패:", id, e);
        }
      }
    }

    const records = this.state.records;
    const today = todayStr();
    const result: SyncResult = {
      created: 0,
      updated: 0,
      moved: 0,
      deleted: 0,
      pulled: 0,
      skipped: 0,
      skips: {},
      failures: [],
      entries: [],
    };
    for (const r of dupRepairs) {
      result.entries.push({
        action: "REPAIR",
        id: r.id,
        where: r.where,
        detail: `${r.why}(다음 run이 새 🆔·이벤트를 준다)`,
      });
    }

    // ---- 0) records 재구성(캐시 복구) ----
    // 캐시가 비었으면 무조건, 그 외엔 시작 시 1회. 이걸 해야 record를 잃은 이벤트가
    // 조정 루프의 시야에 들어와 "task 없음 → 삭제"로 정리된다.
    // 전수 스캔은 캘린더마다 ±2년치를 페이지네이션한다. 캐시가 멀쩡한 평상시엔 낭비라
    // **하루 1회**로 제한한다. 목적은 고아 이벤트 회수이지 매번의 정합성 확인이 아니다.
    // (캐시가 비었으면 간격과 무관하게 돈다 — 그때는 스캔이 유일한 복구 경로다)
    const cacheEmpty = Object.keys(records).length === 0;
    const scanDue =
      Date.now() - (this.state.lastFullScanAt ?? 0) > FULL_SCAN_INTERVAL_MS;
    const adopted =
      opts.fullScan || cacheEmpty || scanDue
        ? await this.rebuildRecords()
        : new Set<string>();

    // ---- PULL: 우리가 record를 가진 캘린더들의 변경분 가져오기 ----
    const pullByCal = new Map<string, CalPull>();
    /**
     * 이번 run 에 **읽지 못한** 캘린더. 그 캘린더의 record 는 아래에서 통째로 건너뛴다.
     *
     * ⛔ **"이벤트가 안 왔다"를 근거로 삼으면 안 된다** — 증분 pull 은 변경된 이벤트만
     * 주므로 안 바뀐 이벤트는 원래 응답에 없다. 근거가 될 수 있는 것은 오직
     * **"이 캘린더를 읽는 데 실패했다"** 뿐이다.
     */
    const pullFailedCals = new Set<string>();
    let pullOk = doPull;
    if (doPull) {
      const calIds = new Set<string>();
      for (const id of Object.keys(records)) calIds.add(records[id].calendarId);
      for (const cal of calIds) {
        try {
          pullByCal.set(cal, await this.pullCalendar(cal));
        } catch (e) {
          console.error("[tasks-gcal-sync] pull 실패:", cal, e);
          this.fail(result, `pull ${cal}`, e);
          result.entries.push({
            action: "FAIL",
            calendar: this.calName(cal),
            detail: `캘린더를 읽지 못함 → 이 캘린더의 record 는 이번 run 에서 손대지 않는다: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
          pullFailedCals.add(cal);
          pullOk = false; // 한 캘린더라도 못 읽었으면 콜드 스타트 잠금을 풀지 않는다
        }
      }
    }

    // ---- 1) 기존 record 양방향 조정 ----
    // 판단은 전부 reconcile.ts의 순수 함수가 한다. 여기서는 그 결정을 실행만 한다.
    // vaultUnsettled 는 fail-open 상한도 순간 표본도 보지 않는다 — 뒤처짐이 풀린 뒤
    // SETTLE_MS 가 이어져야 참이 아니게 된다. 삭제·미일정화·충돌 해결·새 🆔 발급이
    // 전부 이 값을 본다 → reconcile.destructiveAllowed / conflictResolutionAllowed
    if (vaultUnsettled) {
      console.log(
        `[tasks-gcal-sync] 볼트 정착 대기(${Math.round(
          settledFor / 1000
        )}/${SETTLE_MS / 1000}초) → 삭제·충돌 해결·새 🆔 발급 보류`
      );
      result.retryAfterMs = Math.min(
        result.retryAfterMs ?? SETTLE_MS - settledFor + 2_000,
        SETTLE_MS - settledFor + 2_000
      );
    }
    const guards = new RunGuards({
      dupIds,
      adopted,
      holdWrites,
      vaultUnsettled,
      coldHold,
      remoteReadOnly,
    });

    for (const id of Object.keys(records)) {
      const rec = records[id];

      // **읽지 못한 캘린더에는 쓰지 않는다.** pull 이 실패하면 그 캘린더의 이벤트는
      // `remote = undefined` 로 들어와 `gcalChanged = false` 가 되고, 그러면 노트 변경만
      // 참이라 **원격을 못 본 채로 push 가 나간다** — 그 사이 사람이 GCal 에서 고쳐 뒀다면
      // 그대로 덮인다. `vaultBehind` 에만 걸어 두었던 *"읽지 못할 때는 쓰지도 않는다"* 를
      // 캘린더 단위에도 적용한다. 다음 run 이 같은 상태를 다시 본다(스냅샷 무변경).
      if (pullFailedCals.has(rec.calendarId)) {
        this.skip(result, "pull-failed");
        result.entries.push({
          action: "SKIP",
          id,
          title: rec.title,
          calendar: this.calName(rec.calendarId),
          eventId: rec.eventId,
          where: tasksById.get(id)
            ? `${tasksById.get(id)!.path}:${tasksById.get(id)!.line + 1}`
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
        try {
          const fetched = await this.client.getEvent(rec.calendarId, rec.eventId);
          if (fetched?.status === "cancelled") evCancelled = true;
          else if (fetched) ev = fetched;
        } catch (e) {
          // 404/410 = 이미 지워졌다. 그것도 관측이다(미일정화 경로가 받는다).
          if (/\b(404|410)\b/.test(e instanceof Error ? e.message : String(e))) {
            evCancelled = true;
          } else {
            console.warn("[tasks-gcal-sync] 보류 record 재조회 실패:", id, e);
          }
        }
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
          calendar: this.calName(rec.calendarId),
          eventId: rec.eventId,
          where: `${task.path}:${task.line + 1}`,
          detail:
            `※ 관측: ${sec}초 전 pull 로 쓴 줄이 달라졌다(GCal 은 그대로). ` +
            `사용자 편집이면 정상이고, 건드린 적이 없다면 되돌림이다 — ` +
            `쓴 줄 \`${rec.pulledLine}\` → 지금 \`${task.raw}\``,
        });
        console.warn(
          `[tasks-gcal-sync] pull 로 쓴 줄이 ${sec}초 만에 달라짐(되돌림 의심): ${id} ${task.path}:${task.line + 1}`
        );
        delete rec.pulledLine;
        delete rec.pulledAt;
        // **막지 않는다.** 아래 정상 판정으로 그대로 흘려보낸다.
      }

      // 줄이 보이는 동안 원문을 보관해 둔다. 지우는 시점에는 이미 노트에 없어서
      // "무엇을 지웠는지"를 로그에 남길 방법이 이것뿐이다.
      if (task) {
        rec.lastLine = task.raw;
        rec.lastWhere = `${task.path}:${task.line + 1}`;
      }

      try {
        const plan = decideReconcile({
          rec,
          task: this.taskState(task),
          remote: this.remoteView(ev),
          evCancelled,
          guards: guards.for(id),
          now: Date.now(),
          uncheckHoldMs: UNCHECK_HOLD_MS,
          conflictRetryMs: BEHIND_RECHECK_MS,
          // 사람이 누른 실행이면 충돌 보류를 우회한다 — "지금 맞춰라"가 곧 그 뜻이다.
          force: !!opts.force,
          conflictHoldMaxMs: CONFLICT_HOLD_MAX_MS,
        });

        if (plan.kind === "merge") {
          await this.applyMerge({
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

        const logWhere = task ? `${task.path}:${task.line + 1}` : undefined;
        switch (plan.kind) {
          case "skip": {
            this.skip(result, plan.reason);
            // 보류로 끝난 run은 그대로 두면 다음 주기(기본 5분)까지 방치된다.
            if (plan.retryAfterMs !== undefined) {
              result.retryAfterMs = Math.min(
                result.retryAfterMs ?? plan.retryAfterMs,
                plan.retryAfterMs
              );
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
                    `${f}(노트 ${this.fieldText(plan.local!, f)} / GCal ${this.fieldText(
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
              calendar: this.calName(rec.calendarId),
              eventId: rec.eventId,
              where: logWhere,
              detail,
            });
            break;
          }
          case "delete-event":
            await this.client.deleteEvent(rec.calendarId, rec.eventId);
            delete records[id];
            result.deleted++;
            result.entries.push({
              action: "DELETE",
              id,
              title: rec.title,
              calendar: this.calName(rec.calendarId),
              eventId: rec.eventId,
              where: logWhere,
              detail:
                (plan.reason === "task-gone"
                  ? `노트에서 task 줄이 사라짐 → 이벤트 삭제 (마지막 스냅샷 due=${rec.due}${
                      rec.time ? ` ${rec.time}` : ""
                    })`
                  : `task는 있으나 📅가 없음 → 이벤트 삭제 (마지막 스냅샷 due=${rec.due})`) +
                this.lastLineText(rec),
            });
            break;
          case "drop-record":
            delete records[id];
            result.entries.push({
              action: "DROP",
              id,
              title: rec.title,
              calendar: this.calName(rec.calendarId),
              eventId: rec.eventId,
              where: logWhere,
              detail:
                "GCal에서 이벤트가 삭제됨 + 완료된 줄 → 매핑만 폐기(📅는 기록이므로 유지)",
            });
            break;
          case "unschedule":
            await this.writer.unschedule(task!);
            delete records[id];
            result.pulled++;
            result.entries.push({
              action: "UNSCHEDULE",
              id,
              title: rec.title,
              calendar: this.calName(rec.calendarId),
              eventId: rec.eventId,
              where: logWhere,
              detail: `GCal에서 이벤트가 삭제됨 → 노트의 📅 ${rec.due} · 🆔 ${id} 제거(미일정화)`,
            });
            break;
        }
      } catch (e) {
        console.error("[tasks-gcal-sync] reconcile 실패:", id, e);
        this.skip(result, "reconcile-error");
        this.fail(result, id, e);
        result.entries.push({
          action: "FAIL",
          id,
          title: rec.title,
          calendar: this.calName(rec.calendarId),
          eventId: rec.eventId,
          where: task ? `${task.path}:${task.line + 1}` : undefined,
          detail: `조정 중 예외: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // ---- 2) record 없는 새 task → 생성 ----
    for (const t of tasks) {
      if (!isValidDate(t.due)) continue; // due 없음/형식오류 → 스킵(잘못된 이벤트 생성 방지)
      if (t.id && dupIds.has(t.id)) continue; // 🆔 중복 노트 → 정본 불명, 손대지 않음
      if (t.id && records[t.id]) continue; // 이미 처리됨

      const target = resolveCalendar(t.tags, this.settings);
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
        !t.checked && (t.due >= today || this.settings.includeOverdue);
      if (!inWindow) continue;

      // task에 이미 🆔가 있는데 로컬 record가 없음 → 다른 기기가 이미 만든 이벤트일 수 있음.
      // GCal에서 tgsTaskId로 조회해 있으면 입양(record 복원), 중복은 삭제, 없을 때만 새로 생성.
      // → records(data.json)가 기기 간 늦게 동기화돼도 중복이 안 생김.
      if (t.id) {
        try {
          const existing = (
            await this.client.findByTaskId(target.id, t.id)
          ).filter((e) => this.isOurs(e));
          if (existing.length > 0) {
            const [keep, ...dupes] = existing;
            // 이벤트에 심긴 스냅샷으로 복원 → 다음 sync에서 어느 쪽이 바뀌었는지 정확 판정.
            records[t.id] = this.recordFromEvent(keep, target.id, t);
            result.entries.push({
              action: "ADOPT",
              id: t.id,
              title: this.titleBase(t),
              calendar: target.name || target.id,
              eventId: keep.id,
              where: `${t.path}:${t.line + 1}`,
              detail:
                "GCal에 이미 있던 이벤트를 매핑으로 회수(다른 기기가 만든 것) — " +
                "새로 만들지 않음",
            });
            for (const d of dupes) {
              try {
                await this.client.deleteEvent(target.id, d.id!);
                result.deleted++;
                result.entries.push({
                  action: "DELETE",
                  id: t.id,
                  title: this.titleBase(t),
                  calendar: target.name || target.id,
                  eventId: d.id,
                  where: `${t.path}:${t.line + 1}`,
                  detail: `같은 🆔의 중복 이벤트 정리 (정본 ${keep.id} 유지)`,
                });
              } catch (e) {
                console.warn("[tasks-gcal-sync] 중복 삭제 실패:", d.id, e);
                result.entries.push({
                  action: "FAIL",
                  id: t.id,
                  calendar: target.name || target.id,
                  eventId: d.id,
                  detail: `중복 이벤트 삭제 실패: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
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
            title: this.titleBase(t),
            calendar: target.name || target.id,
            where: `${t.path}:${t.line + 1}`,
            detail: `기존 이벤트 조회 실패 → 새로 생성 진행(중복 가능): ${
              e instanceof Error ? e.message : String(e)
            }`,
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
        this.skip(result, "mobile-readonly");
        result.entries.push({
          action: "SKIP",
          id: t.id,
          title: this.titleBase(t),
          calendar: target.name || target.id,
          where: `${t.path}:${t.line + 1}`,
          detail: SKIP_TEXT["mobile-readonly"],
        });
        continue;
      }
      if (vaultUnsettled && !opts.force) {
        this.skip(result, "unsettled-create");
        result.entries.push({
          action: "HOLD",
          id: t.id,
          title: this.titleBase(t),
          calendar: target.name || target.id,
          where: `${t.path}:${t.line + 1}`,
          detail: SKIP_TEXT["unsettled-create"],
        });
        continue;
      }
      if (coldHold) {
        this.skip(result, "cold-start-create");
        result.entries.push({
          action: "HOLD",
          id: t.id,
          title: this.titleBase(t),
          calendar: target.name || target.id,
          where: `${t.path}:${t.line + 1}`,
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
          await this.writer.ensureId(t, id);
        } catch (e) {
          console.warn("[tasks-gcal-sync] ensureId 실패, skip:", t.path, e);
          this.skip(result, "ensure-id-failed");
          this.fail(result, t.path, e);
          result.entries.push({
            action: "SKIP",
            title: this.titleBase(t),
            calendar: target.name || target.id,
            where: `${t.path}:${t.line + 1}`,
            detail: `${SKIP_TEXT["ensure-id-failed"]}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
          continue;
        }
        existingIds.add(id);
        t.id = id;
        if (records[id]) continue;
      }

      try {
        const ev = await this.client.insertEvent(
          target.id,
          this.buildEvent(t, id)
        );
        records[id] = {
          eventId: ev.id!,
          calendarId: target.id,
          due: t.due,
          start: this.spanStart(t),
          // ⏰를 빠뜨리면 스냅샷이 "종일"로 남아, 바로 다음 run이 시간대를 바뀐 것으로
          // 읽고 불필요한 push를 한 번 더 한다(다른 복원 경로들은 이미 넣고 있다).
          time: this.taskTime(t),
          done: t.checked,
          title: this.titleBase(t),
          gcalUpdated: ev.updated,
        };
        result.created++;
        result.entries.push({
          action: "CREATE",
          id,
          title: this.titleBase(t),
          calendar: target.name || target.id,
          eventId: ev.id,
          where: `${t.path}:${t.line + 1}`,
          detail:
            `due=${t.due}` +
            (this.spanStart(t) !== t.due ? ` start=${this.spanStart(t)}` : "") +
            (this.taskTime(t) ? ` time=${this.taskTime(t)}` : " (종일)") +
            (t.checked ? " done=완료" : "") +
            (idWasNew ? " · 🆔를 새로 부여해 노트에 기록" : ""),
        });
      } catch (e) {
        console.error("[tasks-gcal-sync] 생성 실패:", t.path, e);
        this.skip(result, "create-failed");
        this.fail(result, t.path, e);
        result.entries.push({
          action: "FAIL",
          id,
          title: this.titleBase(t),
          calendar: target.name || target.id,
          where: `${t.path}:${t.line + 1}`,
          detail: `이벤트 생성 실패: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // pull을 예외 없이 끝냈으면 콜드 스타트 잠금을 푼다(시간 하한은 pushArmed가 따로 본다).
    if (pullOk) this.pullCycleDone = true;

    // 콜드 스타트로 GCal 쓰기를 미뤘고 이제 **시간만** 남았다면, 그 시점에 한 번 더 돈다.
    // 안 그러면 60초에 잠금이 풀려도 깨우는 사람이 없어 다음 주기(기본 5분)를 기다린다.
    // pullCycleDone이 아직 false면(=pull 실패) 예약하지 않는다 — 실패가 이어질 때
    // 2초 간격으로 되도는 것을 막는다. 그 경우는 기존 주기 동기화가 재시도한다.
    if (coldHold && this.pullCycleDone) {
      const left =
        Math.max(0, COLD_START_MS - (Date.now() - this.loadedAt)) + 2_000;
      result.retryAfterMs = Math.min(result.retryAfterMs ?? left, left);
    }

    await this.saveState();
    return result;
  }
}
