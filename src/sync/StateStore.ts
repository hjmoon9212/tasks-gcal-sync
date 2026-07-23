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

  done: boolean; // 마지막으로 push한 완료 상태
  title: string; // 마지막으로 push한 정제 제목
  gcalUpdated?: string; // 우리가 마지막으로 본 이벤트 updated(RFC3339). GCal 외부 수정 감지 + LWW 비교용
}

export interface PersistedState {
  records: Record<string, SyncRecord>;
  syncTokens: Record<string, string>; // calendarId → GCal 증분 동기화 토큰
}

export function emptyState(): PersistedState {
  return { records: {}, syncTokens: {} };
}
