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

/** 시:분:초만 (접힌 블록의 끝 시각처럼 날짜가 뻔한 자리에 쓴다). */
function hms(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 파일에 적힌 run 블록 하나. 같은 내용이 이어지면 새 블록을 만들지 않고 이걸 갱신한다.
 * (`count`>1 이면 접힌 블록)
 */
export interface LogBlock {
  /** 접기 판정 기준 — 항목 줄이 완전히 같을 때만 같은 블록으로 본다. */
  signature: string;
  summary: string;
  /** 관측된 계기들(중복 제거). 반복 중에 주기/편집이 섞이는 게 정상이다. */
  triggers: string[];
  first: Date;
  last: Date;
  count: number;
  lines: string[];
}

export function newBlock(
  summary: string,
  trigger: string,
  entries: SyncLogEntry[],
  now = new Date()
): LogBlock {
  const lines = entries.map(formatEntry);
  return {
    signature: lines.join("\n"),
    summary,
    triggers: [trigger],
    first: now,
    last: now,
    count: 1,
    lines,
  };
}

/** 같은 내용이 한 번 더 관측됨 → 새 블록 대신 횟수와 끝 시각만 늘린다. */
export function extendBlock(b: LogBlock, trigger: string, now = new Date()): LogBlock {
  return {
    ...b,
    triggers: b.triggers.includes(trigger) ? b.triggers : [...b.triggers, trigger],
    last: now,
    count: b.count + 1,
  };
}

/** 블록을 파일에 적을 문자열로. 접힌 블록은 헤더에 기간과 횟수를 단다. */
export function renderBlock(b: LogBlock): string {
  const when =
    b.count > 1 ? `${stamp(b.first)} ~ ${hms(b.last)}` : stamp(b.first);
  const trig =
    b.triggers.length > 1 ? `${b.triggers[0]} 외 ${b.triggers.length - 1}종` : b.triggers[0];
  const times = b.count > 1 ? ` · ×${b.count}회` : "";
  return `\n## ${when} · ${b.summary} · ${trig}${times}\n` + b.lines.join("\n") + "\n";
}

/** 이번 run 블록 전체(헤더 1줄 + 항목들). 파일에 붙일 문자열을 만든다. */
export function formatBlock(
  summary: string,
  trigger: string,
  entries: SyncLogEntry[],
  now = new Date()
): string {
  return renderBlock(newBlock(summary, trigger, entries, now));
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
  /**
   * 파일 끝에 적혀 있는 블록. 다음 run이 같은 내용이면 새로 붙이는 대신 이걸 고쳐 쓴다.
   * 로드마다 초기화된다 — 그때는 접기가 한 번 끊길 뿐, 기록이 틀어지지는 않는다.
   */
  private tail: LogBlock | null = null;

  constructor(private app: App, private config: () => SyncLogConfig) {}

  path(): string {
    return normalizePath(this.config().path);
  }

  /**
   * 한 run의 결과를 기록한다.
   *
   * 남길 항목이 없으면 아무것도 쓰지 않는다 — 5분 주기 동기화가 "변화 없음"으로
   * 파일을 채우면 정작 찾아야 할 삭제 한 줄이 묻힌다.
   *
   * **같은 내용이 이어지면 블록을 새로 만들지 않고 `× N회` 로 접는다.** 볼트가 Sync 중일
   * 때의 run 보류는 편집이 잦으면 십수 초마다 같은 줄을 남겨 파일을 채웠다(2026-08-16).
   * 접어도 정보는 안 잃는다 — 첫 시각·끝 시각·횟수·계기가 헤더에 남는다.
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
    const fresh = newBlock(summary, trigger, shown);
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) {
        await this.ensureParent(path);
        await adapter.write(path, HEADER + this.legend() + renderBlock(fresh));
        this.tail = fresh;
        return;
      }
      if (this.tail && this.tail.signature === fresh.signature) {
        const merged = extendBlock(this.tail, trigger);
        if (await this.rewriteTail(path, renderBlock(this.tail), renderBlock(merged))) {
          this.tail = merged;
          return;
        }
        // 파일 끝이 우리가 아는 모양이 아니다(트림·사용자 편집·다른 기기) → 그냥 새로 붙인다.
      }
      await adapter.append(path, renderBlock(fresh));
      this.tail = fresh;
      await this.trim(path, cfg.maxKB);
    } catch (e) {
      // 로그를 못 쓰는 것이 동기화를 막아선 안 된다.
      console.error("[tasks-gcal-sync] 동기화 로그 기록 실패:", path, e);
      this.tail = null; // 실패했으면 파일 끝 상태를 더는 알 수 없다
    }
  }

  /**
   * 파일 끝의 블록을 갱신본으로 갈아끼운다. 끝이 `prev` 와 정확히 같을 때만 손대고,
   * 아니면 false 를 돌려 호출부가 append 로 폴백하게 한다 — 남의 기록을 덮어쓰느니
   * 줄이 하나 늘어나는 편이 낫다.
   */
  private async rewriteTail(
    path: string,
    prev: string,
    next: string
  ): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const text = await adapter.read(path);
    if (!text.endsWith(prev)) return false;
    await adapter.write(path, text.slice(0, text.length - prev.length) + next);
    return true;
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
