import { App } from "obsidian";
import { PluginSettings, resolveCalendar } from "../settings/Settings";
import { PersistedState, SyncRecord } from "./StateStore";
import { TaskRepository, VaultTask } from "../data/TaskRepository";
import { CalendarClient, GCalEvent } from "../gcal/CalendarClient";
import { TaskWriter } from "../write/TaskWriter";
import { CompletionHandler } from "../write/CompletionHandler";
import {
  addDay,
  addDays,
  daysBetween,
  fmt,
  genId,
  isoDaysAgo,
  isValidDate,
  shiftDateTime,
  todayStr,
} from "./dates";

export interface SyncResult {
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  pulled: number; // GCal → Obsidian 반영 건수
  skipped: number;
  /**
   * done 회귀 보류가 걸려 이 시간(ms) 뒤에 다시 돌면 반영될 것이 있다.
   * 없으면 undefined. 호출부(main)가 후속 run을 예약한다 — 안 그러면 체크 해제가
   * 다음 주기(기본 5분)까지 GCal에 안 올라가 "아무 변화가 없다"로 보인다.
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
/** vaultBehind가 계속 참일 때 보류를 포기하고 통과시키는 상한. */
const BEHIND_MAX_MS = 10 * 60_000;
const BEHIND_MAX_RUNS = 5;

export class SyncEngine {
  /** 플러그인 로드 시각. 콜드 스타트 판정 기준(인스턴스는 로드마다 새로 만들어진다). */
  private readonly loadedAt = Date.now();
  /** 알려진 캘린더 전부를 예외 없이 pull한 run이 한 번 끝났는가. */
  private pullCycleDone = false;
  private behindSince: number | null = null;
  private behindRuns = 0;

  constructor(
    private app: App,
    private settings: PluginSettings,
    private state: PersistedState,
    private repo: TaskRepository,
    private client: CalendarClient,
    private writer: TaskWriter,
    private completion: CompletionHandler,
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

  /** 완료 상태에 대응하는 transparency. free 완료 활성 시: 완료=transparent(한가함), 미완료=opaque(바쁨). 비활성 시 undefined(안 건드림). */
  private doneTransparency(t: VaultTask): string | undefined {
    if (!this.settings.doneOnFree) return undefined;
    return t.checked ? "transparent" : "opaque";
  }

  /**
   * GCal 이벤트가 "완료"인지 판정. 신호는 OR로 결합:
   *  1) free(한가함, transparency=transparent) — 아이폰 기본앱에서 색 대신 쓰는 완료 제스처
   *  2) 완료색(doneColorId) — 설정 시
   *  3) 위 둘 다 비활성일 때만 제목 접두사(☑️ / #done) 폴백
   */
  private isGcalDone(ev: GCalEvent): boolean {
    if (this.settings.doneOnFree && ev.transparency === "transparent")
      return true;
    if (this.settings.doneColorId)
      return ev.colorId === this.settings.doneColorId;
    const s = ev.summary ?? "";
    const done = this.settings.donePrefix?.trim();
    if (done && s.startsWith(done)) return true;
    return s.startsWith(this.settings.doneTag);
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

  /** GCal 이벤트 노트(설명): 볼트 이름 + task ID (+ 딥링크). */
  private noteText(id: string, t?: VaultTask): string {
    const base = `📁 ${this.app.vault.getName()}\n🆔 ${id}`;
    const link = t ? this.deepLink(t) : null;
    return link ? `${base}\n🔗 ${link}` : base;
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

  /**
   * 이벤트가 완료로 바뀐 날(로컬 YYYY-MM-DD). GCal엔 "완료 시각"이 없으므로
   * 마지막 수정 시각(updated = 사용자가 free/색으로 완료 표시한 시점)을 쓴다.
   *
   * 핵심은 정확도가 아니라 **결정성**이다. 이 값은 이벤트에 실려 있으므로 어느 기기가
   * 언제 pull해도 같은 ✅ 날짜가 나온다 → 기기 간 노트 텍스트가 갈리지 않는다.
   */
  private eventDoneDate(ev: GCalEvent | undefined): string | undefined {
    if (!ev?.updated) return undefined;
    const d = new Date(ev.updated);
    return isNaN(d.getTime()) ? undefined : fmt(d);
  }

  /** 이벤트에서 due(마감일) 추출: all-day는 end.date(배타적)−1, 시간지정은 end 날짜(없으면 start). */
  private eventDueDate(ev: GCalEvent): string | undefined {
    if (ev.end?.date) return addDays(ev.end.date, -1);
    if (ev.end?.dateTime) return ev.end.dateTime.slice(0, 10);
    return this.eventStartDate(ev);
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
  private presentationPatch(id: string, t: VaultTask): Partial<GCalEvent> {
    const patch: Partial<GCalEvent> = {
      summary: this.summary(t),
      description: this.noteText(id, t),
      // 마지막 push 스냅샷을 이벤트에 갱신 기록(기기 간 상태 복원용).
      extendedProperties: { private: this.privateProps(id, t) },
    };
    const color = this.doneColor(t);
    if (color !== undefined) patch.colorId = color; // 완료=완료색, 미완료=null(기본색 복귀)
    const transp = this.doneTransparency(t);
    if (transp !== undefined) patch.transparency = transp; // 완료=free, 미완료=busy
    return patch;
  }

  /**
   * 날짜는 건드리지 않고 표현만 다시 찍는다.
   *
   * GCal에서 free(한가함)로 완료하면 pull이 노트를 [x]로 만들지만, 그 완료가 이벤트의
   * 제목 접두사(☐→☑️)나 완료색에는 반영되지 않았다 — "GCal이 이긴 필드는 되돌려 쓰지
   * 않는다"는 규칙에 표현 갱신까지 딸려 들어갔기 때문. 캘린더에서는 여전히 미완료로 보였다.
   * 날짜를 안 보내므로 GCal이 방금 정한 일정을 되돌릴 위험이 없다.
   */
  private pushPresentation(
    rec: { calendarId: string; eventId: string },
    task: VaultTask,
    id: string
  ): Promise<GCalEvent> {
    return this.client.patchEvent(
      rec.calendarId,
      rec.eventId,
      this.presentationPatch(id, task)
    );
  }

  private async pushUpdate(
    rec: { calendarId: string; eventId: string; due: string; start?: string },
    task: VaultTask,
    id: string,
    doneOverride?: boolean
  ): Promise<GCalEvent> {
    // done 회귀를 보류한 채 다른 필드(날짜·제목)만 올리는 경우 — 완료 상태는 기존 값으로
    // 고정한다. 안 그러면 제목 push에 미완료가 딸려가 보류가 무의미해진다.
    const t = doneOverride === undefined ? task : { ...task, checked: doneOverride };
    const patch = this.presentationPatch(id, t);
    const startDate = this.spanStart(task);
    const dateChanged =
      task.due !== rec.due || startDate !== (rec.start ?? rec.due);
    if (dateChanged) {
      let cur: GCalEvent | undefined;
      try {
        cur = await this.client.getEvent(rec.calendarId, rec.eventId);
      } catch (e) {
        console.warn("[tasks-gcal-sync] getEvent 실패(종일로 처리):", e);
      }
      // 순수 timed 이벤트(양끝 모두 dateTime)일 때만 시각 유지하고 날짜만 이동.
      // 한쪽만 dateTime인 혼합형(예: iPhone 기본 캘린더가 만들 수 있음)을 그대로
      // patch하면 start=dateTime/end=date 타입 불일치로 GCal 400 → 종일로 정규화.
      if (cur?.start?.dateTime && cur?.end?.dateTime) {
        const oldDate = cur.start.dateTime.slice(0, 10);
        const delta = daysBetween(oldDate, task.due!);
        patch.start = {
          dateTime: shiftDateTime(cur.start.dateTime, delta),
          timeZone: cur.start.timeZone,
        };
        patch.end = {
          dateTime: shiftDateTime(cur.end.dateTime, delta),
          timeZone: cur.end.timeZone,
        };
      } else {
        patch.start = { date: startDate };
        patch.end = { date: addDay(task.due!) };
      }
    }
    return this.client.patchEvent(rec.calendarId, rec.eventId, patch);
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
    return {
      tgsTaskId: id,
      tgsSource: "tasks-gcal-sync",
      tgsVault: this.app.vault.getName(),
      tgsDue: t.due!,
      tgsStart: this.spanStart(t),
      tgsDone: t.checked ? "1" : "0",
      tgsTitle: this.titleBase(t),
    };
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
      done: p.tgsDone != null ? p.tgsDone === "1" : t.checked,
      title: p.tgsTitle ?? this.titleBase(t),
      gcalUpdated: ev.updated,
      // 이벤트에서 만든 기준선은 원격의 복사본이다 → 신뢰 불가(StateStore 주석 참고).
      baselineTrusted: false,
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
      done: p.tgsDone === "1",
      title: p.tgsTitle ?? this.gcalTitleBase(ev),
      gcalUpdated: ev.updated,
      baselineTrusted: false, // 위와 같은 이유
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
      if (inst.pause === true) return true;
      const raw =
        typeof inst.getStatus === "function" ? inst.getStatus() : inst.syncStatus;
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
      if (busy) console.log("[tasks-gcal-sync] Sync 진행 중:", raw);
      return busy;
    } catch {
      return false;
    }
  }

  /**
   * vaultBehind 보류가 너무 오래 이어지면 포기하고 통과시킨다(**fail-open 상한**).
   *
   * `vaultBehind()`는 비공식 API의 상태 문자열에 기대고, Sync를 수동 일시정지해두면
   * `pause === true`가 영구히 참이다. 상한이 없으면 동기화가 조용히 영영 멈춘다.
   * 가드가 기능을 끄는 쪽으로 실패하면 안 된다 — 0.3.9→0.3.10에서 배운 것.
   */
  private behindBudgetExceeded(): boolean {
    if (this.behindSince === null) {
      this.behindSince = Date.now();
      this.behindRuns = 0;
    }
    this.behindRuns++;
    const over =
      Date.now() - this.behindSince > BEHIND_MAX_MS ||
      this.behindRuns > BEHIND_MAX_RUNS;
    if (over) {
      console.warn(
        "[tasks-gcal-sync] 볼트 뒤처짐 판정이 계속됨 → 상한 초과, 이번 run은 통과시킴"
      );
    }
    return over;
  }

  private resetBehindBudget(): void {
    this.behindSince = null;
    this.behindRuns = 0;
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
    const ev: GCalEvent = {
      summary: this.summary(t),
      description: this.noteText(id, t),
      start: { date: this.spanStart(t) }, // 🛫 start가 있으면 거기서부터(다중일)
      end: { date: addDay(t.due!) },
      extendedProperties: { private: this.privateProps(id, t) },
    };
    const color = this.doneColor(t);
    if (color !== undefined) ev.colorId = color;
    const transp = this.doneTransparency(t);
    if (transp !== undefined) ev.transparency = transp;
    return ev;
  }

  /** 기존 모든 record의 이벤트 설명(note)에 🆔 ID를 일괄 기록. */
  async backfillDescriptions(): Promise<{ ok: number; fail: number }> {
    let ok = 0;
    let fail = 0;
    for (const id of Object.keys(this.state.records)) {
      const rec = this.state.records[id];
      try {
        await this.client.patchEvent(rec.calendarId, rec.eventId, {
          description: this.noteText(id),
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
    };

    // 볼트가 아직 동기화 중이면 **run 전체를 건너뛴다**(0.3.13~).
    // 예전엔 pull만 껐는데, 그러면 gc.* 판정이 전부 false가 되어 "로컬만 바뀜"으로
    // 결론나고 **낡은 로컬 상태가 그대로 GCal로 올라갔다** — 보호 장치를 끄면서
    // 파괴 경로는 열어두는 구조였다. 읽지 못할 때는 쓰지도 않는다.
    const behind = this.vaultBehind();
    const overBudget = behind && this.behindBudgetExceeded();
    if (behind && !overBudget && !opts.force) {
      console.log("[tasks-gcal-sync] 볼트 동기화 중 → 이번 run 보류");
      return { ...empty, skipped: 1 };
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
    for (const id of dupIds) {
      const where = tasks
        .filter((t) => t.id === id)
        .map((t) => `${t.path}:${t.line + 1}`)
        .join(", ");
      console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 → 건너뜀: ${where}`);
    }

    const records = this.state.records;
    const today = todayStr();
    // 반복 완료로 줄이 삽입(구조 변경)된 파일. 이 run에서 이후 task.line이 밀려
    // 형제 줄을 오손상시키지 않도록, 해당 파일의 추가 쓰기는 다음 사이클로 미룬다.
    const dirtyFiles = new Set<string>();
    const result: SyncResult = {
      created: 0,
      updated: 0,
      moved: 0,
      deleted: 0,
      pulled: 0,
      skipped: 0,
    };

    // ---- 0) records 재구성(캐시 복구) ----
    // 캐시가 비었으면 무조건, 그 외엔 시작 시 1회. 이걸 해야 record를 잃은 이벤트가
    // 조정 루프의 시야에 들어와 "task 없음 → 삭제"로 정리된다.
    const adopted =
      opts.fullScan || Object.keys(records).length === 0
        ? await this.rebuildRecords()
        : new Set<string>();

    // ---- PULL: 우리가 record를 가진 캘린더들의 변경분 가져오기 ----
    const pullByCal = new Map<string, CalPull>();
    let pullOk = doPull;
    if (doPull) {
      const calIds = new Set<string>();
      for (const id of Object.keys(records)) calIds.add(records[id].calendarId);
      for (const cal of calIds) {
        try {
          pullByCal.set(cal, await this.pullCalendar(cal));
        } catch (e) {
          console.error("[tasks-gcal-sync] pull 실패:", cal, e);
          pullOk = false; // 한 캘린더라도 못 읽었으면 콜드 스타트 잠금을 풀지 않는다
        }
      }
    }

    // ---- 1) 기존 record 양방향 조정 ----
    for (const id of Object.keys(records)) {
      const rec = records[id];
      const task = tasksById.get(id);
      const calData = pullByCal.get(rec.calendarId);
      const ev = calData?.byTaskId.get(id);
      const evCancelled = calData?.cancelledEventIds.has(rec.eventId) ?? false;

      try {
        // 🆔가 중복된 노트 → 정본을 특정할 수 없으니 읽지도 쓰지도 않는다.
        // (특히 아래 "task 없음 → 삭제"로 새지 않도록 이 검사가 먼저 와야 한다)
        if (dupIds.has(id)) {
          result.skipped++;
          continue;
        }
        // 같은 run에서 이 파일에 반복 회차가 삽입됨 → task.line이 밀려 오손상 위험.
        // 이 task의 반영은 스킵하고 다음 사이클(신규 read)에서 처리.
        if (task && dirtyFiles.has(task.path)) {
          result.skipped++;
          continue;
        }

        // Obsidian에서 task 사라짐 → 이벤트 삭제
        if (!task) {
          // 2단계 삭제: 이번 스캔에서 **처음 본** 이벤트는 지우지 않는다.
          // 볼트가 아직 안 따라잡았을 뿐일 수 있으므로, record만 남겨두고 다음
          // 사이클에 판단한다. 그때까지 task가 내려오면 정상 조정으로 흡수된다.
          // (동기화 진행 중이면 기존 record도 같은 이유로 보류)
          if (adopted.has(id) || holdWrites || coldHold) {
            result.skipped++;
            continue;
          }
          await this.client.deleteEvent(rec.calendarId, rec.eventId);
          delete records[id];
          result.deleted++;
          continue;
        }

        // task는 있으나 📅(due)를 잃음 → 미일정화(이벤트 제거, record 삭제).
        // due 없이 patch하면 addDay(undefined)=NaN 날짜로 GCal 400이 매 sync 반복됨.
        // (예: 템플릿이 due 없이 #task를 만들거나 사용자가 📅를 지운 경우)
        if (!isValidDate(task.due)) {
          // 다른 파괴적 경로와 같은 3종 가드. 볼트가 뒤처졌거나(holdWrites) 로드 직후이거나
          // (coldHold) 이번 스캔에서 처음 본 record면(adopted), 📅가 있는 줄이 아직 안
          // 내려왔을 뿐일 수 있다 — 그 상태로 지우면 남의 기기가 만든 일정을 없앤다.
          if (holdWrites || coldHold || adopted.has(id)) {
            result.skipped++;
            continue;
          }
          await this.client.deleteEvent(rec.calendarId, rec.eventId);
          delete records[id];
          result.deleted++;
          continue;
        }

        // GCal에서 이벤트 삭제됨 → task 미일정화(📅 제거)
        if (evCancelled) {
          // **완료된 줄의 📅는 기록이다.** 반복(🔁) task는 회차마다 별도 🆔·이벤트가
          // 쌓이므로 캘린더에서 지난 완료 이벤트를 정리하는 건 자연스러운 조작인데,
          // 그때마다 완료 회차의 due가 노트에서 지워졌다(2026-08-07). 완료 + 과거 due는
          // 아래 생성 루프의 inWindow에서 걸러지므로 record만 지워도 이벤트는 안 되살아난다.
          if (task.checked) {
            delete records[id];
            continue;
          }
          // 미완료 task만 실제로 미일정화한다. 단, 다른 파괴적 경로와 같은 가드를 건다 —
          // 볼트가 뒤처졌거나(holdWrites·coldHold) 이번 스캔에서 처음 본 record라면
          // 남의 기기가 만든 cancelled(중복정리·캘린더이동)를 근거로 지우는 것일 수 있다.
          if (holdWrites || coldHold || adopted.has(id)) {
            result.skipped++;
            continue;
          }
          await this.writer.removeDue(task);
          delete records[id];
          result.pulled++;
          continue;
        }

        const obsTitle = this.titleBase(task);
        const obsStart = this.spanStart(task);

        // ── 어느 쪽에서 무엇이 바뀌었나: 필드별로 판정한다 ──
        // 기준은 양쪽 모두 마지막 동기화 스냅샷(rec). 필드를 따로 보기 때문에
        // "Obsidian에서 ✅ + GCal에서 날짜 이동"처럼 겹치지 않는 변경은 둘 다 살아남는다.
        const obs = {
          due: task.due !== rec.due,
          start: obsStart !== (rec.start ?? rec.due),
          done: task.checked !== rec.done,
          title: obsTitle !== rec.title,
        };

        // GCal 외부 수정 감지: 증분 pull에 이벤트가 왔고 그 updated가
        // 우리가 마지막으로 본 값(rec.gcalUpdated)과 다름 → 우리 push가 아닌 사용자 수정.
        const gcalChanged =
          !!ev && !!ev.updated && ev.updated !== rec.gcalUpdated;

        // 이벤트를 손에 쥐었으면 완료 상태는 gcalChanged와 무관하게 읽을 수 있다.
        // (가짜 기준선 복구 판정에 쓴다 — 그때는 updated 비교가 무의미하다)
        const evDone = ev ? this.isGcalDone(ev) : undefined;

        const gcalDate = gcalChanged ? this.eventDueDate(ev!) : undefined; // 다중일 블록은 끝(배타적−1)
        const gcalStart = gcalChanged ? this.eventStartDate(ev!) : undefined;
        const gcalTitle = gcalChanged ? this.gcalTitleBase(ev!) : undefined;
        // 이벤트에서 날짜를 못 읽으면(파싱 실패·혼합형) 날짜 계열은 아예 손대지 않는다.
        // 예전엔 이 경우에도 else로 떨어져 task의 🛫를 근거 없이 지웠다.
        const datesOk = !!gcalDate;
        const gcalSpanStart = datesOk ? gcalStart ?? gcalDate : undefined;

        // ── 가짜 기준선 복구 ──
        // 이벤트에서 복원한 record는 baseline ≡ 원격이라 gcalChanged가 영원히 false다.
        // 그 상태에서 노트가 스테일하면(원격 완료 · 노트 미체크) "로컬이 체크를 풀었다"로
        // 읽혀 ✅가 GCal에서 지워진다 — 2026-08-06 롤백 사고의 실제 경로.
        // 신뢰 못 하는 기준선일 때는 원격의 **현재값을 노트와 직접** 비교하고,
        // 정보를 잃지 않는 방향(원격 완료 → 노트 복구)으로만 적용한다.
        const trusted = rec.baselineTrusted !== false;
        const staleUncheck = !trusted && evDone === true && !task.checked;
        if (staleUncheck) {
          console.warn(
            `[tasks-gcal-sync] 기준선 불신 + 원격 완료 → 노트 복구: ${id} (${task.path}:${
              task.line + 1
            })`
          );
        }

        const gc = {
          due: gcalChanged && datesOk && gcalDate !== rec.due,
          start:
            gcalChanged && datesOk && gcalSpanStart !== (rec.start ?? rec.due),
          done: (gcalChanged && evDone !== rec.done) || staleUncheck,
          title: gcalChanged && !!gcalTitle && gcalTitle !== rec.title,
        };

        // 같은 필드가 양쪽 다 바뀐 경우에만 승자가 필요하다 → GCal 채택(직접 조작한 화면).
        const conflicts: string[] = [];
        const takeGcal = (f: "due" | "start" | "done" | "title"): boolean => {
          if (!gc[f]) return false;
          if (obs[f]) conflicts.push(f);
          return true;
        };

        // 병합 결과(스냅샷 갱신용). 초기값 = Obsidian 현재 상태.
        let mDue = task.due!;
        let mStart = obsStart;
        let mDone = task.checked;
        let mTitle = obsTitle;

        // ── 1) pull: GCal이 이긴 필드만 노트에 반영 ──
        // writer가 쓰기 후 task의 파싱 필드까지 갱신하므로, 아래 push는 병합된 값을 올린다.
        let pulled = false;

        if (takeGcal("due")) {
          await this.writer.setDue(task, gcalDate!);
          mDue = gcalDate!;
          pulled = true;
        }
        if (takeGcal("start")) {
          if (gcalSpanStart! < mDue) await this.writer.setStart(task, gcalSpanStart!);
          else if (task.start) await this.writer.removeStart(task); // GCal이 단일일로 바꿈
          mStart = gcalSpanStart!;
          pulled = true;
        }
        if (takeGcal("title")) {
          try {
            await this.writer.replaceTitle(task, this.titleBase(task), gcalTitle!);
            mTitle = gcalTitle!;
            pulled = true;
          } catch (e) {
            console.warn("[tasks-gcal-sync] 제목 pull skip:", id, e);
          }
        }
        // 완료는 맨 마지막 — 반복 완료가 줄을 삽입해 구조를 바꿀 수 있다.
        if (takeGcal("done")) {
          if (evDone) {
            const structural = await this.completion.complete(
              task,
              this.writer,
              this.eventDoneDate(ev) ?? today
            );
            // 반복 회차가 삽입돼 줄이 늘면 이 파일의 이후 쓰기를 미룬다.
            if (structural) dirtyFiles.add(task.path);
          } else await this.completion.uncomplete(task, this.writer);
          mDone = !!evDone;
          pulled = true;
        }

        if (conflicts.length) {
          console.warn(
            `[tasks-gcal-sync] 충돌 → GCal 채택 (${conflicts.join(", ")}):`,
            `${task.path}:${task.line + 1}`
          );
        }
        if (pulled) result.pulled++;

        // ── done 회귀(완료 → 미완료) 보류 ──
        // 가장 파괴적인 push다. 노트가 최신이라는 확신이 없으면 미룬다. 두 겹:
        //  (a) 이번 run이 그 캘린더를 **실제로 읽지 못했으면** 무기한 보류.
        //      "이벤트 객체가 없다"가 아니라 "pull을 못 했다"가 기준이다 — 증분 pull에서
        //      변경 없는 이벤트는 원래 응답에 안 온다. 그걸 근거로 삼으면 정상적인
        //      체크 해제가 영영 안 올라간다.
        //  (b) 읽었더라도 **한 사이클 재확인**한다(2단계 삭제 가드와 같은 패턴).
        //      그 사이 Obsidian Sync가 정착하면 회귀 자체가 사라진다.
        const remoteUnknown = !doPull || !pullByCal.has(rec.calendarId);
        const doneRegress = obs.done && !task.checked && rec.done && !gc.done;
        let holdDone = false;
        if (doneRegress) {
          if (remoteUnknown) {
            holdDone = true;
            console.warn(`[tasks-gcal-sync] done 회귀 보류(원격 미확인): ${id}`);
          } else {
            if (rec.uncheckSeenAt === undefined) rec.uncheckSeenAt = Date.now();
            const waited = Date.now() - rec.uncheckSeenAt;
            holdDone = waited < UNCHECK_HOLD_MS;
            if (holdDone) {
              // 보류가 풀리는 시점에 한 번 더 돌도록 호출부에 알린다.
              const left = UNCHECK_HOLD_MS - waited + 2_000;
              result.retryAfterMs = Math.min(result.retryAfterMs ?? left, left);
              console.log(`[tasks-gcal-sync] done 회귀 → 다음 사이클에 재확인: ${id}`);
            }
          }
        } else if (rec.uncheckSeenAt !== undefined) {
          delete rec.uncheckSeenAt;
        }
        // 보류 중이면 병합 결과의 완료 상태도 예전 값이다 — 스냅샷에 미완료가 기록되면
        // 다음 run에서 "회귀 없음"으로 읽혀 보류가 그대로 무산된다.
        if (holdDone) mDone = rec.done;

        // ── 2) push: GCal이 가져가지 않은 Obsidian 변경이 남아 있으면 올린다 ──
        const pushNeeded =
          (obs.due && !gc.due) ||
          (obs.start && !gc.start) ||
          (obs.done && !gc.done && !holdDone) ||
          (obs.title && !gc.title);

        // GCal이 이긴 변경만 있어 push할 게 없더라도, **이벤트의 표현은 다시 찍는다.**
        // GCal에서 free(한가함)로 완료하면 노트는 [x]가 되는데 이벤트 제목은 ☐, 색은
        // 기본색 그대로여서 캘린더에서 미완료로 보였다. 날짜 없는 patch라 안전하다.
        //
        // 단 **사용자가 GCal에서 실제로 뭔가 바꾼 경우(gcalChanged)로 한정**한다.
        // 가짜 기준선 복구(staleUncheck)는 원격이 안 바뀐 상태에서 노트만 되살리는 것이라,
        // 거기서 원격에 쓰기 시작하면 "확신 없으면 원격을 건드리지 않는다"는 0.3.13의
        // 보장이 무너진다.
        const normalizeNeeded = !pushNeeded && pulled && gcalChanged;

        // 반복 완료로 줄이 밀린 파일은 이번 run에서 더 쓰지 않는다(다음 사이클에서 신규 read).
        const canWriteRemote = !dirtyFiles.has(task.path) && !coldHold;
        let pushed = false;
        if ((pushNeeded || normalizeNeeded) && canWriteRemote) {
          // done을 보류 중이면 완료 상태만 기존 값으로 고정해서 올린다 —
          // 안 그러면 날짜/제목 push에 미완료가 딸려가 보류가 무의미해진다.
          const pushTask = holdDone ? { ...task, checked: rec.done } : task;
          mDue = task.due!;
          mStart = this.spanStart(task);
          mDone = pushTask.checked;
          mTitle = this.titleBase(task);

          const target = resolveCalendar(task.tags, this.settings);
          if (!pushNeeded) {
            const updatedEv = await this.pushPresentation(rec, pushTask, id);
            rec.gcalUpdated = updatedEv.updated;
            result.updated++;
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
            result.moved++;
          } else {
            const updatedEv = await this.pushUpdate(
              rec,
              task,
              id,
              holdDone ? rec.done : undefined
            );
            rec.gcalUpdated = updatedEv.updated;
            result.updated++;
          }
          pushed = true;
        } else if (gcalChanged) {
          // push하지 않았으면 GCal의 현재 updated가 다음 비교 기준.
          rec.gcalUpdated = ev!.updated;
        }

        // ── 3) 스냅샷 갱신 ──
        // **올리지 못한 로컬 변경은 스냅샷에 기록하지 않는다.** 여기서 로컬 값으로 덮으면
        // "이미 반영됨"으로 남아 그 변경이 영영 안 올라간다(보류·콜드 스타트·구조 변경 스킵).
        if (pushed || (!pushNeeded && !normalizeNeeded)) {
          rec.due = mDue;
          rec.start = mStart;
          rec.done = mDone;
          rec.title = mTitle;
        } else if (pushNeeded) {
          // 부분 반영: pull이 실제로 고친 필드만 기록한다.
          if (gc.due) rec.due = mDue;
          if (gc.start) rec.start = mStart;
          if (gc.done) rec.done = mDone;
          if (gc.title) rec.title = mTitle;
        }
        // normalizeNeeded인데 못 찍었으면(구조 변경·콜드 스타트) 스냅샷을 그대로 둔다 →
        // 다음 사이클에 "로컬이 바뀐 것"으로 읽혀 push되고, 그때 표현이 맞춰진다.
        // 원격을 실제로 본 run에서만 기준선을 승격한다.
        if (ev) rec.baselineTrusted = true;
      } catch (e) {
        console.error("[tasks-gcal-sync] reconcile 실패:", id, e);
        result.skipped++;
      }
    }

    // ---- 2) record 없는 새 task → 생성 ----
    for (const t of tasks) {
      if (!isValidDate(t.due)) continue; // due 없음/형식오류 → 스킵(잘못된 이벤트 생성 방지)
      if (t.id && dupIds.has(t.id)) continue; // 🆔 중복 노트 → 정본 불명, 손대지 않음
      if (t.id && records[t.id]) continue; // 이미 처리됨
      // 이번 run에 구조 변경(반복 회차 삽입)된 파일 → 캐시된 line이 밀렸으므로
      // 새 회차 이벤트 생성은 다음 사이클(신규 read)로 미룬다.
      if (dirtyFiles.has(t.path)) continue;

      const target = resolveCalendar(t.tags, this.settings);
      if (!target) continue;
      const inWindow =
        t.due >= today || (this.settings.includeOverdue && !t.checked);
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
            for (const d of dupes) {
              try {
                await this.client.deleteEvent(target.id, d.id!);
                result.deleted++;
              } catch (e) {
                console.warn("[tasks-gcal-sync] 중복 삭제 실패:", d.id, e);
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
        }
      }

      // 콜드 스타트에는 새 이벤트를 만들지 않는다. 노트가 아직 안 내려왔을 뿐인데
      // 만들면 다른 기기가 이미 만든 것과 겹치거나, 곧 사라질 task의 이벤트가 남는다.
      if (coldHold) {
        result.skipped++;
        continue;
      }

      let id = t.id;
      if (!id) {
        // 후보군에 records의 id도 넣는다. existingIds는 이번 run에 파싱된 task의 🆔뿐이라,
        // 파일이 아직 안 내려온 기기에서는 records에만 남은 id가 그대로 재발급될 수 있다.
        id = genId(new Set([...existingIds, ...Object.keys(records)]));
        try {
          await this.writer.ensureId(t, id);
        } catch (e) {
          console.warn("[tasks-gcal-sync] ensureId 실패, skip:", t.path, e);
          result.skipped++;
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
          done: t.checked,
          title: this.titleBase(t),
          gcalUpdated: ev.updated,
        };
        result.created++;
      } catch (e) {
        console.error("[tasks-gcal-sync] 생성 실패:", t.path, e);
        result.skipped++;
      }
    }

    // pull을 예외 없이 끝냈으면 콜드 스타트 잠금을 푼다(시간 하한은 pushArmed가 따로 본다).
    if (pullOk) this.pullCycleDone = true;

    await this.saveState();
    return result;
  }
}
