import { SkipKind } from "./result";

/**
 * skip 사유를 **로그 파일**에 적을 문장. 무엇을 왜 안 했는지까지 적는다.
 * ⚠️ 아래 SKIP_LABEL 과 문구가 다르다 — 그쪽은 상태바·리포트용 짧은 라벨이다. 합치지 말 것.
 */
export const SKIP_TEXT: Record<SkipKind, string> = {
  "vault-behind": "볼트가 Obsidian Sync로 아직 따라잡는 중 → run 전체 보류",
  "duplicate-id": "같은 🆔가 두 줄 이상 → 정본 불명, 손대지 않음",
  "hold-task-gone": "task가 안 보이지만 지우기엔 이름 → 이벤트 유지",
  "hold-due-invalid": "📅가 없지만 지우기엔 이름 → 이벤트 유지",
  "hold-unschedule": "이벤트가 삭제됐지만 미일정화하기엔 이름 → 📅 유지",
  "hold-conflict":
    "노트·GCal 값이 갈렸으나 볼트가 아직 정착 전 → 충돌 해결 보류(어느 쪽도 쓰지 않음)",
  "cold-start-create": "콜드 스타트 → 새 이벤트 생성 보류",
  "unsettled-create":
    "볼트가 아직 정착 전 → 새 🆔 발급·이벤트 생성 보류(노트에 쓰는 순간 편집·Sync와 겹친다)",
  "ensure-id-failed": "🆔를 노트에 쓰지 못함",
  "create-failed": "이벤트 생성 실패",
  "pull-failed":
    "캘린더를 읽지 못함 → 그 캘린더의 record는 손대지 않음(읽지 못할 때는 쓰지도 않는다)",
  "mobile-readonly":
    "모바일 읽기 전용 → GCal에 쓰지 않음(pull은 정상. 반영은 데스크탑이 맡는다)",
  "push-precondition":
    "pull 이후 GCal이 또 바뀜 → push 포기(다음 run이 새 상태로 다시 판정한다)",
  "reconcile-error": "조정 중 예외",
};

/** skip 사유를 사람이 읽는 짧은 라벨(상태바 · 동기화 리포트). 숫자만 보여주면 원인을 못 찾는다. */
export const SKIP_LABEL: Record<SkipKind, string> = {
  "vault-behind": "볼트 동기화 중",
  "duplicate-id": "🆔 중복",
  "hold-task-gone": "task 없음(보류)",
  "hold-due-invalid": "📅 없음(보류)",
  "hold-unschedule": "이벤트 삭제됨(보류)",
  "hold-conflict": "충돌 해결 보류(볼트 정착 대기)",
  "cold-start-create": "콜드 스타트(생성 보류)",
  "unsettled-create": "볼트 정착 대기(생성 보류)",
  "ensure-id-failed": "🆔 쓰기 실패",
  "create-failed": "이벤트 생성 실패",
  "pull-failed": "캘린더를 읽지 못함(쓰기 보류)",
  "mobile-readonly": "모바일 읽기 전용(GCal 쓰기 없음)",
  "push-precondition": "GCal이 그 사이 또 바뀜(push 포기)",
  "reconcile-error": "조정 실패",
};
