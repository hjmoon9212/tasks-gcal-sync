import { App, TFile } from "obsidian";
import { VaultTask } from "../data/TaskRepository";
import * as TaskLine from "../data/TaskLine";

export class TaskLineDriftError extends Error {
  constructor(path: string, line: number) {
    super(`Task line drift at ${path}:${line + 1} — skip write`);
    this.name = "TaskLineDriftError";
  }
}

/**
 * 파일 쓰기 담당. vault.process로 원자적 read-modify-write를 하고,
 * 저장 직전 대상 줄이 기대한 원문(raw)과 같은지 재검증(Obsidian Sync 경합 가드).
 * 어긋나면 절대 쓰지 않고 throw → 호출자가 skip.
 */
export class TaskWriter {
  /** 우리가 방금 쓴 파일 (vault.on("modify") 자기 에코 억제용). path → 쓴 시각(ms) */
  private readonly recentWrites = new Map<string, number>();

  constructor(private app: App, private getGlobalFilter: () => string) {}

  /** windowMs 안에 우리가 쓴 파일이면 true. 지난 항목은 조회 시 정리한다. */
  wroteRecently(path: string, windowMs: number): boolean {
    const t = this.recentWrites.get(path);
    if (t === undefined) return false;
    if (Date.now() - t > windowMs) {
      this.recentWrites.delete(path);
      return false;
    }
    return true;
  }

  private async apply(
    task: VaultTask,
    transform: (raw: string) => string
  ): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${task.path}`);

    let updated = "";
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const current = lines[task.line];
      if (current !== task.raw) {
        throw new TaskLineDriftError(task.path, task.line);
      }
      updated = transform(current);
      lines[task.line] = updated;
      return lines.join("\n");
    });
    task.raw = updated; // 캐시 동기화
    this.recentWrites.set(task.path, Date.now());
    this.refresh(task, updated);
    return updated;
  }

  /**
   * 쓰기 후 인메모리 task의 파싱 필드(due/start/checked/title…)를 새 원문에 맞춘다.
   * 이게 없으면 같은 sync run 안에서 이어지는 push가 낡은 값을 올린다
   * (예: GCal 날짜를 pull로 반영한 직후 Obsidian 변경분을 push할 때).
   * 파싱이 안 되는 결과면 그대로 둔다.
   */
  private refresh(task: VaultTask, updated: string): void {
    const parsed = TaskLine.parseTaskLine(updated, this.getGlobalFilter());
    if (parsed) Object.assign(task, parsed);
  }

  ensureId(task: VaultTask, id: string): Promise<string> {
    return this.apply(task, (raw) => TaskLine.setId(raw, id));
  }

  setDue(task: VaultTask, date: string): Promise<string> {
    return this.apply(task, (raw) => TaskLine.setDue(raw, date));
  }

  removeDue(task: VaultTask): Promise<string> {
    return this.apply(task, (raw) => TaskLine.removeDue(raw));
  }

  setStart(task: VaultTask, date: string): Promise<string> {
    return this.apply(task, (raw) => TaskLine.setStart(raw, date));
  }

  removeStart(task: VaultTask): Promise<string> {
    return this.apply(task, (raw) => TaskLine.removeStart(raw));
  }

  /** ⏰ 타임블록 지정(첫 필드 이모지 앞에 삽입 — Tasks 파싱을 깨지 않기 위해). */
  setTime(task: VaultTask, range: string): Promise<string> {
    return this.apply(task, (raw) => TaskLine.setTime(raw, range));
  }

  removeTime(task: VaultTask): Promise<string> {
    return this.apply(task, (raw) => TaskLine.removeTime(raw));
  }

  /** GCal 제목 → task 본문 제목 교체(정확히 1회 매칭될 때만, 아니면 throw로 skip). */
  replaceTitle(
    task: VaultTask,
    oldTitle: string,
    newTitle: string
  ): Promise<string> {
    return this.apply(task, (raw) => {
      const r = TaskLine.replaceTitle(raw, oldTitle, newTitle);
      if (r === null) throw new Error("title replace skipped (모호한 매칭)");
      return r;
    });
  }
}
