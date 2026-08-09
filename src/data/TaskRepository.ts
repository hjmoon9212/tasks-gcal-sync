import { App, CachedMetadata, TFile } from "obsidian";
import { ParsedTask, parseTaskLine } from "./TaskLine";

export interface VaultTask extends ParsedTask {
  path: string;
  line: number; // 0-based
  raw: string; // 원본 줄 (drift 가드 비교용)
}

/**
 * 볼트 전체에서 globalFilter에 걸리는 task 줄을 수집.
 * metadataCache 로 **파일을 열기 전에** 두 번 거른다 — 체크박스가 있는가(listItems),
 * globalFilter 태그가 있는가(tags). 통과한 파일만 cachedRead 로 읽어 파싱한다.
 * Dataview 의존 없음 — 코어 metadataCache만 사용.
 */
export class TaskRepository {
  constructor(private app: App, private getGlobalFilter: () => string) {}

  /**
   * globalFilter 태그가 이 파일 어딘가에 색인돼 있는가 — **파일을 열기 전에** 판단한다.
   *
   * 이 검사가 없으면 체크박스가 하나라도 있는 모든 노트를 매 sync 마다 읽는다(주기 5분 +
   * 편집 디바운스). 대부분의 노트는 `#task` 가 없는 일반 체크리스트다.
   *
   * `#task/sheet` 같은 하위태그도 대상이므로 `startsWith` 로 본다 —
   * `parseTaskLine` 이 `body.includes(filter)` 로 거르는 것과 같은 범위다.
   * globalFilter 가 비어 있으면(전체 대상) 이 검사는 통과시킨다.
   */
  private mayHaveTasks(cache: CachedMetadata, filter: string): boolean {
    if (!filter) return true;
    if (cache.tags?.some((t) => t.tag.startsWith(filter))) return true;
    // frontmatter 로 붙인 태그는 `#` 없이 저장된다.
    const bare = filter.startsWith("#") ? filter.slice(1) : filter;
    const fm = cache.frontmatter?.tags;
    const list = Array.isArray(fm) ? fm : typeof fm === "string" ? [fm] : [];
    return list.some((t) => typeof t === "string" && t.startsWith(bare));
  }

  async getTasks(): Promise<VaultTask[]> {
    const filter = this.getGlobalFilter();
    const out: VaultTask[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const items = cache?.listItems;
      if (!items || !items.some((li) => li.task !== undefined)) continue;
      if (!this.mayHaveTasks(cache!, filter)) continue;

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
