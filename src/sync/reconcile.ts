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
 */
import { SyncRecord } from "./StateStore";

export type Field = "due" | "start" | "done" | "title";

/** 스냅샷으로 비교하는 네 값. record·노트·병합결과가 모두 이 모양이다. */
export interface Snapshot {
  due: string;
  start: string;
  done: boolean;
  title: string;
}

/** 조정에 필요한 노트 쪽 값만 뽑은 것(경로·줄번호 같은 I/O 정보는 뺀다). */
export interface LocalView extends Snapshot {
  /** 🛫가 실제로 줄에 있는가. 단일일로 바뀌었을 때 제거할지 판단한다. */
  hasStart: boolean;
}

/** 이벤트에서 뽑은 원격 값. 이번 run의 pull에 이벤트가 안 왔으면 undefined. */
export interface RemoteView {
  updated?: string;
  done: boolean;
  /** 날짜를 못 읽으면(혼합형·파싱 실패) undefined — 그때는 날짜 계열을 아예 손대지 않는다. */
  due?: string;
  start?: string;
  title?: string;
}

export type TaskState =
  | { kind: "missing" } // 볼트에서 사라짐
  | { kind: "due-invalid" } // 줄은 있는데 📅가 없거나 형식 오류
  | { kind: "ok"; local: LocalView };

export interface Guards {
  /** 같은 🆔가 두 줄 이상 — 정본을 특정할 수 없다. */
  duplicateId: boolean;
  /** 이번 run에 이 파일에 줄이 삽입됨(반복 회차) — 캐시된 line이 밀렸다. */
  fileDirty: boolean;
  /** 이번 스캔에서 처음 주운 record. */
  adopted: boolean;
  /** 볼트가 Obsidian Sync로 아직 따라잡는 중. */
  holdWrites: boolean;
  /** 플러그인이 막 로드됨 — 원격에 쓰지 않는다. */
  coldHold: boolean;
  /**
   * 이번 run이 이 record의 캘린더를 **실제로 읽었는가**.
   * "이벤트 객체가 응답에 있었는가"가 아니다 — 증분 pull은 변경 없는 이벤트를 안 준다.
   */
  remotePulled: boolean;
}

/**
 * 파괴적 동작(이벤트 삭제 · 노트 미일정화)이 허용되는가.
 *
 * **이 규칙은 여기 한 곳에만 있다.** 볼트가 뒤처졌거나, 방금 로드됐거나, 이번 스캔에서
 * 처음 본 record라면 — 우리가 보고 있는 "없음"이 진짜 없음이 아니라 아직 안 내려온
 * 것일 수 있다. 그 상태로 지우면 다른 기기가 방금 만든 일정을 없앤다.
 */
export function destructiveAllowed(g: Guards): boolean {
  return !g.holdWrites && !g.coldHold && !g.adopted;
}

export type SkipReason =
  | "duplicate-id"
  | "file-dirty"
  | "hold-task-gone"
  | "hold-due-invalid"
  | "hold-unschedule";

/** 노트에 반영할 쓰기들. 실행 순서는 due → start → title → done(구조 변경 가능성). */
export interface PullOps {
  setDue?: string;
  /** write=none: 값은 채택하되 줄은 안 건드림(🛫가 없는데 단일일로 바뀐 경우). */
  start?: { value: string; write: "set" | "remove" | "none" };
  title?: { from: string; to: string };
  /** true=완료 처리, false=완료 취소. */
  done?: boolean;
}

export interface MergePlan {
  kind: "merge";
  pull: PullOps;
  /** GCal이 이긴 필드. */
  pulledFields: Field[];
  /** 같은 필드가 양쪽에서 바뀌어 GCal을 채택한 것(경고용). */
  conflicts: Field[];
  /** 노트 변경분 중 GCal이 안 가져간 게 남아 push가 필요한가. */
  pushNeeded: boolean;
  /**
   * push할 게 없더라도, pull이 실제로 노트를 고쳤으면 이벤트 표현을 다시 찍어야 하는가.
   * (호출부가 "실제로 쓰기가 일어났는가"와 AND 한다)
   */
  normalizeIfPulled: boolean;
  /** done 회귀(완료→미완료)를 이번 run엔 올리지 않는다. */
  holdDone: boolean;
  holdReason?: "remote-unknown" | "recheck";
  /** 보류가 풀리는 시점(ms 뒤) — 호출부가 후속 run을 예약한다. */
  retryAfterMs?: number;
  /** 회귀 관측 시각 기록 지시. */
  uncheckSeen: "set" | "clear" | undefined;
  /** 기준선 불신 + 원격 완료 + 노트 미체크 → 노트를 복구한 경우(경고용). */
  staleUncheck: boolean;
  /** 우리 push가 아닌 외부 수정이 감지됐는가. */
  gcalChanged: boolean;
  /** 원격을 실제로 봤으므로 기준선을 승격해도 되는가. */
  promoteBaseline: boolean;
  /** 병합 결과(스냅샷 후보). pull이 실패한 필드는 호출부가 local 값으로 되돌린다. */
  merged: Snapshot;
  /** 노트 현재값 — pull 실패 시 폴백. */
  local: Snapshot;
}

export type ReconcilePlan =
  | { kind: "skip"; reason: SkipReason }
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
}

export function decideReconcile(i: DecideInput): ReconcilePlan {
  const g = i.guards;

  // 🆔가 중복된 노트 → 정본을 특정할 수 없으니 읽지도 쓰지도 않는다.
  // (특히 아래 "task 없음 → 삭제"로 새지 않도록 이 검사가 먼저 와야 한다)
  if (g.duplicateId) return { kind: "skip", reason: "duplicate-id" };

  // 같은 run에서 이 파일에 반복 회차가 삽입됨 → task.line이 밀려 오손상 위험.
  if (i.task.kind !== "missing" && g.fileDirty) {
    return { kind: "skip", reason: "file-dirty" };
  }

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

function mergePlan(i: DecideInput, local: LocalView): MergePlan {
  const { rec, remote } = i;
  const recStart = rec.start ?? rec.due;

  // ── 어느 쪽에서 무엇이 바뀌었나: 필드별로 판정한다 ──
  // 기준은 양쪽 모두 마지막 동기화 스냅샷(rec). 필드를 따로 보기 때문에
  // "Obsidian에서 ✅ + GCal에서 날짜 이동"처럼 겹치지 않는 변경은 둘 다 살아남는다.
  const obs = {
    due: local.due !== rec.due,
    start: local.start !== recStart,
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

  // ── 가짜 기준선 복구 ──
  // 이벤트에서 복원한 record는 baseline ≡ 원격이라 gcalChanged가 영원히 false다.
  // 그 상태에서 노트가 스테일하면(원격 완료 · 노트 미체크) "로컬이 체크를 풀었다"로 읽혀
  // ✅가 GCal에서 지워진다 — 2026-08-06 롤백 사고의 실제 경로. 신뢰 못 하는 기준선일
  // 때는 원격의 **현재값을 노트와 직접** 비교하고, 정보를 잃지 않는 방향으로만 적용한다.
  const trusted = rec.baselineTrusted !== false;
  const staleUncheck = !trusted && remote?.done === true && !local.done;

  const gc = {
    due: gcalChanged && datesOk && remote!.due !== rec.due,
    start: gcalChanged && datesOk && remote!.start !== recStart,
    done: (gcalChanged && remote!.done !== rec.done) || staleUncheck,
    title: gcalChanged && !!remote!.title && remote!.title !== rec.title,
  };

  // 같은 필드가 양쪽 다 바뀐 경우에만 승자가 필요하다 → GCal 채택(직접 조작한 화면).
  const conflicts: Field[] = [];
  for (const f of ["due", "start", "done", "title"] as Field[]) {
    if (gc[f] && obs[f]) conflicts.push(f);
  }

  const pull: PullOps = {};
  const pulledFields: Field[] = [];
  const merged: Snapshot = {
    due: local.due,
    start: local.start,
    done: local.done,
    title: local.title,
  };

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
  if (gc.title) {
    pull.title = { from: local.title, to: remote!.title! };
    merged.title = remote!.title!;
    pulledFields.push("title");
  }
  if (gc.done) {
    pull.done = remote!.done;
    merged.done = remote!.done;
    pulledFields.push("done");
  }

  // ── done 회귀(완료 → 미완료) 보류 ──
  // 가장 파괴적인 push다. 노트가 최신이라는 확신이 없으면 미룬다. 두 겹:
  //  (a) 이번 run이 그 캘린더를 **읽지 못했으면** 무기한 보류. "이벤트 객체가 없다"가
  //      아니라 "pull을 못 했다"가 기준이다 — 증분 pull에서 변경 없는 이벤트는 원래
  //      응답에 안 온다. 그걸 근거로 삼으면 정상적인 체크 해제가 영영 안 올라간다.
  //  (b) 읽었더라도 **한 사이클 재확인**한다(2단계 삭제 가드와 같은 패턴).
  //      그 사이 Obsidian Sync가 정착하면 회귀 자체가 사라진다.
  const doneRegress = obs.done && !local.done && rec.done && !gc.done;
  let holdDone = false;
  let holdReason: MergePlan["holdReason"];
  let retryAfterMs: number | undefined;
  let uncheckSeen: "set" | "clear" | undefined;
  if (doneRegress) {
    if (!i.guards.remotePulled) {
      holdDone = true;
      holdReason = "remote-unknown";
    } else {
      const seenAt = rec.uncheckSeenAt ?? i.now;
      if (rec.uncheckSeenAt === undefined) uncheckSeen = "set";
      const waited = i.now - seenAt;
      holdDone = waited < i.uncheckHoldMs;
      if (holdDone) {
        holdReason = "recheck";
        // 보류가 풀리는 시점에 한 번 더 돌지 않으면 다음 주기(기본 5분)까지 GCal이
        // 그대로라 "아무 일도 안 일어난다"로 보인다.
        retryAfterMs = i.uncheckHoldMs - waited + 2_000;
      }
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
    (obs.done && !gc.done && !holdDone) ||
    (obs.title && !gc.title);

  return {
    kind: "merge",
    pull,
    pulledFields,
    conflicts,
    pushNeeded,
    // GCal이 이긴 변경만 있어 push할 게 없더라도 **이벤트의 표현은 다시 찍는다.**
    // 캘린더에서 완료색으로 바꾸면 노트는 [x]가 되는데 이벤트 제목은 ☐ 그대로여서
    // 모바일에서는 미완료로 보였다(0.3.17). 단 사용자가 GCal에서 실제로 뭔가 바꾼
    // 경우로 한정한다 — staleUncheck는 원격이 안 바뀐 상태라, 거기서 원격에 쓰기
    // 시작하면 "확신 없으면 원격을 안 건드린다"는 0.3.13의 보장이 무너진다.
    normalizeIfPulled: !pushNeeded && gcalChanged,
    holdDone,
    holdReason,
    retryAfterMs,
    uncheckSeen,
    staleUncheck,
    gcalChanged,
    // 원격을 실제로 본 run에서만 기준선을 승격한다. **"캘린더를 읽었다"로 완화하면 안 된다** —
    // rebuildRecords는 ±730일을 훑는데 pull 초기 창은 30일이라, 그 밖에서 입양된 record가
    // 이벤트를 한 번도 못 본 채 신뢰 상태가 되어 스테일 노트가 ✅를 지운다(2026-08-06 경로).
    promoteBaseline: !!remote,
    merged,
    local: {
      due: local.due,
      start: local.start,
      done: local.done,
      title: local.title,
    },
  };
}

/** run 전체에서 공유되는 가드 상태 → record 하나에 대한 Guards로 좁힌다. */
export class RunGuards {
  constructor(
    private readonly ctx: {
      dupIds: Set<string>;
      dirtyFiles: Set<string>;
      adopted: Set<string>;
      holdWrites: boolean;
      coldHold: boolean;
      pulledCalendars: Set<string>;
    }
  ) {}

  for(id: string, calendarId: string, path?: string): Guards {
    return {
      duplicateId: this.ctx.dupIds.has(id),
      fileDirty: path !== undefined && this.ctx.dirtyFiles.has(path),
      adopted: this.ctx.adopted.has(id),
      holdWrites: this.ctx.holdWrites,
      coldHold: this.ctx.coldHold,
      remotePulled: this.ctx.pulledCalendars.has(calendarId),
    };
  }
}
