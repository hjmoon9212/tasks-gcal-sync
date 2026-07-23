import { App, TFile } from "obsidian";
import { ParsedTask, parseTaskLine } from "./TaskLine";

export interface VaultTask extends ParsedTask {
  path: string;
  line: number; // 0-based
  raw: string; // 원본 줄 (drift 가드 비교용)
}

/**
 * 볼트 전체에서 globalFilter에 걸리는 task 줄을 수집.
 * metadataCache.listItems로 task 위치를 먼저 찾고 해당 파일만 읽어 파싱(효율).
 * Dataview 의존 없음 — 코어 metadataCache만 사용.
 */
export class TaskRepository {
  constructor(private app: App, private getGlobalFilter: () => string) {}

  async getTasks(): Promise<VaultTask[]> {
    const filter = this.getGlobalFilter();
    const out: VaultTask[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const items = cache?.listItems;
      if (!items || !items.some((li) => li.task !== undefined)) continue;

      let lines: string[] | null = null;
      for (const li of items) {
        if (li.task === undefined) continue;
        if (!lines) lines = (await this.app.vault.cachedRead(file)).split("\n");
        const lineNo = li.position.start.line;
        const raw = lines[lineNo];
        if (raw === undefined) continue;
        const parsed = parseTaskLine(raw, filter);
        if (!parsed) continue;
        out.push({ ...parsed, path: file.path, line: lineNo, raw });
      }
    }
    return out;
  }

  getFile(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }
}
