import { App, Platform } from "obsidian";
import { PluginSettings, resolveCalendar } from "../settings/Settings";
import { PersistedState } from "./StateStore";
import { TaskRepository, VaultTask, taskWhere } from "../data/TaskRepository";
import { CalendarClient, GCalEvent } from "../gcal/CalendarClient";
import { TaskWriter } from "../write/TaskWriter";
import {
  SkipKind,
  SyncResult,
  addFailure,
  countSkip,
  emptyResult,
  mergeRetry,
} from "./engine/result";
import { SKIP_TEXT } from "./engine/skipText";
import { VaultGuard } from "./engine/vaultGuard";
import { EventPusher } from "./engine/pusher";
import { CalPull, CalendarPuller } from "./engine/puller";
import { MergeDeps, applyMerge } from "./engine/applyMerge";
import {
  BEHIND_RECHECK_MS,
  CONFLICT_HOLD_MAX_MS,
  FULL_SCAN_INTERVAL_MS,
  REVERT_WINDOW_MS,
  SETTLE_MS,
  UNCHECK_HOLD_MS,
} from "./engine/constants";
import { calName, fieldText, lastLineText } from "./engine/logText";
import { errMsg } from "../util/errors";
import { CodecCtx } from "./codec/ctx";
import { buildEvent } from "./codec/payload";
import { mergeDescription, titleBase } from "./codec/presentation";
import { isOurs, recordFromEvent, remoteView, taskState } from "./codec/stamp";
import { spanStart, taskTime } from "./codec/timeMapping";
import { decideReconcile, RunGuards } from "./reconcile";
import { genId, isValidDate, todayStr } from "./dates";

// 타입은 engine/result.ts 로 옮겼다(0.12.2) — 기존 import 경로(main·테스트)를 위해 다시 내보낸다.
export type { SkipKind, SyncFailure, SyncResult } from "./engine/result";

/**
 * 양방향 동기화 엔진.
 *  Push (Obsidian → GCal): 📅 task → 종일 이벤트(태그→캘린더 라우팅), 완료 시 #done prefix.
 *  Pull (GCal → Obsidian): syncToken 증분으로 날짜이동/#done/삭제를 감지해 반영.
 *  충돌: 필드(due/start/done/title) 단위로 병합한다. 한쪽에서만 바뀐 필드는 그대로 살리고,
 *        같은 필드가 양쪽에서 바뀐 경우에만 GCal을 채택(직접 조작한 화면)하고 warn을 남긴다.
 *  매핑 스냅샷(records)으로 어느 쪽 어느 필드가 바뀌었는지 판정.
 */
export class SyncEngine {
  /** 볼트 뒤처짐 · 정착 · 콜드 스타트 시계(0.12.5 에서 VaultGuard 로 옮겼다). */
  private readonly guard = new VaultGuard(() => this.app);

  // ⚠️ 임시 접근자 — 기존 테스트가 엔진의 옛 필드 이름으로 시계를 조작한다. 0.12.10 에서 걷어낸다.
  private get loadedAt(): number {
    return this.guard.loadedAt;
  }
  private set loadedAt(v: number) {
    this.guard.loadedAt = v;
  }
  private get pullCycleDone(): boolean {
    return this.guard.pullCycleDone;
  }
  private set pullCycleDone(v: boolean) {
    this.guard.pullCycleDone = v;
  }
  private get behindSince(): number | null {
    return this.guard.behindSince;
  }
  private set behindSince(v: number | null) {
    this.guard.behindSince = v;
  }
  private get settledSince(): number | null {
    return this.guard.settledSince;
  }
  private set settledSince(v: number | null) {
    this.guard.settledSince = v;
  }

  constructor(
    private app: App,
    private settings: PluginSettings,
    private state: PersistedState,
    private repo: TaskRepository,
    private client: CalendarClient,
    private writer: TaskWriter,
    private saveState: () => Promise<void>
  ) {
    this.codec = {
      settings: this.settings,
      vaultName: () => this.app.vault.getName(),
    };
    this.puller = new CalendarPuller(this.client, this.codec, this.state, this.settings);
    const pusher = new EventPusher(this.client, this.codec);
    this.mergeDeps = {
      settings: this.settings,
      codec: this.codec,
      client: this.client,
      writer: this.writer,
      pusher,
    };
  }

  /**
   * 코덱(표현·스탬프·시각 매핑)이 보는 것. settings 는 **원본 참조**, 볼트 이름은 **매번 읽는다** —
   * 테스트가 app 을 바꿔 끼우거나 설정 탭이 값을 제자리에서 고쳐도 다음 호출에 반영된다.
   */
  private readonly codec: CodecCtx;
  /** GCal 에서 읽는 쪽 — 증분 pull · 전수 스캔 · 보류 record 재조회. */
  private readonly puller: CalendarPuller;
  /** applyMerge 가 쓰는 의존성 묶음(공유 참조). */
  private readonly mergeDeps: MergeDeps;

  /** skip 을 사유와 함께 센다. 합계(`skipped`)와 내역이 항상 같이 움직이게 한다. */
  private skip(r: SyncResult, kind: SkipKind): void {
    countSkip(r, kind);
  }

  /** 실제로 터진 것. 콘솔에만 남기면 못 본다. */
  private fail(r: SyncResult, where: string, e: unknown): void {
    addFailure(r, where, e);
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
          description: mergeDescription(this.codec, cur.description ?? "", id),
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
          isOurs(this.codec, e)
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
        ? recordFromEvent(keepEv, target.id, t)
        : {
            eventId: keepId,
            calendarId: target.id,
            due: t.due,
            start: spanStart(t),
            done: t.checked,
            title: titleBase(t),
            gcalUpdated: undefined,
          };
    }
    await this.saveState();
    return { removed, checked };
  }

  async run(
    opts: { pull?: boolean; fullScan?: boolean; force?: boolean } = {}
  ): Promise<SyncResult> {
    const empty = emptyResult();

    // 볼트가 아직 동기화 중이면 **run 전체를 건너뛴다**(0.3.13~).
    // 예전엔 pull만 껐는데, 그러면 gc.* 판정이 전부 false가 되어 "로컬만 바뀜"으로
    // 결론나고 **낡은 로컬 상태가 그대로 GCal로 올라갔다** — 보호 장치를 끄면서
    // 파괴 경로는 열어두는 구조였다. 읽지 못할 때는 쓰지도 않는다.
    // 판정 순서(뒤처짐 → 정착 시계 → 예산)는 VaultGuard.observe 가 지킨다 — 정착 시계는
    // early return 보다 먼저 갱신돼야 보류로 끝나는 run 도 시계를 리셋한다.
    const { settledFor, vaultUnsettled, holdWrites, earlyReturn } =
      this.guard.observe(!!opts.force);
    if (earlyReturn) {
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
    // 상한 초과 시엔 뒤처짐 판정을 무시하고 평소대로 돈다(fail-open).
    // 수동 실행(force)만 "뒤처진 채 강행"이므로 노트 쓰기/삭제는 계속 보류한다(holdWrites).
    if (holdWrites) {
      console.log("[tasks-gcal-sync] 볼트 동기화 중 강행 → 노트 쓰기/삭제 보류");
    }
    // 콜드 스타트 잠금: 로드 직후에는 원격에 아무것도 쓰지 않는다(pushArmed 주석 참고).
    const coldHold = this.guard.coldHold(!!opts.force);
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
        .map((t) => taskWhere(t))
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
          const mine = lines.filter((t) => titleBase(t) === rec.title);
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
          const where = taskWhere(victim);
          dupRepairs.push({ id, where, why });
          console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 자동 정리: ${why} ${where}`);
        } catch (e) {
          console.warn("[tasks-gcal-sync] 🆔 중복 자동 정리 실패:", id, e);
        }
      }
    }

    const records = this.state.records;
    const today = todayStr();
    const result = emptyResult();
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
        ? await this.puller.rebuildRecords()
        : new Set<string>();

    // ---- PULL: 우리가 record를 가진 캘린더들의 변경분 가져오기 ----
    // 읽지 못한 캘린더(pullFailedCals)의 record 는 아래에서 통째로 건너뛴다 → PullAll 주석
    const { pullByCal, pullFailedCals, pullOk } = doPull
      ? await this.puller.pullAll(records, result)
      : { pullByCal: new Map<string, CalPull>(), pullFailedCals: new Set<string>(), pullOk: false };

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
      mergeRetry(result, SETTLE_MS - settledFor + 2_000);
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
          calendar: calName(this.settings, rec.calendarId),
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
        const seen = await this.puller.recheckRemote(rec, id);
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
          calendar: calName(this.settings, rec.calendarId),
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
          remote: remoteView(this.codec, ev),
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
          await applyMerge(this.mergeDeps, {
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
            this.skip(result, plan.reason);
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
              calendar: calName(this.settings, rec.calendarId),
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
              calendar: calName(this.settings, rec.calendarId),
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
              calendar: calName(this.settings, rec.calendarId),
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
              calendar: calName(this.settings, rec.calendarId),
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
          calendar: calName(this.settings, rec.calendarId),
          eventId: rec.eventId,
          where: task ? taskWhere(task) : undefined,
          detail: `조정 중 예외: ${errMsg(e)}`,
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
          ).filter((e) => isOurs(this.codec, e));
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
                await this.client.deleteEvent(target.id, d.id!);
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
        this.skip(result, "mobile-readonly");
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
      if (vaultUnsettled && !opts.force) {
        this.skip(result, "unsettled-create");
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
        this.skip(result, "cold-start-create");
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
          await this.writer.ensureId(t, id);
        } catch (e) {
          console.warn("[tasks-gcal-sync] ensureId 실패, skip:", t.path, e);
          this.skip(result, "ensure-id-failed");
          this.fail(result, t.path, e);
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
        const ev = await this.client.insertEvent(
          target.id,
          buildEvent(this.codec, t, id)
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
        this.skip(result, "create-failed");
        this.fail(result, t.path, e);
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

    // pull을 예외 없이 끝냈으면 콜드 스타트 잠금을 푼다(시간 하한은 pushArmed가 따로 본다).
    if (pullOk) this.guard.pullCycleDone = true;

    // 콜드 스타트로 GCal 쓰기를 미뤘고 이제 **시간만** 남았다면, 그 시점에 한 번 더 돈다.
    // 안 그러면 60초에 잠금이 풀려도 깨우는 사람이 없어 다음 주기(기본 5분)를 기다린다.
    // pullCycleDone이 아직 false면(=pull 실패) 예약하지 않는다 — 실패가 이어질 때
    // 2초 간격으로 되도는 것을 막는다. 그 경우는 기존 주기 동기화가 재시도한다.
    if (coldHold && this.guard.pullCycleDone) {
      mergeRetry(result, this.guard.coldRetryMs());
    }

    await this.saveState();
    return result;
  }
}
