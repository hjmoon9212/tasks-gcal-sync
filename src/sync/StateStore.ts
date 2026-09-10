/**
 * sync 상태 영속화 구조.
 * records: 🆔(taskId) → GCal eventId + 마지막 sync 스냅샷.
 *   스냅샷(due/done/title)으로 "어느 쪽이 바뀌었는지"를 다음 sync에서 판정(Phase 2 양방향).
 * syncToken: 캘린더별 GCal 증분 동기화 토큰(Phase 2에서 사용).
 */
export interface SyncRecord {
  eventId: string;
  calendarId: string; // 이벤트가 올라가 있는 캘린더 (태그 변경 시 이동 처리용)
  due: string; // 마지막으로 push한 due (YYYY-MM-DD)
  start?: string; // 마지막으로 push한 이벤트 시작일(🛫 start 또는 due). 없으면 due와 동일 취급
  /**
   * 마지막으로 push한 타임블록 "HH:MM-HH:MM". 없거나 ""면 종일 이벤트.
   * 0.4.5 이전 record엔 이 키가 없으므로 읽을 때 항상 `?? ""`로 받는다 —
   * undefined를 "종일"로 읽어야 기존 record가 "시각이 지워졌다"로 오판되지 않는다.
   */
  time?: string;

  done: boolean; // 마지막으로 push한 완료 상태
  title: string; // 마지막으로 push한 정제 제목
  gcalUpdated?: string; // 우리가 마지막으로 본 이벤트 updated(RFC3339). GCal 외부 수정 감지 + LWW 비교용

  /**
   * done 회귀(완료 → 미완료)를 **처음 관측한** 시각(ms). 되돌리기 힘든 방향이라
   * 한 사이클 늦춰 재확인한다(2단계 삭제 가드와 같은 패턴). 회귀가 아니게 되면 지운다.
   */
  uncheckSeenAt?: number;
  /**
   * 이 record 의 충돌 해결을 **처음 미룬 시각**(ms). 해결되면 지운다.
   *
   * 상한(fail-open)의 기준점이다 — 볼트가 만성적으로 따라잡는 중인 환경에서는
   * `vaultUnsettled` 가 한 번도 안 풀려 충돌이 영영 보류됐다(2026-09-10) →
   * reconcile.conflictResolutionAllowed
   */
  conflictHeldAt?: number;

  /**
   * 마지막으로 본 task 줄의 **원문과 위치**.
   *
   * 이벤트를 지울 때 "무엇을 지웠는지" 를 로그에 남기려면 이것뿐이다 — 지우는 시점에는
   * 이미 줄이 노트에 없어서 읽을 방법이 없다. 2026-09-07 에 편집·Sync 경합으로 노트에서
   * 줄이 사라졌고, 플러그인은 그 상태를 정확히 읽어 이벤트를 지웠지만, 남은 기록이
   * `마지막 스냅샷 due=…` 뿐이라 **복구하려면 Obsidian 버전 기록을 뒤져야 했다.**
   * Sync 는 앞으로도 노트를 잃을 수 있다 — 막을 수 없다면 되살릴 수 있어야 한다.
   */
  lastLine?: string;
  lastWhere?: string;
}

export interface PersistedState {
  records: Record<string, SyncRecord>;
  syncTokens: Record<string, string>; // calendarId → GCal 증분 동기화 토큰
  /**
   * 마지막으로 캘린더 전수 스캔(rebuildRecords)을 **완주한** 시각(ms).
   * 이 스캔은 캘린더마다 ±2년치를 페이지네이션하므로 매 실행마다 돌릴 이유가 없다.
   */
  lastFullScanAt?: number;
  /**
   * 동기화 로그 파일에 붙는 이 기기의 이름(SyncLog.withDeviceTag).
   * 기기-로컬이어야 하므로 localStorage에만 산다 — data.json에 두면 기기끼리 덮어쓴다.
   */
  logDeviceTag?: string;
}

export function emptyState(): PersistedState {
  return { records: {}, syncTokens: {} };
}
