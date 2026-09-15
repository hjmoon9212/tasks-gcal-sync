import { VaultTask, taskWhere } from "../../../data/TaskRepository";

export interface TaskIndex {
  tasksById: Map<string, VaultTask>;
  /** 이번 run 에 파싱된 🆔 전부 — 새 🆔 발급 때 후보에서 뺀다. */
  existingIds: Set<string>;
  /** 정본 불명 🆔. repairDupIds 가 푼 것은 여기서 빠진다. */
  dupIds: Set<string>;
  /** 중복 🆔의 위치 — 로그 파일에도 실어야 재시작 뒤에 찾을 수 있다. */
  dupWhere: Map<string, string>;
}

/**
 * task 목록을 🆔 로 색인하고 **같은 🆔 가 두 줄 이상**인 id 를 모은다.
 *
 * 같은 🆔가 두 줄 이상이면 병합이 덜 끝난 노트다(Sync가 블록을 중복시킨 경우 등).
 * 어느 줄이 정본인지 알 수 없으므로 그 id는 이번 run에서 통째로 건드리지 않는다.
 */
export function indexTasks(tasks: VaultTask[]): TaskIndex {
  const tasksById = new Map<string, VaultTask>();
  const existingIds = new Set<string>();
  // 같은 🆔가 두 줄 이상이면 병합이 덜 끝난 노트다(Sync가 블록을 중복시킨 경우 등).
  // 어느 줄이 정본인지 알 수 없으므로 그 id는 이번 run에서 통째로 건드리지 않는다 —
  // 임의의 줄에 쓰면 중복이 조용히 누적된다.
  const dupIds = new Set<string>();
  for (const t of tasks) {
    if (!t.id) continue;
    if (existingIds.has(t.id)) dupIds.add(t.id);
    tasksById.set(t.id, t);
    existingIds.add(t.id);
  }
  /** 중복 🆔의 위치 — 로그 파일에도 실어야 재시작 뒤에 찾을 수 있다. */
  const dupWhere = new Map<string, string>();
  for (const id of dupIds) {
    const where = tasks
      .filter((t) => t.id === id)
      .map((t) => taskWhere(t))
      .join(", ");
    dupWhere.set(id, where);
    console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 → 건너뜀: ${where}`);
  }
  return { tasksById, existingIds, dupIds, dupWhere };
}
