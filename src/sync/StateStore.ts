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

  /**
   * 이 스냅샷이 **실제 합의 기록**인가.
   *
   * records는 두 역할을 겸한다 — 매핑(🆔→eventId)과 기준선(마지막 합의 상태). 매핑은
   * 이벤트의 tgs*로 언제든 복원되지만 **기준선은 복원되지 않는다.** tgs*는 "마지막으로
   * 누가 push했는가"이지 "이 기기가 마지막으로 합의한 값"이 아니기 때문이다.
   * 그래서 이벤트에서 복원한 record는 baseline ≡ 원격이 되어 3-way 비교가 2-way로
   * 붕괴하고(원격이 영원히 "안 바뀜"으로 읽힌다), 스테일한 노트가 항상 이긴다.
   *
   * false = 이벤트에서 복원한 가짜 기준선. 원격을 실제로 본 run에서 true로 승격한다.
   * (undefined = 이 필드가 없던 버전의 record → 신뢰하는 쪽으로 읽는다)
   */
  baselineTrusted?: boolean;

  /**
   * done 회귀(완료 → 미완료)를 **처음 관측한** 시각(ms). 회귀는 가장 파괴적인 push라
   * 한 사이클 늦춰 재확인한다(2단계 삭제 가드와 같은 패턴). 회귀가 아니게 되면 지운다.
   */
  uncheckSeenAt?: number;
}

export interface PersistedState {
  records: Record<string, SyncRecord>;
  syncTokens: Record<string, string>; // calendarId → GCal 증분 동기화 토큰
}

export function emptyState(): PersistedState {
  return { records: {}, syncTokens: {} };
}
