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
  constructor(private app: App) {}

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
    return updated;
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

  setStatusChar(task: VaultTask, char: string): Promise<string> {
    return this.apply(task, (raw) => TaskLine.setStatusChar(raw, char));
  }

  /** Tasks API 토글 결과(반복 시 2줄일 수 있음)로 줄 전체 교체. */
  replaceLine(task: VaultTask, newText: string): Promise<string> {
    return this.apply(task, () => newText);
  }

  /** 폴백 완료: 상태 x + ✅오늘. */
  completeFallback(task: VaultTask, today: string): Promise<string> {
    return this.apply(task, (raw) =>
      TaskLine.setDoneDate(TaskLine.setStatusChar(raw, "x"), today)
    );
  }

  /** 완료 취소: 상태 공백 + ✅제거. */
  uncomplete(task: VaultTask): Promise<string> {
    return this.apply(task, (raw) =>
      TaskLine.removeDone(TaskLine.setStatusChar(raw, " "))
    );
  }
}
