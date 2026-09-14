import { SyncLogEntry } from "../SyncLog";
import { errMsg } from "../../util/errors";

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
   * 사유는 — **완료 해제 보류 · 볼트 뒤처짐 보류 · 콜드 스타트 쓰기 잠금 · 정착 대기 · 충돌 해결 보류**.
   * 호출부(main)가 후속 run을 예약한다 — 안 그러면 보류가 풀려도 다음 주기(기본 5분)
   * 까지 GCal이 그대로라 "아무 변화가 없다"로 보인다.
   *
   * 여러 보류가 겹치면 **가장 이른 시각**을 쓴다(`mergeRetry`). 각 run이 남아 있는 보류를
   * 매번 다시 알리므로, 이르게 깨어나도 그 run이 다음 재확인을 또 예약해 수렴한다.
   */
  retryAfterMs?: number;
}

/** 빈 결과. 키 순서가 로그·골든에 그대로 드러나므로 한 곳에서만 만든다. */
export function emptyResult(): SyncResult {
  return {
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
}

/** skip 을 사유와 함께 센다. 합계(`skipped`)와 내역이 항상 같이 움직이게 한다. */
export function countSkip(r: SyncResult, kind: SkipKind): void {
  r.skipped++;
  r.skips[kind] = (r.skips[kind] ?? 0) + 1;
}

/** 실제로 터진 것. 콘솔에만 남기면 못 본다. */
export function addFailure(r: SyncResult, where: string, e: unknown): void {
  r.failures.push({ where, message: errMsg(e) });
}

/** 후속 run 예약 시각을 합친다 — 겹치면 가장 이른 것. */
export function mergeRetry(r: SyncResult, ms: number): void {
  r.retryAfterMs = Math.min(r.retryAfterMs ?? ms, ms);
}
