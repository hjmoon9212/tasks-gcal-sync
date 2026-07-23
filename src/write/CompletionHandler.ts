import { App } from "obsidian";
import { VaultTask } from "../data/TaskRepository";
import { TaskWriter } from "./TaskWriter";

/**
 * 완료/취소 처리. 완료는 Obsidian Tasks 플러그인의 apiV1을 재사용해
 * 🔁 반복 규칙(다음 회차 생성)을 그대로 활용한다. API 없으면 폴백.
 */
export class CompletionHandler {
  constructor(private app: App) {}

  private tasksApi(): any {
    return (this.app as any).plugins?.plugins?.["obsidian-tasks-plugin"]?.apiV1;
  }

  async complete(
    task: VaultTask,
    writer: TaskWriter,
    today: string
  ): Promise<void> {
    const api = this.tasksApi();
    const fn = api?.executeToggleTaskDoneCommand;
    if (typeof fn === "function") {
      try {
        const newText = fn.call(api, task.raw, task.path);
        if (typeof newText === "string" && newText.trim().length) {
          await writer.replaceLine(task, newText);
          return;
        }
      } catch (e) {
        console.warn("[tasks-gcal-sync] Tasks API 완료 실패, 폴백:", e);
      }
    }
    await writer.completeFallback(task, today);
  }

  uncomplete(task: VaultTask, writer: TaskWriter): Promise<string> {
    return writer.uncomplete(task);
  }
}
