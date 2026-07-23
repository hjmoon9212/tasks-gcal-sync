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
  genId,
  isoDaysAgo,
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
}

interface CalPull {
  byTaskId: Map<string, GCalEvent>;
  cancelledEventIds: Set<string>;
}

/**
 * 양방향 동기화 엔진.
 *  Push (Obsidian → GCal): 📅 task → 종일 이벤트(태그→캘린더 라우팅), 완료 시 #done prefix.
 *  Pull (GCal → Obsidian): syncToken 증분으로 날짜이동/#done/삭제를 감지해 반영.
 *  충돌(양쪽 변경): GCal 우선(사용자 조작 화면).
 *  매핑 스냅샷(records)으로 어느 쪽이 바뀌었는지 판정.
 */
export class SyncEngine {
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
  private async pushUpdate(
    rec: { calendarId: string; eventId: string; due: string; start?: string },
    task: VaultTask,
    id: string
  ): Promise<GCalEvent> {
    const patch: Partial<GCalEvent> = {
      summary: this.summary(task),
      description: this.noteText(id, task),
      // 마지막 push 스냅샷을 이벤트에 갱신 기록(기기 간 상태 복원용).
      extendedProperties: { private: this.privateProps(id, task) },
    };
    const color = this.doneColor(task);
    if (color !== undefined) patch.colorId = color; // 완료=완료색, 미완료=null(기본색 복귀)
    const transp = this.doneTransparency(task);
    if (transp !== undefined) patch.transparency = transp; // 완료=free, 미완료=busy
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
      if (cur?.start?.dateTime) {
        const oldDate = cur.start.dateTime.slice(0, 10);
        const delta = daysBetween(oldDate, task.due!);
        patch.start = {
          dateTime: shiftDateTime(cur.start.dateTime, delta),
          timeZone: cur.start.timeZone,
        };
        patch.end = cur.end?.dateTime
          ? {
              dateTime: shiftDateTime(cur.end.dateTime, delta),
              timeZone: cur.end.timeZone,
            }
          : { date: addDay(task.due!) };
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
    };
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
        evs = await this.client.findByTaskId(target.id, t.id);
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
      if (tid) byTaskId.set(tid, ev);
    }
    return { byTaskId, cancelledEventIds };
  }

  async run(opts: { pull?: boolean } = {}): Promise<SyncResult> {
    // pushOnly면 항상 단방향(Obsidian→GCal). 아니면 opts.pull로 제어(편집 자동 push는 pull:false).
    const doPull = !this.settings.pushOnly && opts.pull !== false;
    if (!this.settings.defaultCalendarId && this.settings.rules.length === 0) {
      throw new Error("설정에서 기본 캘린더 또는 라우팅 규칙을 먼저 지정하세요.");
    }

    const tasks = await this.repo.getTasks();
    const tasksById = new Map<string, VaultTask>();
    const existingIds = new Set<string>();
    for (const t of tasks) {
      if (t.id) {
        tasksById.set(t.id, t);
        existingIds.add(t.id);
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
    };

    // ---- PULL: 우리가 record를 가진 캘린더들의 변경분 가져오기 ----
    const pulled = new Map<string, CalPull>();
    if (doPull) {
      const calIds = new Set<string>();
      for (const id of Object.keys(records)) calIds.add(records[id].calendarId);
      for (const cal of calIds) {
        try {
          pulled.set(cal, await this.pullCalendar(cal));
        } catch (e) {
          console.error("[tasks-gcal-sync] pull 실패:", cal, e);
        }
      }
    }

    // ---- 1) 기존 record 양방향 조정 ----
    for (const id of Object.keys(records)) {
      const rec = records[id];
      const task = tasksById.get(id);
      const calData = pulled.get(rec.calendarId);
      const ev = calData?.byTaskId.get(id);
      const evCancelled = calData?.cancelledEventIds.has(rec.eventId) ?? false;

      try {
        // Obsidian에서 task 사라짐 → 이벤트 삭제
        if (!task) {
          await this.client.deleteEvent(rec.calendarId, rec.eventId);
          delete records[id];
          result.deleted++;
          continue;
        }

        // GCal에서 이벤트 삭제됨 → task 미일정화(📅 제거)
        if (evCancelled) {
          await this.writer.removeDue(task);
          delete records[id];
          result.pulled++;
          continue;
        }

        const obsTitle = this.titleBase(task);
        const obsStart = this.spanStart(task);
        const obsChanged =
          task.due !== rec.due ||
          obsStart !== (rec.start ?? rec.due) ||
          task.checked !== rec.done ||
          obsTitle !== rec.title;

        // GCal 외부 수정 감지: 증분 pull에 이벤트가 왔고 그 updated가
        // 우리가 마지막으로 본 값(rec.gcalUpdated)과 다름 → 우리 push가 아닌 사용자 수정.
        const gcalChanged =
          !!ev && !!ev.updated && ev.updated !== rec.gcalUpdated;

        // 충돌(양쪽 변경): 최근 수정이 이김(LWW) — 파일 mtime vs GCal updated 비교.
        let preferGcal = gcalChanged;
        if (gcalChanged && obsChanged) {
          const mtime = this.repo.getFile(task.path)?.stat.mtime ?? 0;
          const gcalMs = Date.parse(ev!.updated!);
          preferGcal = gcalMs >= mtime; // GCal이 더 최근이면 GCal 채택
        }

        if (gcalChanged && preferGcal) {
          // GCal → Obsidian 반영
          const gcalDate = this.eventDueDate(ev!); // 다중일 블록은 끝(배타적−1)이 due
          const gcalStart = this.eventStartDate(ev!); // 다중일 블록의 시작(🛫)
          const gcalDone = this.isGcalDone(ev!); // 완료색(회색) 또는 제목 #done 폴백
          const gcalTitle = this.gcalTitleBase(ev!);

          // 마감일
          if (gcalDate && gcalDate !== task.due) {
            await this.writer.setDue(task, gcalDate);
          }
          // 🛫 start: 시작<마감이면 그 날짜로, 같으면(단일일) 기존 🛫 제거
          if (gcalStart && gcalDate && gcalStart < gcalDate) {
            if (gcalStart !== task.start)
              await this.writer.setStart(task, gcalStart);
          } else if (task.start) {
            await this.writer.removeStart(task);
          }
          // 제목(접두사 제거한 순수 제목이 다르면 본문 제목만 교체; 모호하면 내부 skip)
          let newTitle = this.titleBase(task);
          if (gcalTitle && gcalTitle !== newTitle) {
            try {
              await this.writer.replaceTitle(task, newTitle, gcalTitle);
              newTitle = gcalTitle;
            } catch (e) {
              console.warn("[tasks-gcal-sync] 제목 pull skip:", id, e);
            }
          }
          // 완료
          if (gcalDone !== task.checked) {
            if (gcalDone)
              await this.completion.complete(task, this.writer, today);
            else await this.completion.uncomplete(task, this.writer);
          }
          rec.due = gcalDate ?? rec.due;
          rec.start = gcalStart ?? rec.start;
          rec.done = gcalDone;
          rec.title = newTitle;
          rec.gcalUpdated = ev!.updated;
          result.pulled++;
          continue;
        }

        // GCal 변경 없음(또는 Obsidian이 더 최근) → Obsidian 변경분 push
        if (obsChanged) {
          const target = resolveCalendar(task.tags, this.settings);
          if (target && target.id !== rec.calendarId) {
            // 대상 캘린더 변경 → 이동
            try {
              await this.client.deleteEvent(rec.calendarId, rec.eventId);
            } catch (e) {
              console.warn("[tasks-gcal-sync] 이동 중 삭제 실패(무시):", e);
            }
            const newEv = await this.client.insertEvent(
              target.id,
              this.buildEvent(task, id)
            );
            rec.eventId = newEv.id!;
            rec.calendarId = target.id;
            rec.due = task.due!;
            rec.start = obsStart;
            rec.done = task.checked;
            rec.title = obsTitle;
            rec.gcalUpdated = newEv.updated; // 우리 push의 updated 저장 → 다음 pull에서 self-echo 제외
            result.moved++;
          } else {
            const updatedEv = await this.pushUpdate(rec, task, id);
            rec.due = task.due!;
            rec.start = obsStart;
            rec.done = task.checked;
            rec.title = obsTitle;
            rec.gcalUpdated = updatedEv.updated;
            result.updated++;
          }
        } else if (gcalChanged) {
          // GCal이 바뀌었지만 채택 안 함(거의 없음) → 다음 비교 기준만 갱신.
          rec.gcalUpdated = ev!.updated;
        }
      } catch (e) {
        console.error("[tasks-gcal-sync] reconcile 실패:", id, e);
        result.skipped++;
      }
    }

    // ---- 2) record 없는 새 task → 생성 ----
    for (const t of tasks) {
      if (!t.due) continue;
      if (t.id && records[t.id]) continue; // 이미 처리됨

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
          const existing = await this.client.findByTaskId(target.id, t.id);
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

      let id = t.id;
      if (!id) {
        id = genId(existingIds);
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

    await this.saveState();
    return result;
  }
}
