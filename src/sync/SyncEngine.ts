import { App, Platform } from "obsidian";
import { PluginSettings } from "../settings/Settings";
import { PersistedState } from "./StateStore";
import { TaskRepository } from "../data/TaskRepository";
import { CalendarClient } from "../gcal/CalendarClient";
import { TaskWriter } from "../write/TaskWriter";
import { SyncResult, emptyResult, mergeRetry } from "./engine/result";
import { SKIP_TEXT } from "./engine/skipText";
import { VaultGuard } from "./engine/vaultGuard";
import { EventPusher } from "./engine/pusher";
import { CalPull, CalendarPuller } from "./engine/puller";
import { MergeDeps } from "./engine/applyMerge";
import { MaintenanceDeps, backfillDescriptions, cleanupDuplicates } from "./engine/maintenance";
import { RunContext } from "./engine/phases/context";
import { indexTasks } from "./engine/phases/indexTasks";
import { repairDupIds } from "./engine/phases/repairDupIds";
import { reconcileRecords } from "./engine/phases/reconcileRecords";
import { createMissing } from "./engine/phases/createMissing";
import { BEHIND_RECHECK_MS, FULL_SCAN_INTERVAL_MS, SETTLE_MS } from "./engine/constants";
import { CodecCtx } from "./codec/ctx";
import { RunGuards } from "./reconcile";
import { todayStr } from "./dates";

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

  /** 기존 모든 record의 이벤트 설명(note)에 🆔 ID를 일괄 기록. → engine/maintenance */
  backfillDescriptions(): Promise<{ ok: number; fail: number }> {
    return backfillDescriptions(this.maintenanceDeps());
  }

  /** 이미 생긴 중복 이벤트 일괄 정리. → engine/maintenance */
  cleanupDuplicates(): Promise<{ removed: number; checked: number }> {
    return cleanupDuplicates(this.maintenanceDeps());
  }

  private maintenanceDeps(): MaintenanceDeps {
    return {
      settings: this.settings,
      codec: this.codec,
      state: this.state,
      client: this.client,
      repo: this.repo,
      saveState: this.saveState,
    };
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
    const index = indexTasks(tasks);
    const { tasksById, existingIds, dupIds, dupWhere } = index;

    // 노트 쓰기라 정착 뒤에만 한다. 다만 **수동 실행은 연다** — 이 볼트처럼 정착이 잘
    // 안 잡히면 중복이 영영 안 풀리고, 그 사이 그 task 는 통째로 멈춘다(0.9.10).
    const dupRepairs =
      (!vaultUnsettled && !coldHold) || opts.force
        ? await repairDupIds(this.writer, this.state.records, tasks, index)
        : [];

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
    const ctx: RunContext = {
      settings: this.settings,
      codec: this.codec,
      client: this.client,
      writer: this.writer,
      puller: this.puller,
      mergeDeps: this.mergeDeps,
      records,
      result,
      today,
      tasks,
      tasksById,
      existingIds,
      dupIds,
      dupWhere,
      force: !!opts.force,
      coldHold,
      remoteReadOnly,
      vaultUnsettled,
    };
    const guards = new RunGuards({
      dupIds,
      adopted,
      holdWrites,
      vaultUnsettled,
      coldHold,
      remoteReadOnly,
    });

    await reconcileRecords(ctx, { pullByCal, pullFailedCals, pullOk }, guards);

    await createMissing(ctx);

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
