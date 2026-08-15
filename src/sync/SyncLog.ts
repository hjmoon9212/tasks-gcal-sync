/*
 * 동기화 상세 로그 — **무엇이 왜 바뀌었는지를 나중에 확인할 수 있게 파일로 남긴다.**
 *
 * 왜 필요한가: 결과를 보여주는 통로가 지금까지 셋 다 휘발성이었다.
 *  - Notice: 10초 뒤 사라진다.
 *  - 상태바/리포트(showReport): 마지막 run 하나만, 그것도 합계뿐.
 *  - console: Obsidian을 껐다 켜면 날아간다.
 * "-2 가 왜 지워졌나"는 그 run이 끝나는 순간 답할 방법이 없어진다. 특히 삭제·완료 해제처럼
 * 되돌리기 힘든 동작일수록 사후 추적이 필요하다(2026-08-09 CISS 참고).
 *
 * 여기는 포맷과 파일 I/O만 한다. 무엇을 기록할지는 SyncEngine이 정하고(SyncLogEntry),
 * 언제 쓸지는 main이 정한다 — 판단/실행/기록을 섞지 않는 이 레포의 구조를 따른다.
 */
import { App, normalizePath } from "obsidian";

export type LogAction =
  | "CREATE" // 새 이벤트 생성
  | "UPDATE" // 기존 이벤트 수정 push
  | "MOVE" // 대상 캘린더 변경 → 삭제 후 재생성
  | "DELETE" // 이벤트 삭제
  | "PULL" // GCal → 노트 반영
  | "UNSCHEDULE" // 이벤트가 지워져 노트의 📅 제거
  | "DROP" // 이벤트만 정리하고 record 폐기(📅는 남김)
  | "ADOPT" // GCal에 이미 있던 이벤트를 record로 회수
  | "HOLD" // 판단은 섰지만 이번 run엔 미룸
  | "SKIP" // 건드리지 않음(사유 있음)
  | "FAIL"; // 실패

export interface SyncLogEntry {
  action: LogAction;
  id?: string; // task 🆔
  title?: string;
  calendar?: string; // 캘린더 표시명(모르면 id)
  eventId?: string;
  where?: string; // 노트 경로:줄
  detail?: string;
}

export interface SyncLogConfig {
  enabled: boolean;
  path: string; // 볼트 루트 기준
  maxKB: number; // 0 = 무제한
  logSkips: boolean; // SKIP/HOLD/FAIL 도 남길지
}

const HEADER = "# Tasks ⇄ GCal 동기화 로그\n";

/** 로컬 시각 YYYY-MM-DD HH:mm:ss. 로그는 사람이 읽으므로 UTC로 적지 않는다. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 개행이 섞이면 목록 한 줄이 깨진다 → 한 줄로 편다. */
function flat(s: string): string {
  return s.replace(/\s*\n\s*/g, " ⏎ ").trim();
}

/**
 * 한 줄 형식: `- ACTION `🆔` "제목" cal=… ev=… @노트:줄 — 상세`
 * 식별 정보를 앞에 고정해 훑기 쉽게 하고, 길이가 들쭉날쭉한 상세는 맨 뒤로 보낸다.
 */
export function formatEntry(e: SyncLogEntry): string {
  const head: string[] = [`- ${e.action}`];
  if (e.id) head.push(`\`${e.id}\``);
  if (e.title) head.push(`"${flat(e.title)}"`);
  if (e.calendar) head.push(`cal=${flat(e.calendar)}`);
  if (e.eventId) head.push(`ev=${e.eventId}`);
  if (e.where) head.push(`@${e.where}`);
  const line = head.join(" ");
  return e.detail ? `${line} — ${flat(e.detail)}` : line;
}

/** 이번 run 블록 전체(헤더 1줄 + 항목들). 파일에 붙일 문자열을 만든다. */
export function formatBlock(
  summary: string,
  trigger: string,
  entries: SyncLogEntry[],
  now = new Date()
): string {
  return (
    `\n## ${stamp(now)} · ${summary} · ${trigger}\n` +
    entries.map(formatEntry).join("\n") +
    "\n"
  );
}

/** 설정에 따라 기록 대상만 남긴다. 조용한 run(=남길 게 없는 run)은 빈 배열이 된다. */
export function selectEntries(
  entries: SyncLogEntry[],
  logSkips: boolean
): SyncLogEntry[] {
  if (logSkips) return entries;
  const noisy: LogAction[] = ["SKIP", "HOLD", "FAIL"];
  return entries.filter((e) => !noisy.includes(e.action));
}

export class SyncLogWriter {
  constructor(private app: App, private config: () => SyncLogConfig) {}

  path(): string {
    return normalizePath(this.config().path);
  }

  /**
   * 한 run의 결과를 append.
   * 남길 항목이 없으면 아무것도 쓰지 않는다 — 5분 주기 동기화가 "변화 없음"으로
   * 파일을 채우면 정작 찾아야 할 삭제 한 줄이 묻힌다.
   */
  async append(
    summary: string,
    entries: SyncLogEntry[],
    trigger: string
  ): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled) return;
    const shown = selectEntries(entries, cfg.logSkips);
    if (shown.length === 0) return;

    const path = this.path();
    const block = formatBlock(summary, trigger, shown);
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) {
        await this.ensureParent(path);
        await adapter.write(path, HEADER + this.legend() + block);
        return;
      }
      await adapter.append(path, block);
      await this.trim(path, cfg.maxKB);
    } catch (e) {
      // 로그를 못 쓰는 것이 동기화를 막아선 안 된다.
      console.error("[tasks-gcal-sync] 동기화 로그 기록 실패:", path, e);
    }
  }

  private legend(): string {
    return (
      "\n요약 기호: `+`생성 `~`수정 `↔`캘린더이동 `-`삭제 `⬇`노트반영\n" +
      "상세 기호: `⬇`GCal→노트 `⬆`노트→GCal `⚔️`충돌(같은 필드를 양쪽에서 수정) `⏸`보류\n"
    );
  }

  private async ensureParent(path: string): Promise<void> {
    const i = path.lastIndexOf("/");
    if (i < 0) return;
    const dir = path.slice(0, i);
    const adapter = this.app.vault.adapter;
    if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
  }

  /**
   * maxKB를 넘으면 오래된 앞부분을 잘라낸다.
   * 자를 위치는 run 블록 경계(`\n## `)로 맞춘다 — 항목 중간에서 끊으면 그 run의 기록이
   * 반쪽만 남아 오히려 오해를 만든다.
   */
  private async trim(path: string, maxKB: number): Promise<void> {
    if (maxKB <= 0) return;
    const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(path);
    const limit = maxKB * 1024;
    if (!stat || stat.size <= limit) return;

    const text = await adapter.read(path);
    // 상한의 80%만 남긴다. 딱 상한에 맞추면 다음 run마다 다시 자르게 된다.
    const keep = Math.floor(limit * 0.8);
    let cut = Math.max(0, text.length - keep);
    const boundary = text.indexOf("\n## ", cut);
    cut = boundary >= 0 ? boundary + 1 : cut;
    await adapter.write(
      path,
      HEADER +
        `\n*(${maxKB}KB 상한 — ${stamp()} 에 이 지점 앞의 오래된 기록을 잘라냈다)*\n` +
        this.legend() +
        "\n" +
        text.slice(cut)
    );
  }
}
