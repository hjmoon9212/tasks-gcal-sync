import { App } from "obsidian";
import { VaultTask } from "../data/TaskRepository";
import * as TaskLine from "../data/TaskLine";
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

  /**
   * 반복 완료 시 Tasks API는 [새 회차(미완료) 줄] + [완료 줄] 2줄을 돌려주는데,
   * 새 회차 줄이 원본 🆔를 그대로 복사해 온다 → 같은 id가 두 줄에 생겨
   * (records 매핑 충돌 → 잘못된 줄에 날짜가 써지는 mangling·중복 이벤트의 근본 원인).
   * 완료([x]) 줄만 원본 id를 유지(기존 이벤트에 매핑)하고, 새 회차 줄의 🆔는 제거한다.
   * → 다음 sync에서 새 회차에 유일 id가 발급되고 별도 이벤트로 생성된다.
   */
  private dedupeRecurrenceIds(newText: string): string {
    const lines = newText.split("\n");
    if (lines.length < 2) return newText; // 단일 줄(비반복) → 그대로
    return lines
      .map((l) => {
        if (!TaskLine.isTaskLine(l)) return l;
        const done = /^\s*[-*+] \[[xX]\]/.test(l);
        return done ? l : TaskLine.removeId(l);
      })
      .join("\n");
  }

  /** 완료 처리. 줄 수가 늘어난(반복 회차 삽입 = 구조 변경) 경우 true 반환. */
  async complete(
    task: VaultTask,
    writer: TaskWriter,
    today: string
  ): Promise<boolean> {
    const api = this.tasksApi();
    const fn = api?.executeToggleTaskDoneCommand;
    if (typeof fn === "function") {
      try {
        const newText = fn.call(api, task.raw, task.path);
        if (typeof newText === "string" && newText.trim().length) {
          const fixed = this.dedupeRecurrenceIds(newText);
          await writer.replaceLine(task, fixed);
          return fixed.includes("\n");
        }
      } catch (e) {
        console.warn("[tasks-gcal-sync] Tasks API 완료 실패, 폴백:", e);
      }
    }
    await writer.completeFallback(task, today);
    return false;
  }

  uncomplete(task: VaultTask, writer: TaskWriter): Promise<string> {
    return writer.uncomplete(task);
  }
}
