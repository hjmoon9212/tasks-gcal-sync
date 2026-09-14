import { App } from "obsidian";
import { getSyncInstance } from "../../obsidian/syncPlugin";
import { BEHIND_MAX_MS, COLD_START_MS, SETTLE_MS } from "./constants";

/** run 첫머리에서 한 번 관측한 볼트 상태. */
export interface VaultObservation {
  /** 이번 표본에서 Obsidian Sync 가 따라잡는 중으로 보였나. */
  behind: boolean;
  /** 뒤처짐이 BEHIND_MAX_MS 넘게 이어져 fail-open 으로 통과시키는가. */
  overBudget: boolean;
  /** 뒤처진 채 강행(force)하는 run — pull·노트 쓰기를 끈다. */
  holdWrites: boolean;
  /** 뒤처짐이 풀린 뒤 이어진 조용한 시간(ms). */
  settledFor: number;
  /** ★ 정착 전(SETTLE_MS 미만). 되돌리기 힘든 동작은 순간이 아니라 이 구간을 본다. */
  vaultUnsettled: boolean;
  /** run 전체를 보류하고 바로 돌아가야 하는가. */
  earlyReturn: boolean;
}

/**
 * **Obsidian Sync 가 GCal 동기화보다 먼저다** 를 집행하는 시계들 — 볼트 뒤처짐 · 정착 구간 ·
 * 콜드 스타트. SyncEngine 에서 그대로 옮겼다(0.12.5).
 *
 * ⛔ 이 클래스는 **관측과 시계**만 가진다. 무엇을 막을지(삭제·충돌 해결·생성)는
 *    reconcile.destructiveAllowed / conflictResolutionAllowed 한 곳에서 정한다.
 * app 은 부를 때마다 읽는다 — Sync 인스턴스는 로드 뒤에 준비되기도 한다.
 */
export class VaultGuard {
  /** 플러그인 로드 시각. 콜드 스타트 판정 기준(인스턴스는 로드마다 새로 만들어진다). */
  loadedAt = Date.now();
  /** 알려진 캘린더 전부를 예외 없이 pull한 run이 한 번 끝났는가. */
  pullCycleDone = false;
  /** 볼트 뒤처짐 판정이 **연속으로** 참이기 시작한 시각. fail-open 상한의 기준. */
  behindSince: number | null = null;
  /**
   * 뒤처짐 판정이 **연속으로** 거짓이기 시작한 시각. 정착(SETTLE_MS) 판정의 기준.
   * 뒤처짐이 한 번이라도 관측되면 다시 null 이 된다 — 시계를 처음부터 다시 센다.
   */
  settledSince: number | null = null;

  constructor(private readonly getApp: () => App) {}

  /**
   * run 첫머리의 판정을 **원래 순서 그대로** 한 번에 한다:
   * 뒤처짐 표본 → 정착 시계 갱신 → 예산(fail-open 상한) → 보류 여부.
   * 정착 시계는 early return 판단보다 먼저 갱신한다 — 보류로 끝나는 run 도 시계를 리셋해야 한다.
   */
  observe(force: boolean): VaultObservation {
    const behind = this.vaultBehind();
    if (behind) this.settledSince = null;
    else if (this.settledSince === null) this.settledSince = Date.now();
    const settledFor =
      this.settledSince === null ? 0 : Date.now() - this.settledSince;
    const vaultUnsettled = settledFor < SETTLE_MS;
    const overBudget = behind && this.behindBudgetExceeded();
    const earlyReturn = behind && !overBudget && !force;
    if (!earlyReturn && !behind) this.resetBehindBudget();
    const holdWrites = behind && !overBudget;
    return { behind, overBudget, holdWrites, settledFor, vaultUnsettled, earlyReturn };
  }

  /**
   * 이번 run 은 원격에 쓰지 않는다(콜드 스타트 잠금). **수동 실행(force)은 우회한다** —
   * 현재 코드의 동작이다(문서의 "수동으로도 안 연다" 와는 다르다 → 버그 백로그 D1).
   */
  coldHold(force: boolean): boolean {
    return !force && !this.pushArmed();
  }

  /** 콜드 스타트 잠금이 풀리는 시점까지 남은 시간 + 여유 2초 — 그때 후속 run 을 예약한다. */
  coldRetryMs(): number {
    return Math.max(0, COLD_START_MS - (Date.now() - this.loadedAt)) + 2_000;
  }

  /**
   * 이 기기의 볼트가 뒤처져 있으면 true. Obsidian Sync 코어 플러그인의 상태를 읽는다
   * (비공식 API — 없거나 모양이 바뀌면 판단을 포기하고 false).
   *
   * 뒤처진 볼트에서 "task가 없다 → 이벤트 삭제"를 돌리면, 다른 기기가 방금 만든
   * task의 이벤트를 지운다. 확실히 동기화 중일 때만 삭제를 미룬다.
   */
  vaultBehind(): boolean {
    try {
      const inst = getSyncInstance(this.getApp());
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
  behindBudgetExceeded(): boolean {
    if (this.behindSince === null) this.behindSince = Date.now();
    const over = Date.now() - this.behindSince > BEHIND_MAX_MS;
    if (over) {
      console.warn(
        "[tasks-gcal-sync] 볼트 뒤처짐 판정이 계속됨 → 상한 초과, 이번 run은 통과시킴"
      );
    }
    return over;
  }

  resetBehindBudget(): void {
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
  pushArmed(): boolean {
    if (Date.now() - this.loadedAt < COLD_START_MS) return false;
    return this.pullCycleDone;
  }
}
