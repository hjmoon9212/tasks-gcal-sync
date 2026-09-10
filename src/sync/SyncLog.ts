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
  | "REPAIR" // 노트를 고쳐 막힌 상태를 푼다(반복 완료의 🆔 중복 등)
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
/** 파일명에 못 쓰는 문자와 경로 구분자를 없앤다. 태그는 사람이 고칠 수 있는 값이다. */
function safeTag(tag: string): string {
  return tag
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/**
 * `Logs/x.md` + `HJMoon` → `Logs/x (HJMoon).md`
 *
 * **한 파일에 두 기기가 쓰면 안 된다.** 로그는 볼트 안 일반 노트라 Obsidian Sync의
 * 텍스트 병합 대상이고, 접기(× N회)는 파일 끝 블록을 고쳐 쓰는 동작이라 두 기기가 같은
 * 줄을 다르게 고치는 상황이 정상 동작으로 생긴다. 그러면 병합기가 할 수 있는 최선이
 * "둘 다 남기거나 한쪽을 버리는 것"이고, 실제로 그렇게 됐다 — 2026-09-07 실측에서
 * 한 볼트의 로그는 **11%가 완전 중복 블록**이었고 시각이 역전된 지점이 6곳,
 * 콘솔에 남은 run이 통째로 사라진 구간도 있었다.
 *
 * 감지나 병합으로 풀 문제가 아니다. **파일마다 기록자를 하나로 두면** 병합기가
 * 무엇이든(LWW든 텍스트 병합이든) 손상 자체가 성립하지 않는다. 다른 기기로는 여전히
 * 동기화돼 읽을 수 있고, 덤으로 "어느 기기가 했나"를 파일 이름이 답해준다.
 */
export function withDeviceTag(basePath: string, tag: string): string {
  const clean = safeTag(tag);
  if (!clean) return basePath;
  const slash = basePath.lastIndexOf("/");
  const dot = basePath.lastIndexOf(".");
  // 확장자가 없거나(`Logs/log`) 점이 폴더명에만 있으면(`a.b/log`) 뒤에 붙인다.
  if (dot <= slash) return `${basePath} (${clean})`;
  return `${basePath.slice(0, dot)} (${clean})${basePath.slice(dot)}`;
}

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

/**
 * 보류만 있는 블록을 쌓아 두었다가 **강제로 내보내는 상한**(ms).
 *
 * 조용해질 때까지 무한정 미루면 "지금 왜 멈춰 있나"를 실시간으로 볼 수 없다.
 * 이 간격 안에는 한 번은 내보낸다 — 한 번의 쓰기는 짧고, 그 뒤 다시 조용해진다.
 */
const HOLD_FLUSH_MS = 60_000;

export class SyncLogWriter {
  /**
   * **파일에 실제로 적혀 있는** 끝 블록. `rewriteTail` 의 비교 기준이라 반드시 디스크
   * 상태여야 한다. 로드마다 초기화된다 — 그때는 접기가 한 번 끊길 뿐이다.
   */
  private tail: LogBlock | null = null;
  /**
   * 아직 파일에 안 쓴 블록들. `replacesTail` 은 첫 항목에만 붙을 수 있고, 디스크 끝
   * 블록을 고쳐 써서 반영해야 한다는 뜻이다(접기).
   */
  private queue: { block: LogBlock; replacesTail: boolean }[] = [];
  /** 마지막으로 파일을 실제로 건드린 시각. */
  private lastWriteAt = 0;

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
   * **같은 내용이 이어지면 블록을 새로 만들지 않고 `× N회` 로 접는다.** 접어도 정보는
   * 안 잃는다 — 첫 시각·끝 시각·횟수·계기가 헤더에 남는다.
   *
   * ⛔ **보류·건너뜀만 있는 run 은 파일에 바로 쓰지 않고 쌓아 둔다.**
   *
   * 이 파일은 볼트 안에 있고, 볼트에 쓰면 Obsidian Sync 가 그것을 업로드한다. 업로드가
   * 도는 동안 `vaultBehind()` 는 참이고, 참이면 run 이 보류되고, 보류도 로그 항목이라
   * 또 쓴다 — **자기 쓰기가 자기 관측을 오염시킨다:**
   *
   *     run 보류 → 로그 쓰기 → Sync 업로드(syncing=true) → 15초 뒤 재확인도 보류
   *       → 또 로그 쓰기 → …
   *
   * 2026-09-10 에 볼트가 15~30초마다 "따라잡는 중"으로 깜빡여 `vaultUnsettled`(30초 연속
   * 정착)가 안 풀렸고, 그래서 삭제·충돌 해결·새 🆔 발급이 3분 넘게 멈췄다. 보류 블록이
   * 두 종류라 번갈아 나오면 접기로도 못 막는다 — 서로 "다른 내용"이라 매번 쓴다.
   *
   * 그래서 기준을 **내용의 동일성이 아니라 종류**로 잡는다: 실제로 무언가 일어난 블록
   * (CREATE·UPDATE·DELETE·PULL…)은 지금처럼 즉시 쓰고, **보류·건너뜀뿐이면 쌓아 둔다.**
   * 볼트가 조용해져 일이 실제로 일어나는 순간 쌓인 것이 함께 나간다.
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

    this.enqueue(newBlock(summary, trigger, shown), trigger);

    const quietOnly = shown.every(
      (e) => e.action === "HOLD" || e.action === "SKIP"
    );
    if (!quietOnly || Date.now() - this.lastWriteAt >= HOLD_FLUSH_MS) {
      await this.flush();
    }
  }

  /** 새 블록을 대기열에 넣는다. 직전과 같은 내용이면 새로 만들지 않고 접는다. */
  private enqueue(fresh: LogBlock, trigger: string): void {
    const last = this.queue[this.queue.length - 1];
    if (last) {
      if (last.block.signature === fresh.signature) {
        last.block = extendBlock(last.block, trigger);
        return;
      }
    } else if (this.tail && this.tail.signature === fresh.signature) {
      // 디스크 끝 블록의 연장 → 새로 붙이지 않고 그 블록을 고쳐 쓴다.
      this.queue.push({ block: extendBlock(this.tail, trigger), replacesTail: true });
      return;
    }
    this.queue.push({ block: fresh, replacesTail: false });
  }

  /**
   * 쌓인 블록을 파일에 반영한다. 쓸 게 없으면 아무것도 하지 않는다.
   * 호출부: 실제 사건이 있는 run · 상한 초과 · 종료 직전(main).
   */
  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const path = this.path();
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) {
        await this.ensureParent(path);
        const body = this.queue.map((q) => renderBlock(q.block)).join("");
        await adapter.write(path, HEADER + this.legend() + body);
        this.tail = this.queue[this.queue.length - 1].block;
        this.queue = [];
        this.lastWriteAt = Date.now();
        return;
      }
      let text = "";
      for (const item of this.queue) {
        if (item.replacesTail && this.tail && !text) {
          if (
            await this.rewriteTail(path, renderBlock(this.tail), renderBlock(item.block))
          ) {
            this.tail = item.block;
            continue;
          }
          // 파일 끝이 우리가 아는 모양이 아니다(트림·사용자 편집·다른 기기)
          // → 남의 기록을 덮어쓰느니 새 블록으로 붙인다.
        }
        text += renderBlock(item.block);
        this.tail = item.block;
      }
      if (text) await adapter.append(path, text);
      this.queue = [];
      this.lastWriteAt = Date.now();
      await this.trim(path, this.config().maxKB);
    } catch (e) {
      // 로그를 못 쓰는 것이 동기화를 막아선 안 된다.
      console.error("[tasks-gcal-sync] 동기화 로그 기록 실패:", path, e);
      this.tail = null; // 실패했으면 파일 끝 상태를 더는 알 수 없다
      this.queue = [];
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
    if (!text.length) return;
    // 상한의 80%만 남긴다. 딱 상한에 맞추면 다음 run마다 다시 자르게 된다.
    //
    // ⚠️ **상한은 바이트인데 자르는 위치는 문자 인덱스다.** 둘을 섞으면 안 된다 —
    // 한국어는 UTF-8에서 3바이트라 실측 1.33~1.35배 차이가 나고, 예전 코드는
    // stat.size(바이트)로 판정하고 text.length(문자)로 잘라 **상한을 넘겨도 아무것도
    // 잘리지 않은 채 "잘라냈다" 안내만 찍혔다**(2026-09-07: 512KB 상한에 563KB 파일).
    // 파일 전체의 실측 비율로 목표 문자 수를 환산한다.
    // 남길 예산에서 **머리말 몫을 먼저 뺀다.** 헤더+범례+안내가 수백 바이트라, 이걸
    // 빼지 않으면 "상한의 80%만큼 블록을 남겼는데 파일은 상한을 넘는" 상태가 된다.
    const head =
      HEADER +
      `\n*(${maxKB}KB 상한 — ${stamp()} 에 이 지점 앞의 오래된 기록을 잘라냈다)*\n` +
      this.legend() +
      "\n";
    const headBytes = new TextEncoder().encode(head).length;
    const keepBytes = Math.max(0, Math.floor(limit * 0.8) - headBytes);
    const bytesPerChar = stat.size / text.length;
    const keepChars = Math.floor(keepBytes / bytesPerChar);
    let cut = Math.max(0, text.length - keepChars);
    const boundary = text.indexOf("\n## ", cut);
    cut = boundary >= 0 ? boundary + 1 : cut;
    // 실제로 잘라낸 게 없으면 안내도 쓰지 않는다. 안 자르고 "잘라냈다"고 적으면
    // 로그 자체를 못 믿게 된다 — 이 파일의 존재 이유가 사후 추적이다.
    if (cut <= 0) return;
    await adapter.write(path, head + text.slice(cut));
  }
}
