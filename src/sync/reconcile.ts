/*
 * 조정(reconcile) 판단 로직 — **I/O 없는 순수 함수**.
 *
 * 왜 분리했나: 0.3.3~0.3.17의 릴리스가 거의 전부 이 판단의 버그픽스였다. 판단과 실행이
 * 한 함수에 섞여 있으면 규칙 하나를 손볼 때마다 다른 경로에서 빠뜨린다 — 0.3.15가
 * evCancelled에 3종 가드를 채웠지만 바로 위 due 유실 경로는 0.3.16까지 비어 있었고,
 * "GCal이 이긴 필드는 되돌려 쓰지 않는다"에 이벤트 표현 갱신까지 딸려 들어간 게 0.3.17이다.
 *
 * 그래서 두 가지를 강제한다:
 *  1) 무엇을 할지는 여기서만 정한다(decideReconcile). 파일도 네트워크도 안 건드리니
 *     가드 × 필드 조합을 표로 테스트할 수 있다.
 *  2) "파괴적 동작이 허용되는가"는 destructiveAllowed **한 곳**에만 있다.
 *
 * 필드 소유권(0.4.0~): 날짜(due/start)와 제목은 GCal이 직접 조작하는 값이라 양방향이고,
 * **완료는 Obsidian이 소유한다** — GCal엔 "완료"라는 어휘가 없어 색·제목 같은 다른 용도의
 * 필드를 빌려 인코딩해야 하는데, 빌린 필드는 다른 이유로도 바뀌고 오탐의 결과가 노트에
 * ✅를 쓰는 것(반복이면 다음 회차 줄 생성)이라 파괴적이었다. 그래서 완료는 노트 → 이벤트
 * 한 방향으로만 흐른다. 이벤트의 색·☑️는 표시일 뿐 판정에 쓰지 않는다.
 *
 * 충돌 판정(0.9.0~): 같은 필드가 양쪽에서 바뀌었을 때
 *  - **값이 같으면 충돌이 아니다** — 기준선만 뒤처진 것이라 기준선만 앞당긴다.
 *  - 값이 갈렸으면 **누가 원격을 바꿨는지**로 갈린다(RemoteView.stamp):
 *      · 사람이 GCal에서 편집 → **GCal이 이긴다.** GCal이 통합 관리 면이고 거기서 하는
 *        조작(날짜·시각·제목·삭제)은 1급 입력이다.
 *      · 어느 기기가 노트 값을 올린 **메아리** → 충돌이 아니다. 노트를 채택해 올린다.
 *    0.8.0은 이 둘을 구분하지 못해 **무조건 노트**였다. 구분 없이 GCal을 채택하면
 *    메아리가 노트의 최신 편집을 덮는다 — 2026-09-07 실측 "충돌" 127건 중 122건이 그것.
 *  - 단 **볼트가 정착하기 전에는 그 판정을 미룬다**(conflictResolutionAllowed).
 *    이 셋이 하나라도 빠지면 한쪽 편집이 조용히 사라진다.
 *
 * 날짜 둘(📅·🛫)은 **한 구간**이라 항상 함께 판정한다. 한쪽만 상대 값을 채택하면
 * 아무도 정한 적 없는 구간이 만들어진다(하루짜리 task가 여러 날 span이 되는 식).
 */
import { SyncRecord } from "./StateStore";

export type Field = "due" | "start" | "done" | "title" | "time";

/** 스냅샷으로 비교하는 값들. record·노트·병합결과가 모두 이 모양이다. */
export interface Snapshot {
  due: string;
  start: string;
  /**
   * 타임블록 "HH:MM-HH:MM". **"" 는 종일**을 뜻하며 undefined 를 쓰지 않는다 —
   * 날짜·제목과 똑같은 문자열 비교 경로를 타게 해서 판정에 새 분기를 만들지 않으려는 것.
   */
  time: string;
  done: boolean;
  title: string;
}

/** 조정에 필요한 노트 쪽 값만 뽑은 것(경로·줄번호 같은 I/O 정보는 뺀다). */
export interface LocalView extends Snapshot {
  /** 🛫가 실제로 줄에 있는가. 단일일로 바뀌었을 때 제거할지 판단한다. */
  hasStart: boolean;
  /**
   * 🛫 < 📅 로 **여러 날에 걸치는가.** 그러면 시각을 표현할 수 없다 — GCal의 시간지정
   * 이벤트는 "첫날 시작시각 → 마지막날 종료시각" 한 덩어리라 3일 span에 09:00-11:00을
   * 주면 50시간짜리 통짜 블록이 된다(v0.6.6) → SyncEngine.taskTime
   *
   * push 쪽은 `taskTime()`이 이미 ""로 막지만 **pull 쪽에 관문이 없었다.** 그래서 GCal에서
   * 여러 날 이벤트에 시각을 주면 노트에 ⏰가 써지고 다음 push가 곧바로 종일로 되돌렸다 —
   * 사용자에게는 "GCal에서 준 시각이 그냥 사라진다"로 보인다. 여기서 아예 안 받는다.
   */
  multiDay: boolean;
}

/** 이벤트에서 뽑은 원격 값. 이번 run의 pull에 이벤트가 안 왔으면 undefined. */
export interface RemoteView {
  updated?: string;
  /** 날짜를 못 읽으면(혼합형·파싱 실패) undefined — 그때는 날짜 계열을 아예 손대지 않는다. */
  due?: string;
  start?: string;
  title?: string;
  /**
   * 이벤트의 타임블록. "" 면 종일 이벤트, undefined 면 **판정 불가**(혼합형 등)라 손대지 않는다.
   * 종일("")과 판정 불가(undefined)를 반드시 구분해야 한다 — 섞으면 읽지 못한 이벤트를
   * 근거로 노트의 ⏰ 를 지운다.
   */
  time?: string;
  /**
   * 이벤트에 심긴 **마지막 push 스냅샷**(`tgs*` extendedProperties).
   *
   * 위의 값들과 대조하면 원격 변경이 **사람이 GCal에서 한 편집**인지 **어느 기기가 노트
   * 값을 올린 메아리**인지 갈린다 — `updated`만으로는 그 둘이 똑같아 보인다.
   * GCal PATCH는 키 단위 병합이고 우리는 값과 스탬프를 **항상 함께** 보내므로, 우리
   * push 뒤에는 둘이 반드시 일치한다. 사람이 캘린더에서 드래그하면 이벤트 필드만 바뀌고
   * `extendedProperties`는 그대로 남는다.
   *
   * 스탬프가 없는 옛 이벤트는 **판정 불가**라 undefined — 그때는 사람 편집으로 치지 않는다.
   */
  stamp?: { due?: string; start?: string; time?: string; title?: string };
}

export type TaskState =
  | { kind: "missing" } // 볼트에서 사라짐
  | { kind: "due-invalid" } // 줄은 있는데 📅가 없거나 형식 오류
  | { kind: "ok"; local: LocalView };

export interface Guards {
  /** 같은 🆔가 두 줄 이상 — 정본을 특정할 수 없다. */
  duplicateId: boolean;
  /** 이번 스캔에서 처음 주운 record. */
  adopted: boolean;
  /** 볼트가 Obsidian Sync로 아직 따라잡는 중(fail-open 상한 적용 **후**). */
  holdWrites: boolean;
  /**
   * 볼트가 **아직 정착하지 않았다** — 뒤처짐이 풀린 뒤 충분한 시간이 이어지지 않았다.
   *
   * `holdWrites`(뒤처짐 판정)와 두 가지가 다르다.
   *  1. **fail-open 상한을 보지 않는다.** 상한은 "충돌 아닌 변경까지 영영 막지는 말자"는
   *     장치이지 "이제 노트를 믿어도 된다"는 신호가 아니다.
   *  2. **순간이 아니라 구간을 본다.** 2026-09-07 에 40분짜리 보류 구간 두 개 사이의
   *     **2초 틈**에서 `vaultBehind()`가 한 번 false 를 돌려줬고, 그 한 번의 표본을 근거로
   *     (a) 새 🆔 를 노트에 써넣고 (b) 40분 뒤 같은 틈에서 이벤트를 지웠다. 볼트가 40분째
   *     따라잡는 중인데 2초 조용했다고 정착이라고 볼 수는 없다.
   *
   * 되돌리기 힘든 동작(삭제·미일정화·충돌 해결·새 🆔 발급)은 전부 이 값을 본다.
   */
  vaultUnsettled: boolean;
  /** 플러그인이 막 로드됨 — 원격에 쓰지 않는다. */
  coldHold: boolean;
}

/**
 * 파괴적 동작(이벤트 삭제 · 노트 미일정화)이 허용되는가.
 *
 * **이 규칙은 여기 한 곳에만 있다.** 볼트가 뒤처졌거나, 방금 로드됐거나, 이번 스캔에서
 * 처음 본 record라면 — 우리가 보고 있는 "없음"이 진짜 없음이 아니라 아직 안 내려온
 * 것일 수 있다. 그 상태로 지우면 다른 기기가 방금 만든 일정을 없앤다.
 *
 * `vaultUnsettled`가 v0.8.1에서 더해졌다. `holdWrites`만 보던 동안은 **뒤처짐 구간
 * 사이의 2초 틈**과 **fail-open 상한 초과** 둘 다 삭제를 열어줬다 → Guards.vaultUnsettled.
 */
export function destructiveAllowed(g: Guards): boolean {
  return !g.holdWrites && !g.coldHold && !g.adopted && !g.vaultUnsettled;
}

/**
 * 진짜 충돌(같은 필드가 양쪽에서 **다른 값으로** 바뀜)을 지금 해결해도 되는가.
 *
 * 충돌 해결은 한쪽 값을 버리는 일이고, 0.8.0부터 이기는 쪽이 노트다. 그래서 **노트가
 * 최신이라는 보장**이 없으면 해서는 안 된다 — 스테일한 노트가 원격을 덮는 바로 그 경로다.
 *
 * `holdWrites`가 아니라 `vaultUnsettled`를 보는 것이 핵심이다. fail-open 상한은
 * "충돌 아닌 변경까지 영영 막지는 말자"는 장치이지 충돌 판정을 열어주는 장치가 아니다.
 * 수동 실행(force)도 이 보류는 우회하지 않는다 — 완료 해제 보류와 같은 이유다.
 */
export function conflictResolutionAllowed(g: Guards): boolean {
  return !g.coldHold && !g.vaultUnsettled;
}

export type SkipReason =
  | "duplicate-id"
  | "hold-task-gone"
  | "hold-due-invalid"
  | "hold-unschedule"
  | "hold-conflict";

/** 노트에 반영할 쓰기들. 실행 순서는 due → start → title → done(구조 변경 가능성). */
export interface PullOps {
  setDue?: string;
  /** write=none: 값은 채택하되 줄은 안 건드림(🛫가 없는데 단일일로 바뀐 경우). */
  start?: { value: string; write: "set" | "remove" | "none" };
  title?: { from: string; to: string };
  /** value 가 "" 면 ⏰ 제거(종일로), 아니면 그 범위로 지정. */
  time?: { value: string };
}

export interface MergePlan {
  kind: "merge";
  pull: PullOps;
  /** GCal이 이긴 필드. */
  pulledFields: Field[];
  /**
   * 양쪽에서 다른 값으로 바뀌었으나 원격 변경이 **메아리**여서 노트를 채택한 것
   * (버려진 GCal 값은 `remote` 에 남는다).
   */
  conflicts: Field[];
  /**
   * 양쪽에서 다른 값으로 바뀌었고 원격이 **사람의 GCal 편집**이라 GCal을 채택한 것
   * (버려진 노트 값은 `local` 에 남는다). 0.9.0~.
   */
  gcalWins: Field[];
  /**
   * 양쪽 다 바뀌었지만 **값이 같아** 충돌이 아니었던 필드. 기준선만 앞당긴다.
   * 로그에는 남기지 않는다 — 실제로 달라진 게 없다.
   */
  agreed: Field[];
  /**
   * 원격 쪽 값을 스냅샷 모양으로 담은 것. 충돌에서 **버려진 GCal 값**이 여기에만 남는다
   * (merged 는 노트 값이므로). 모르는 필드는 기준선 값으로 채운다.
   */
  remote: Snapshot;
  /** 노트 변경분 중 GCal이 안 가져간 게 남아 push가 필요한가. */
  pushNeeded: boolean;
  /**
   * push할 게 없더라도, pull이 실제로 노트를 고쳤으면 이벤트 표현을 다시 찍어야 하는가.
   * (호출부가 "실제로 쓰기가 일어났는가"와 AND 한다)
   */
  normalizeIfPulled: boolean;
  /** done 회귀(완료→미완료)를 이번 run엔 올리지 않는다. */
  holdDone: boolean;
  /** 보류가 풀리는 시점(ms 뒤) — 호출부가 후속 run을 예약한다. */
  retryAfterMs?: number;
  /** 회귀 관측 시각 기록 지시. */
  uncheckSeen: "set" | "clear" | undefined;
  /** 우리 push가 아닌 외부 수정이 감지됐는가. */
  gcalChanged: boolean;
  /**
   * GCal이 시각을 줬는데 **여러 날 span 이라 받지 않았다**(0.9.0~). 조용히 버리면
   * "GCal에서 준 시각이 사라진다"로 보이므로 로그에 이유를 남긴다 → LocalView.multiDay
   */
  timeIgnoredMultiDay: boolean;
  /** 병합 결과(스냅샷 후보). pull이 실패한 필드는 호출부가 local 값으로 되돌린다. */
  merged: Snapshot;
  /** 노트 현재값 — pull 실패 시 폴백. */
  local: Snapshot;
}

export type ReconcilePlan =
  | {
      kind: "skip";
      reason: SkipReason;
      /** hold-conflict 일 때 갈린 필드 — 로그에 무엇 때문인지 남긴다. */
      fields?: Field[];
      /**
       * hold-conflict 일 때 갈린 두 값. 보류는 "아무 일도 안 일어난" run이라 이걸
       * 안 남기면 나중에 무엇 때문에 멈춰 있었는지 알 방법이 없다.
       */
      local?: Snapshot;
      remote?: Snapshot;
      /** 보류가 풀릴 만한 시점(ms 뒤). 호출부가 후속 run을 예약한다. */
      retryAfterMs?: number;
    }
  | { kind: "delete-event"; reason: "task-gone" | "due-invalid" }
  /** 이벤트만 정리하고 📅는 남긴다(완료 회차의 due는 기록이다 — 0.3.15). */
  | { kind: "drop-record" }
  /** 📅를 떼어 미일정화한다. */
  | { kind: "unschedule" }
  | MergePlan;

export interface DecideInput {
  rec: SyncRecord;
  task: TaskState;
  remote?: RemoteView;
  /** 이 record의 이벤트가 GCal에서 삭제됨. */
  evCancelled: boolean;
  guards: Guards;
  now: number;
  uncheckHoldMs: number;
  /** 충돌 해결을 미뤘을 때 다시 확인하기까지의 간격(ms). */
  conflictRetryMs: number;
}

export function decideReconcile(i: DecideInput): ReconcilePlan {
  const g = i.guards;

  // 🆔가 중복된 노트 → 정본을 특정할 수 없으니 읽지도 쓰지도 않는다.
  // (특히 아래 "task 없음 → 삭제"로 새지 않도록 이 검사가 먼저 와야 한다)
  if (g.duplicateId) return { kind: "skip", reason: "duplicate-id" };

  // Obsidian에서 task 사라짐 → 이벤트 삭제
  if (i.task.kind === "missing") {
    return destructiveAllowed(g)
      ? { kind: "delete-event", reason: "task-gone" }
      : { kind: "skip", reason: "hold-task-gone" };
  }

  // task는 있으나 📅(due)를 잃음 → 이벤트 제거.
  // due 없이 patch하면 addDay(undefined)=NaN 날짜로 GCal 400이 매 sync 반복된다.
  if (i.task.kind === "due-invalid") {
    return destructiveAllowed(g)
      ? { kind: "delete-event", reason: "due-invalid" }
      : { kind: "skip", reason: "hold-due-invalid" };
  }

  const local = i.task.local;

  // GCal에서 이벤트 삭제됨 → 미일정화
  if (i.evCancelled) {
    // **완료된 줄의 📅는 기록이다.** 반복(🔁) task는 회차마다 별도 🆔·이벤트가 쌓이므로
    // 캘린더에서 지난 완료 이벤트를 정리하는 건 자연스러운 조작인데, 그때마다 완료 회차의
    // due가 지워졌다(2026-08-07). 완료 + 과거 due는 생성 루프의 inWindow에서 걸러지므로
    // record만 지워도 이벤트가 되살아나지 않는다.
    if (local.done) return { kind: "drop-record" };
    return destructiveAllowed(g)
      ? { kind: "unschedule" }
      : { kind: "skip", reason: "hold-unschedule" };
  }

  return mergePlan(i, local);
}

function mergePlan(i: DecideInput, local: LocalView): ReconcilePlan {
  const { rec, remote } = i;
  const recStart = rec.start ?? rec.due;

  // ── 어느 쪽에서 무엇이 바뀌었나: 필드별로 판정한다 ──
  // 기준은 양쪽 모두 마지막 동기화 스냅샷(rec). 필드를 따로 보기 때문에
  // "Obsidian에서 ✅ + GCal에서 날짜 이동"처럼 겹치지 않는 변경은 둘 다 살아남는다.
  // 시각은 "" 가 종일이다. rec 은 0.4.5 이전에 이 키가 없고, local 도 구버전 호출부에서
  // 빠질 수 있으므로 양쪽 다 ?? "" 로 받는다 — undefined 가 들어오면 "시각이 사라졌다"로
  // 오판해 매 사이클 불필요한 push 가 돈다.
  const recTime = rec.time ?? "";
  const localTime = local.time ?? "";
  const obs = {
    due: local.due !== rec.due,
    start: local.start !== recStart,
    time: localTime !== recTime,
    done: local.done !== rec.done,
    title: local.title !== rec.title,
  };

  // GCal 외부 수정 감지: 이벤트가 왔고 그 updated가 우리가 마지막으로 본 값과 다름
  // → 우리 push의 메아리가 아니라 사용자 수정.
  const gcalChanged =
    !!remote && !!remote.updated && remote.updated !== rec.gcalUpdated;
  // 이벤트에서 날짜를 못 읽으면 날짜 계열은 아예 손대지 않는다.
  // 예전엔 이 경우에도 else로 떨어져 task의 🛫를 근거 없이 지웠다.
  const datesOk = !!remote?.due;

  // GCal이 가져갈 수 있는 필드는 날짜와 제목뿐이다. **완료는 여기 없다** — 노트가 소유한다.
  const gc = {
    due: gcalChanged && datesOk && remote!.due !== rec.due,
    start: gcalChanged && datesOk && remote!.start !== recStart,
    // 시각은 날짜와 별개로 판정한다: GCal에서 드래그로 시간만 바꾸는 게 가장 흔한 조작이고,
    // 그때 due/start 는 그대로다. remote.time 이 undefined 면 읽지 못한 것이므로 손대지 않는다.
    // 여러 날 span 이면 시각을 **표현할 수 없으므로** 받지도 않는다 → LocalView.multiDay
    time:
      gcalChanged &&
      !local.multiDay &&
      remote!.time !== undefined &&
      remote!.time !== recTime,
    title: gcalChanged && !!remote!.title && remote!.title !== rec.title,
  };

  // ── 그 원격 변경을 **사람이 GCal에서** 했는가 ──
  // 이벤트의 현재 값 vs 그 이벤트에 심긴 마지막 push 스냅샷(tgs*). 다르면 플러그인 밖에서
  // 바뀐 것 = 사람의 편집이고, 같으면 어느 기기가 올린 그대로 = 메아리다 → RemoteView.stamp
  //
  // **충돌 판정에만 쓴다.** gc[f](일반 pull)는 손대지 않는다 — 메아리라도 이 기기의 노트가
  // 아직 옛 값이면 받아 두는 게 맞고(Obsidian Sync보다 빠르다), 스탬프가 없는 옛 이벤트의
  // 동기화를 조용히 멈춰서도 안 된다.
  const st = remote?.stamp;
  const byHuman = (f: "due" | "start" | "time" | "title"): boolean => {
    if (!st) return false; // 스탬프 없음 = 판정 불가 → 사람 편집으로 치지 않는다
    const was = st[f];
    const now = remote![f];
    return was !== undefined && now !== undefined && now !== was;
  };
  // 날짜 둘은 한 구간이라 **하나로 묶어 판정한다.** 한쪽만 사람이 옮겼어도 그 구간 전체가
  // 사람의 것이다 — 나눠 판정하면 아무도 정한 적 없는 구간이 만들어진다.
  const humanDates = byHuman("due") || byHuman("start");
  const humanEdited = {
    due: humanDates,
    start: humanDates,
    time: byHuman("time"),
    title: byHuman("title"),
  };

  // 양쪽 스냅샷을 같은 모양으로 만들어 둔다 — 아래 분류도, 로그도 이 둘만 본다.
  const localSnap: Snapshot = {
    due: local.due,
    start: local.start,
    time: localTime,
    done: local.done,
    title: local.title,
  };
  const remoteSnap: Snapshot = {
    due: remote?.due ?? rec.due,
    start: remote?.start ?? recStart,
    time: remote?.time ?? recTime,
    done: rec.done, // GCal은 "완료"라는 어휘가 없다 — 기준선을 그대로 둔다
    title: remote?.title ?? rec.title,
  };

  // ── 같은 필드가 양쪽 다 바뀐 경우 ──
  //
  // 1) **값이 같으면 충돌이 아니다.** 기준선만 뒤처진 것이라 어느 쪽에도 쓸 게 없고
  //    기준선만 앞당기면 된다. 이 검사가 없으면 며칠 꺼둔 기기를 켤 때마다 무더기로
  //    "충돌 → 변경 폐기"가 찍힌다 — 2026-09-07 실측에서 충돌 127건 중 122건이 이것이었다.
  //    로그가 오염되는 것만 문제가 아니다: 같은 값을 노트에 다시 써서 modify → 자동 push가 돈다.
  // 2) 값이 갈렸으면 **누가 원격을 바꿨는지**로 갈린다(0.9.0~).
  //    · 사람이 GCal에서 편집했다 → **GCal이 이긴다.** GCal이 통합 관리 면이라 거기서 하는
  //      날짜·시각·제목 변경은 1급 입력이다. pull하고 obs[f]를 꺼서 노트 값을 안 올린다.
  //    · 메아리(어느 기기가 노트 값을 올린 것)다 → **노트를 채택한다.** 이건 충돌이 아니라
  //      기준선이 뒤처져 충돌처럼 보이는 것뿐이고, GCal을 채택하면 구조적으로 낡은 값을 고른다.
  // 3) 단 **볼트가 정착하기 전에는 그 판정 자체를 미룬다.** 어느 쪽이 이기든 한쪽 값을
  //    버리는 일이라, 노트가 최신이라는 보장이 없으면 해서는 안 된다 → conflictResolutionAllowed
  const conflicts: Field[] = [];
  const gcalWins: Field[] = [];
  const agreed: Field[] = [];
  const heldConflicts: Field[] = [];
  for (const f of ["due", "start", "time", "title"] as const) {
    if (!gc[f] || !obs[f]) continue;
    if (remoteSnap[f] === localSnap[f]) {
      agreed.push(f);
      gc[f] = false;
      obs[f] = false;
      continue;
    }
    if (!conflictResolutionAllowed(i.guards)) {
      heldConflicts.push(f);
      continue;
    }
    if (humanEdited[f]) {
      // GCal 채택 → pull한다. obs[f]를 꺼서 노트 값이 push로 올라가지 않게 한다.
      gcalWins.push(f);
      obs[f] = false;
    } else {
      // 메아리 → 노트 채택. pull하지 않고, obs[f]는 그대로 남아 push로 올라간다.
      conflicts.push(f);
      gc[f] = false;
    }
  }

  // 날짜 둘(📅 due·🛫 start)은 **하나의 구간**을 나타낸다. 한쪽만 상대 값을 채택하면
  // 아무도 정한 적 없는 구간이 만들어진다 — 하루짜리 task가 "🛫가 붙은 여러 날 span"이
  // 되는 식이다. 그래서 구간을 통째로 한쪽 것으로 맞춘다.
  if (gcalWins.includes("due") || gcalWins.includes("start")) {
    // 구간 전체를 GCal 것으로. 원격이 기준선과 같아 gc가 꺼져 있던 쪽도, 노트와 다르면
    // 끌어와야 구간이 맞는다. 노트 쪽 날짜는 어느 것도 올리지 않는다.
    gc.due = remoteSnap.due !== localSnap.due;
    gc.start = remoteSnap.start !== localSnap.start;
    obs.due = false;
    obs.start = false;
  } else if (conflicts.includes("due") || conflicts.includes("start")) {
    // 구간 전체를 노트 것으로.
    gc.due = false;
    gc.start = false;
  }

  // 해결을 미룬 충돌이 하나라도 있으면 **이 record는 이번 run에 통째로 손대지 않는다.**
  // push는 이벤트 전체를 다시 그리므로 "한 필드만 빼고 올리기"가 안 되고, 스냅샷을 반쯤
  // 갱신하면 못 올린 변경이 "이미 반영됨"으로 남아 영영 사라진다. skip이면 스냅샷도
  // gcalUpdated도 그대로라 다음 run이 같은 상태를 다시 본다.
  if (heldConflicts.length) {
    return {
      kind: "skip",
      reason: "hold-conflict",
      fields: heldConflicts,
      local: localSnap,
      remote: remoteSnap,
      retryAfterMs: i.conflictRetryMs,
    };
  }

  const pull: PullOps = {};
  const pulledFields: Field[] = [];
  const merged: Snapshot = { ...localSnap };

  if (gc.due) {
    pull.setDue = remote!.due!;
    merged.due = remote!.due!;
    pulledFields.push("due");
  }
  if (gc.start) {
    const v = remote!.start!;
    pull.start = {
      value: v,
      // 시작일이 due보다 앞이면 🛫로 남기고, 단일일로 바뀌었으면 🛫를 뗀다.
      write: v < merged.due ? "set" : local.hasStart ? "remove" : "none",
    };
    merged.start = v;
    pulledFields.push("start");
  }
  if (gc.time) {
    pull.time = { value: remote!.time! };   // "" 면 ⏰ 제거(GCal에서 종일로 되돌린 것)
    merged.time = remote!.time!;
    pulledFields.push("time");
  }
  if (gc.title) {
    pull.title = { from: local.title, to: remote!.title! };
    merged.title = remote!.title!;
    pulledFields.push("title");
  }

  // ── done 회귀(완료 → 미완료) 한 사이클 보류 ──
  // 완료는 노트가 소유하므로 GCal에 물어볼 것은 없다. 그래도 **미완료 push는 되돌리기 힘든
  // 방향**이라 한 박자 미룬다: 방금 열린 스테일한 노트가 남의 기기가 찍은 완료를 지우고
  // 이벤트를 미완료로 되돌리면, Sync가 정착한 뒤 다시 완료로 돌아오며 캘린더가 깜빡인다.
  // 한 사이클 기다리면 그 사이 Sync가 정착해 회귀 자체가 사라진다.
  const doneRegress = obs.done && !local.done && rec.done;
  let holdDone = false;
  let retryAfterMs: number | undefined;
  let uncheckSeen: "set" | "clear" | undefined;
  if (doneRegress) {
    const seenAt = rec.uncheckSeenAt ?? i.now;
    if (rec.uncheckSeenAt === undefined) uncheckSeen = "set";
    const waited = i.now - seenAt;
    holdDone = waited < i.uncheckHoldMs;
    if (holdDone) {
      // 보류가 풀리는 시점에 한 번 더 돌지 않으면 다음 주기(기본 5분)까지 GCal이
      // 그대로라 "아무 일도 안 일어난다"로 보인다.
      retryAfterMs = i.uncheckHoldMs - waited + 2_000;
    }
  } else if (rec.uncheckSeenAt !== undefined) {
    uncheckSeen = "clear";
  }
  // 보류 중이면 병합 결과의 완료 상태도 예전 값이다 — 스냅샷에 미완료가 기록되면
  // 다음 run에서 "회귀 없음"으로 읽혀 보류가 그대로 무산된다.
  if (holdDone) merged.done = rec.done;

  const pushNeeded =
    (obs.due && !gc.due) ||
    (obs.start && !gc.start) ||
    (obs.time && !gc.time) ||
    (obs.done && !holdDone) ||
    (obs.title && !gc.title);

  return {
    kind: "merge",
    pull,
    pulledFields,
    conflicts,
    gcalWins,
    agreed,
    remote: remoteSnap,
    pushNeeded,
    // GCal이 이긴 변경만 있어 push할 게 없더라도 **이벤트의 표현은 다시 찍는다.**
    // 예: GCal에서 제목을 고치면 우리가 붙여 둔 상태 접두사(☐/☑️/🔁)가 떨어져 나간다.
    // 단 사용자가 GCal에서 실제로 뭔가 바꾼 경우로 한정한다.
    normalizeIfPulled: !pushNeeded && gcalChanged,
    holdDone,
    retryAfterMs,
    uncheckSeen,
    gcalChanged,
    timeIgnoredMultiDay:
      gcalChanged &&
      local.multiDay &&
      remote?.time !== undefined &&
      remote.time !== recTime,
    merged,
    local: localSnap,
  };
}

/** run 전체에서 공유되는 가드 상태 → record 하나에 대한 Guards로 좁힌다. */
export class RunGuards {
  constructor(
    private readonly ctx: {
      dupIds: Set<string>;
      adopted: Set<string>;
      holdWrites: boolean;
      vaultUnsettled: boolean;
      coldHold: boolean;
    }
  ) {}

  for(id: string): Guards {
    return {
      duplicateId: this.ctx.dupIds.has(id),
      adopted: this.ctx.adopted.has(id),
      holdWrites: this.ctx.holdWrites,
      vaultUnsettled: this.ctx.vaultUnsettled,
      coldHold: this.ctx.coldHold,
    };
  }
}
