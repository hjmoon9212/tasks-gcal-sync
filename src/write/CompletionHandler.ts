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
   * Tasks API 결과를 정규화한다. 두 가지를 한다:
   *
   * 1) **반복 🆔 중복 제거** — 반복 완료 시 Tasks API는 [새 회차(미완료) 줄] +
   *    [완료 줄] 2줄을 돌려주는데, 새 회차 줄이 원본 🆔를 그대로 복사해 온다 →
   *    같은 id가 두 줄에 생겨(records 매핑 충돌 → 잘못된 줄에 날짜가 써지는
   *    mangling·중복 이벤트의 근본 원인). 완료([x]) 줄만 원본 id를 유지하고
   *    새 회차 줄의 🆔는 제거 → 다음 sync에서 유일 id가 발급된다.
   *
   * 2) **✅ 완료일 고정** — Tasks API는 "그 기기의 오늘"을 찍는다. GCal에서 완료를
   *    받아온 경우 기기마다 다른 문자열이 만들어지고, Obsidian Sync가 두 사본을
   *    병합하면서 블록을 통째로 중복시키는 원인이 됐다(2026-08-05/06).
   *    doneDate(이벤트가 완료로 바뀐 날)로 덮어써 **어느 기기에서 언제 돌아도
   *    같은 결과**가 나오게 한다.
   */
  private normalizeCompletion(newText: string, doneDate: string): string {
    const lines = newText.split("\n");
    const multi = lines.length > 1; // 여러 줄 = 반복 회차가 삽입된 경우
    return lines
      .map((l) => {
        if (!TaskLine.isTaskLine(l)) return l;
        if (/^\s*[-*+] \[[xX]\]/.test(l)) {
          return TaskLine.setDoneDate(TaskLine.removeDone(l), doneDate);
        }
        // 미완료 줄의 🆔 제거는 "새 회차가 원본 id를 복사해온" 경우에만.
        // 단일 줄 결과에서 지우면 멀쩡한 매핑을 잃는다.
        return multi ? TaskLine.removeId(l) : l;
      })
      .join("\n");
  }

  /**
   * 완료 처리. 줄 수가 늘어난(반복 회차 삽입 = 구조 변경) 경우 true 반환.
   * @param doneDate 찍을 ✅ 날짜. 호출부가 결정적인 값을 넘긴다.
   */
  async complete(
    task: VaultTask,
    writer: TaskWriter,
    doneDate: string
  ): Promise<boolean> {
    const api = this.tasksApi();
    const fn = api?.executeToggleTaskDoneCommand;
    if (typeof fn === "function") {
      try {
        const newText = fn.call(api, task.raw, task.path);
        if (typeof newText === "string" && newText.trim().length) {
          const fixed = this.normalizeCompletion(newText, doneDate);
          await writer.replaceLine(task, fixed);
          return fixed.includes("\n");
        }
      } catch (e) {
        console.warn("[tasks-gcal-sync] Tasks API 완료 실패, 폴백:", e);
      }
    }
    await writer.completeFallback(task, doneDate);
    return false;
  }

  uncomplete(task: VaultTask, writer: TaskWriter): Promise<string> {
    return writer.uncomplete(task);
  }
}
