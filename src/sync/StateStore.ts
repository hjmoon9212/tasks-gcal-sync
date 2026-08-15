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
}

export interface PersistedState {
  records: Record<string, SyncRecord>;
  syncTokens: Record<string, string>; // calendarId → GCal 증분 동기화 토큰
  /**
   * 마지막으로 캘린더 전수 스캔(rebuildRecords)을 **완주한** 시각(ms).
   * 이 스캔은 캘린더마다 ±2년치를 페이지네이션하므로 매 실행마다 돌릴 이유가 없다.
   */
  lastFullScanAt?: number;
}

export function emptyState(): PersistedState {
  return { records: {}, syncTokens: {} };
}
