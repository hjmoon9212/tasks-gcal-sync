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
import { App, TFile, normalizePath } from "obsidian";

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

/** 시:분:초만 (날짜가 절 제목에 적혀 있으므로 run 제목은 이걸 쓴다). */
function hms(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

/** 날짜 절 제목(`## 2026-09-12 (토)`). **Outline 의 1단은 이것뿐이어야 한다.** */
const DAY_LINE = /^(\d{4}-\d{2}-\d{2}) \([일월화수목금토]\)$/;

/**
 * 보류·건너뜀뿐인 run 묶음의 머리 표식.
 * 제목이 아니라 목록 항목이라 Outline 에 뜨지 않는다 — `renderBlock` · `trim` ·
 * `scripts/check-sync-log.mjs` 가 같은 문자열을 본다.
 */
const QUIET_MARK = "- ⏸";

function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 동작 → 요약 기호.
 *
 * ⛔ **HOLD·SKIP 을 뺀 모든 동작이 여기 있어야 한다.** 빠진 동작은 `changeGist` 가 빈
 * 문자열을 돌려 그 run 이 "조용한 run"으로 분류되고, 그러면 실제로 일어난 변경이 제목
 * 없이 묶음 속에 묻혀 **Outline 에서 영원히 안 보인다.** 표의 완전성을 테스트가 고정한다.
 */
const GIST: Partial<Record<LogAction, string>> = {
  CREATE: "+",
  UPDATE: "~",
  MOVE: "↔",
  DELETE: "-",
  DROP: "-",
  PULL: "⬇",
  UNSCHEDULE: "⬇",
  ADOPT: "↩",
  REPAIR: "🔧",
  FAIL: "⚠",
};
const GIST_ORDER = ["+", "~", "↔", "-", "⬇", "↩", "🔧", "⚠"];

/**
 * 제목에 쓸 변경 요지. **0 인 계수기는 아예 안 적는다.**
 *
 * 예전 제목은 `+0 ~0 ↔0 -0 ⬇0 (skip 1)` 처럼 0 을 다 적었고, 실측 파일의 97%가 정확히
 * 그 모양이었다(360블록 중 350). 그러면 Outline 이 똑같은 줄의 벽이 되어 정작 찾아야 할
 * 변경 10~69건이 묻힌다.
 */
export function changeGist(entries: SyncLogEntry[]): string {
  const n = new Map<string, number>();
  for (const e of entries) {
    const s = GIST[e.action];
    if (s) n.set(s, (n.get(s) ?? 0) + 1);
  }
  return GIST_ORDER.filter((s) => n.has(s))
    .map((s) => `${s}${n.get(s)}`)
    .join(" ");
}

/** 보류·건너뜀뿐인 run 인가 — 제목을 만들지 않는 기준이 곧 이것이다. */
export function isQuiet(entries: SyncLogEntry[]): boolean {
  return changeGist(entries) === "";
}

/** 제목 한 줄이 화면을 넘기면 훑기가 안 된다 → 40자에서 끊는다. */
function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 제목에 쓸 대상 이름. 제목 → 🆔 순으로 떨어지고, 둘 다 없으면 ""(호출부가 summary 로 메운다).
 *
 * **실제로 일어난 동작만 본다.** 같은 run 에 섞여 든 HOLD 의 제목이 끼면 "그 task 가
 * 바뀐 것"으로 읽힌다.
 */
export function targetLabel(entries: SyncLogEntry[]): string {
  const names: string[] = [];
  for (const e of entries) {
    if (!GIST[e.action]) continue;
    const t = e.title ? `"${clip(flat(e.title))}"` : e.id ? `\`${e.id}\`` : "";
    if (t && !names.includes(t)) names.push(t);
  }
  if (!names.length) return "";
  return names.length > 1 ? `${names[0]} 외 ${names.length - 1}` : names[0];
}

/**
 * 텍스트의 **마지막 최상위 제목**이 날짜 절이면 그 날짜, 아니면 null.
 *
 * 왜 "마지막 `## ` 줄"만 보나: 0.11 이전 포맷(`## 2026-08-16 09:05:03 · …`)이 파일 끝이면
 * 그 아래에 `### ` run 을 넣어선 안 된다 — 그 시각 블록에 딸린 하위 항목처럼 읽힌다.
 * 그때는 null 을 돌려 새 날짜 절을 열게 한다. 옛 블록은 마이그레이션하지 않으므로
 * **두 포맷이 한 파일에 공존하는 것이 정상이다**(트림으로 늙어 나간다).
 */
export function lastDaySection(text: string): string | null {
  let found: string | null = null;
  const re = /^## (.*)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const d = DAY_LINE.exec(m[1].trimEnd());
    found = d ? d[1] : null;
  }
  return found;
}

/**
 * 잘라낸 앞부분에서 **마지막 날짜 절 제목 줄**을 찾는다(없으면 "").
 * 트림이 하루 안에서 자를 때 그 제목을 되살리는 데 쓴다.
 */
function enclosingDayLine(prefix: string): string {
  const re = /^## \d{4}-\d{2}-\d{2} \([일월화수목금토]\)$/gm;
  let line = "";
  for (let m = re.exec(prefix); m; m = re.exec(prefix)) line = m[0];
  return line;
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
  /** 이 블록이 속한 날짜 절(YYYY-MM-DD)과 요일. **접기는 이 경계를 넘지 않는다.** */
  day: string;
  dow: string;
  /** 보류·건너뜀뿐인가 → 제목을 만들지 않는다(Outline 에 안 뜬다). */
  quiet: boolean;
  /**
   * 제목용 파생값. **블록에 굳혀 둔다** — 렌더할 때마다 다시 계산해서 한 글자라도
   * 달라지면 `rewriteTail` 의 `endsWith` 열쇠가 어긋나 접기가 중복 블록으로 폴백한다.
   */
  gist: string;
  label: string;
}

export function newBlock(
  summary: string,
  trigger: string,
  entries: SyncLogEntry[],
  now = new Date()
): LogBlock {
  const lines = entries.map(formatEntry);
  const gist = changeGist(entries);
  return {
    // 접기 기준은 **항목 줄뿐**이다(요약·계기 제외, 들여쓰기 전 원문).
    signature: lines.join("\n"),
    summary,
    triggers: [trigger],
    first: now,
    last: now,
    count: 1,
    lines,
    day: dayKeyOf(now),
    dow: DOW[now.getDay()],
    quiet: gist === "",
    gist,
    label: targetLabel(entries) || flat(summary),
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

/**
 * 블록을 파일에 적을 문자열로. 접힌 블록은 머리 줄에 기간과 횟수를 단다.
 *
 * ⛔ **날짜 절 제목(`## `)을 여기서 적지 않는다.** 이 문자열은 `rewriteTail` 의
 * `endsWith` 열쇠다 — 절 제목까지 품으면 (a) 하루의 첫 블록만 렌더가 달라져 같은
 * `signature` 가 서로 다른 렌더를 갖고, (b) 트림이 그 줄을 다시 쓰는 순간 열쇠가 어긋나
 * 접기가 "중복 블록 append" 로 폴백한다 — 0.8.0 이 없앤 바로 그 손상이다.
 * 절 제목은 `SyncLogWriter.daySection` 이 블록 밖에서 하루에 한 번 적는다.
 */
export function renderBlock(b: LogBlock): string {
  const when = b.count > 1 ? `${hms(b.first)} ~ ${hms(b.last)}` : hms(b.first);
  const trig =
    b.triggers.length > 1 ? `${b.triggers[0]} 외 ${b.triggers.length - 1}종` : b.triggers[0];
  const times = b.count > 1 ? ` · ×${b.count}회` : "";
  if (b.quiet) {
    // 보류·건너뜀뿐 → **제목을 만들지 않는다.** 실측 파일의 97%가 이것이었고, 제목으로
    // 두면 Outline 이 똑같은 줄의 벽이 된다. 대신 접히는 목록 항목으로 남기고 항목 줄은
    // 자식으로 들여쓴다 — 진단 정보(어느 🆔가 왜 막혔나)는 그대로 남는다.
    return (
      `\n${QUIET_MARK} ${when}${times} · ${trig} — ${b.summary}\n` +
      b.lines.map((l) => `  ${l}`).join("\n") +
      "\n"
    );
  }
  const label = b.label ? ` ${b.label}` : "";
  return `\n### ${when} · ${b.gist}${label} · ${trig}${times}\n` + b.lines.join("\n") + "\n";
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
  /** 파일에 적혀 있는 **마지막 날짜 절**(YYYY-MM-DD). 없으면 null. */
  private dayOnDisk: string | null = null;
  /** 위 값을 실제로 파일에서 확인했는가. 로드 직후·쓰기 실패 후엔 false 다. */
  private dayKnown = false;

  /**
   * @param now 시계 주입구 — 날짜 절·자정 접기 끊기·이틀에 걸친 트림은 시각을 밖에서
   *   줘야 테스트로 고정할 수 있다. 기본값이 곧 실시간이라 호출부(main)는 안 바뀐다.
   *   **클래스 안의 모든 시각은 이것 하나를 지나간다.**
   */
  constructor(
    private app: App,
    private config: () => SyncLogConfig,
    private now: () => Date = () => new Date()
  ) {}

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

    const block = newBlock(summary, trigger, shown, this.now());
    this.enqueue(block, trigger);

    if (!block.quiet || this.now().getTime() - this.lastWriteAt >= HOLD_FLUSH_MS) {
      await this.flush();
    }
  }

  /**
   * 새 블록을 대기열에 넣는다. 직전과 같은 내용이면 새로 만들지 않고 접는다.
   *
   * ⛔ **날짜가 다르면 접지 않는다.** 접힌 블록은 날짜 절 하나 안에 사는데, 예전에는
   * `19:36:10 ~ 02:41:57 ×356회`(실측) 같은 블록이 나왔다 — 어느 절에 넣어도 거짓이 된다.
   */
  private enqueue(fresh: LogBlock, trigger: string): void {
    const last = this.queue[this.queue.length - 1];
    if (last) {
      if (last.block.signature === fresh.signature && last.block.day === fresh.day) {
        last.block = extendBlock(last.block, trigger, fresh.first);
        return;
      }
    } else if (
      this.tail &&
      this.tail.signature === fresh.signature &&
      this.tail.day === fresh.day
    ) {
      // 디스크 끝 블록의 연장 → 새로 붙이지 않고 그 블록을 고쳐 쓴다.
      // 끝 시각은 **날짜를 판정한 그 순간**으로 넘긴다(23:59:59 판정 → 00:00:00 기록 방지).
      this.queue.push({
        block: extendBlock(this.tail, trigger, fresh.first),
        replacesTail: true,
      });
      return;
    }
    this.queue.push({ block: fresh, replacesTail: false });
  }

  /**
   * 이 블록 앞에 날짜 절 제목이 필요하면 그 줄을 돌려주고 상태를 넘긴다.
   * 하루에 한 번만 나간다 — Outline 의 1단이 이것뿐이어야 날짜로 접을 수 있다.
   */
  private daySection(b: LogBlock): string {
    if (b.day === this.dayOnDisk) return "";
    this.dayOnDisk = b.day;
    return `\n## ${b.day} (${b.dow})\n`;
  }

  /**
   * 쌓인 블록을 파일에 반영한다. 쓸 게 없으면 아무것도 하지 않는다.
   * 호출부: 실제 사건이 있는 run · 상한 초과 · 종료 직전(main).
   */
  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const path = this.path();
    try {
      const file = this.file(path);
      if (!file) {
        await this.ensureParent(path);
        // 새로 만드는 파일이다 — 절 제목이 하나도 없다(확인할 것도 없다).
        this.dayOnDisk = null;
        this.dayKnown = true;
        const body = this.queue
          .map((q) => this.daySection(q.block) + renderBlock(q.block))
          .join("");
        await this.app.vault.create(path, HEADER + this.legend() + body);
        this.tail = this.queue[this.queue.length - 1].block;
        this.queue = [];
        this.lastWriteAt = this.now().getTime();
        return;
      }
      // 로드 직후엔 "오늘 절 제목을 이미 적었는지"를 모른다 → 세션당 한 번 파일이 답한다.
      // 기기-로컬 상태로 기억하지 않는다 — 답이 파일 안에 있는데 두 번째 진실원천을 두면
      // 트림·사용자 편집·Sync 복원 때 어긋난다. 꼬리만 읽지도 않는다(조용한 묶음이 길면
      // 창 안에 `## ` 이 없어 "절이 없다"로 잘못 판단해 제목이 중복된다).
      if (!this.dayKnown) {
        this.dayOnDisk = lastDaySection(await this.app.vault.read(file));
        this.dayKnown = true;
      }
      let text = "";
      for (const item of this.queue) {
        if (item.replacesTail && this.tail && !text) {
          // 접기 연장은 절 제목을 다시 적지 않는다(같은 날짜임이 enqueue 에서 보장된다).
          if (
            await this.rewriteTail(file, renderBlock(this.tail), renderBlock(item.block))
          ) {
            this.tail = item.block;
            continue;
          }
          // 파일 끝이 우리가 아는 모양이 아니다(트림·사용자 편집·0.11 이전 포맷)
          // → 남의 기록을 덮어쓰느니 새 블록으로 붙인다.
        }
        text += this.daySection(item.block) + renderBlock(item.block);
        this.tail = item.block;
      }
      if (text) await this.app.vault.append(file, text);
      this.queue = [];
      this.lastWriteAt = this.now().getTime();
      await this.trim(file, this.config().maxKB);
    } catch (e) {
      // 로그를 못 쓰는 것이 동기화를 막아선 안 된다.
      console.error("[tasks-gcal-sync] 동기화 로그 기록 실패:", path, e);
      this.tail = null; // 실패했으면 파일 끝 상태를 더는 알 수 없다
      this.dayKnown = false; // 절 제목도 모른다(안 나간 제목을 나갔다고 믿으면 고아가 된다)
      this.queue = [];
    }
  }

  /**
   * 파일 끝의 블록을 갱신본으로 갈아끼운다. 끝이 `prev` 와 정확히 같을 때만 손대고,
   * 아니면 false 를 돌려 호출부가 append 로 폴백하게 한다 — 남의 기록을 덮어쓰느니
   * 줄이 하나 늘어나는 편이 낫다.
   */
  private async rewriteTail(
    file: TFile,
    prev: string,
    next: string
  ): Promise<boolean> {
    let ok = false;
    await this.app.vault.process(file, (text) => {
      ok = text.endsWith(prev);
      return ok ? text.slice(0, text.length - prev.length) + next : text;
    });
    return ok;
  }

  /**
   * 로그 파일의 `TFile`. 없으면 undefined.
   *
   * ⛔ **`vault.adapter` 로 직접 읽고 쓰지 않는다**(0.9.11). 어댑터는 Vault 레이어를
   * 건너뛰어 디스크를 바로 만지므로 Obsidian 이 그 파일을 제대로 등록하지 못하고,
   * Dataview 같은 인덱서가 *"Cannot index file, since it has no Obsidian file metadata"*
   * 로 터진다. 볼트 안 파일은 볼트 API 로 다뤄야 한다.
   */
  private file(path: string): TFile | undefined {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : undefined;
  }

  private legend(): string {
    return (
      "\n구조: `## 날짜` 절 · `### 시각` 실제로 바뀐 run · " +
      "`- ⏸` 보류·건너뜀만 있던 run(제목 없음 → Outline 에 안 뜬다)\n" +
      "요약 기호: `+`생성 `~`수정 `↔`캘린더이동 `-`삭제 `⬇`노트반영 `↩`회수 `🔧`수리 `⚠`실패\n" +
      "상세 기호: `⬇`GCal→노트 `⬆`노트→GCal `⚔️`충돌(같은 필드를 양쪽에서 수정) `⏸`보류\n"
    );
  }

  private async ensureParent(path: string): Promise<void> {
    const i = path.lastIndexOf("/");
    if (i < 0) return;
    const dir = path.slice(0, i);
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    await this.app.vault.createFolder(dir);
  }

  /**
   * maxKB를 넘으면 오래된 앞부분을 잘라낸다. 항목 중간에서 끊으면 그 run의 기록이
   * 반쪽만 남아 오히려 오해를 만들므로 경계를 맞춘다.
   *
   * 자를 위치는 **날짜 절 경계(`\n## `)를 우선**한다. 자른 뒤 첫 구조 줄이 날짜 제목이면
   * 살아남은 run 이 전부 제 날짜 밑에 있다. `\n### ` 에서 자르면 그 run 들은 날짜 없는
   * 고아가 되고 "언제 것인지 알 수 없는 변경"이 된다 — 이 포맷의 존재 이유가 사라진다.
   *
   * 다만 **하루가 예산보다 클 수 있다**(조용한 묶음이 수백 회 쌓인 날). 그때는 남은 구간에
   * 날짜 경계가 없으므로 run(또는 조용한 묶음) 경계에서 자르고 **그 run 을 품고 있던 날짜
   * 제목을 다시 적는다.**
   *
   * 여기서 보장되는 것(`dayOnDisk` 가 이것에 의지한다): 트림은 **파일의 마지막 날짜 절을
   * 바꾸지 않는다.** 1순위는 마지막 제목 뒤에 `\n## ` 가 없어 그 제목을 못 자르고,
   * 2·3순위는 잘린 제목과 **같은 날짜**를 다시 적는다.
   */
  private async trim(file: TFile, maxKB: number): Promise<void> {
    if (maxKB <= 0) return;
    const limit = maxKB * 1024;
    // TFile.stat.size 는 **바이트**다(문자 수가 아니다) — 아래 환산이 그걸 전제로 한다.
    if (file.stat.size <= limit) return;

    const text = await this.app.vault.read(file);
    if (!text.length) return;
    const size = file.stat.size;
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
      `\n*(${maxKB}KB 상한 — ${stamp(this.now())} 에 이 지점 앞의 오래된 기록을 잘라냈다)*\n` +
      this.legend() +
      "\n";
    const headBytes = new TextEncoder().encode(head).length;
    const keepBytes = Math.max(0, Math.floor(limit * 0.8) - headBytes);
    const bytesPerChar = size / text.length;
    const keepChars = Math.floor(keepBytes / bytesPerChar);
    const want = Math.max(0, text.length - keepChars);

    let cut = text.indexOf("\n## ", want); // 1순위: 날짜 절(0.11 이전 블록도 같은 토큰)
    let carry = "";
    if (cut >= 0) {
      cut += 1;
    } else {
      cut = text.indexOf("\n### ", want); // 2순위: run 경계
      if (cut < 0) cut = text.indexOf(`\n${QUIET_MARK} `, want); // 3순위: 조용한 묶음 경계
      if (cut < 0) cut = want; // 경계가 아예 없다(옛 포맷 단일 블록 등) → 예산 지점에서
      else cut += 1;
      const day = enclosingDayLine(text.slice(0, cut));
      // 잘려 나간 절 제목을 되살린다 → 고아 run 방지. 빈 줄까지 붙여 평소 렌더와 같은 모양으로.
      if (day) carry = `${day}\n\n`;
    }
    // 실제로 잘라낸 게 없으면 안내도 쓰지 않는다. 안 자르고 "잘라냈다"고 적으면
    // 로그 자체를 못 믿게 된다 — 이 파일의 존재 이유가 사후 추적이다.
    if (cut <= 0) return;
    await this.app.vault.modify(file, head + carry + text.slice(cut));
  }
}
