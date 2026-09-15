import { VaultTask, taskWhere } from "../../../data/TaskRepository";
import { TaskWriter } from "../../../write/TaskWriter";
import { SyncRecord } from "../../StateStore";
import { titleBase } from "../../codec/presentation";
import { TaskIndex } from "./indexTasks";

/** 스스로 푼 🆔 중복 한 건 — run 이 REPAIR 로그 항목으로 옮긴다. */
export interface DupRepair {
  id: string;
  where: string;
  why: string;
}

// ── 반복(🔁) 완료가 만든 🆔 중복은 **스스로 푼다**(0.9.5) ──
//
// Tasks 는 반복 task 를 완료하면 다음 회차 줄을 만들면서 **원본 🆔를 그대로 복사한다.**
// 그러면 같은 id 가 두 줄이 되어 정본을 특정할 수 없고, 그 id 는 손으로 고칠 때까지
// **영영 동기화가 멈춘다.** `TaskLine.removeId` 의 주석이 처음부터 이 경우를 위한
// 것이라고 적고 있었지만 호출부가 없었다.
//
// 새 회차 줄에서 id 를 뗀다 — 기존 이벤트는 완료된 원래 회차의 것이고, 새 회차는
// 다음 run 이 새 🆔 와 새 이벤트를 준다.
//
// ⛔ **모양이 정확히 이것일 때만 손댄다**: 두 줄뿐이고, 그중 **하나만 완료**이며,
//    둘 다 반복(🔁)이다. Sync 가 블록을 통째로 복제한 경우는 두 줄의 완료 상태가
//    같으므로 여기 걸리지 않는다 — 그때는 사람이 봐야 한다.
//    노트 쓰기이므로 볼트가 정착한 뒤에만 한다.
export async function repairDupIds(
  writer: TaskWriter,
  records: Record<string, SyncRecord>,
  tasks: VaultTask[],
  index: TaskIndex
): Promise<DupRepair[]> {
  const { tasksById, dupIds } = index;
  const dupRepairs: DupRepair[] = [];
  for (const id of [...dupIds]) {
    const lines = tasks.filter((t) => t.id === id);
    if (lines.length !== 2) continue;
    const rec = records[id];

    // (a) 반복(🔁) 완료가 만든 중복 — Tasks 가 새 회차 줄에 원본 id 를 복사한 경우.
    //     기존 이벤트는 완료된 원래 회차의 것이므로 **새 회차 줄**에서 id 를 뗀다.
    let victim: VaultTask | undefined;
    let why = "";
    const open = lines.filter((t) => !t.checked);
    const done = lines.filter((t) => t.checked);
    if (lines.every((t) => t.recurrence) && open.length === 1 && done.length === 1) {
      victim = open[0];
      why = "반복(🔁) 완료가 만든 중복 → 새 회차 줄에서 🆔 제거";
    }
    // (b) **서로 다른 task 가 같은 🆔** — 줄을 복사하며 🆔까지 딸려온 경우.
    //     record 가 마지막으로 동기화한 제목과 맞는 쪽이 원본이다. 정확히 한 쪽만
    //     맞을 때만 손댄다 — 둘 다 맞거나 둘 다 아니면 사람이 봐야 한다.
    else if (rec?.title) {
      const mine = lines.filter((t) => titleBase(t) === rec.title);
      if (mine.length === 1) {
        victim = lines.find((t) => t !== mine[0]);
        why = `서로 다른 task 가 같은 🆔 → 원본(제목 "${rec.title}")이 아닌 줄에서 🆔 제거`;
      }
    }
    if (!victim) continue;

    try {
      await writer.removeId(victim);
      dupIds.delete(id);
      const keep = lines.find((t) => t !== victim)!;
      tasksById.set(id, keep);
      const where = taskWhere(victim);
      dupRepairs.push({ id, where, why });
      console.warn(`[tasks-gcal-sync] 🆔 ${id} 중복 자동 정리: ${why} ${where}`);
    } catch (e) {
      console.warn("[tasks-gcal-sync] 🆔 중복 자동 정리 실패:", id, e);
    }
  }
  return dupRepairs;
}
