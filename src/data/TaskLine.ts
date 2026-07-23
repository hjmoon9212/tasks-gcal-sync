/*
 * TaskLine — Obsidian Tasks(이모지 포맷) 한 줄을 무손실로 파싱하고,
 * 단일 필드만 "수술적으로" 재작성하는 순수 함수 모음.
 *
 * 절대 줄 전체를 재직렬화하지 않는다 → 모델링하지 않은 이모지/메타데이터 유실 방지.
 */

export const EMOJI = {
  due: "📅",
  scheduled: "⏳",
  start: "🛫",
  created: "➕",
  done: "✅",
  cancelled: "❌",
  recurrence: "🔁",
  id: "🆔",
  dependsOn: "⛔",
  onCompletion: "🏁",
} as const;

const PRIORITY_EMOJIS = ["🔺", "⏫", "🔼", "🔽", "⏬"];

/*
 * 이모지(📅🆔🛫 등 non-BMP 서로게이트 페어)를 정규식 소스에 안전하게 넣기 위한 \u{..} 이스케이프.
 * 이유: `new RegExp("🆔" + "\\s")` 처럼 서로게이트 페어 이모지를 문자열로 이어붙여 넘기면,
 *   V8이 저위 서로게이트와 뒤따르는 백슬래시를 함께 삭제해 패턴이 깨진다
 *   (예: source가 "\uD83C" + 리터럴 "s" 가 되어 실제 "🆔 " 와 매치되지 않음).
 * → 반드시 코드포인트 이스케이프(\u{..}) + "u" 플래그로 만들어야 안전하다.
 */
function reEsc(s: string): string {
  return [...s]
    .map((c) => "\\u{" + c.codePointAt(0)!.toString(16) + "}")
    .join("");
}

/** 이모지가 들어간 정규식은 항상 "u" 플래그로. (호출부 편의 래퍼) */
function reU(source: string, flags = ""): RegExp {
  return new RegExp(source, flags + "u");
}

// 어떤 task 필드든 그 앞에서 끝나도록 하는 lookahead (모든 이모지를 \u{..}로 이스케이프해 안전하게 alternation)
const FIELD_EMOJIS = [
  EMOJI.due,
  EMOJI.scheduled,
  EMOJI.start,
  EMOJI.done,
  EMOJI.created,
  EMOJI.id,
  EMOJI.dependsOn,
  EMOJI.cancelled,
  EMOJI.recurrence,
  EMOJI.onCompletion,
  ...PRIORITY_EMOJIS,
];
const FIELD_LOOKAHEAD =
  "(?=" + FIELD_EMOJIS.map(reEsc).join("|") + "|$)";

const TASK_LINE_RE = /^(\s*)([-*+]) \[(.)\] (.*)$/;
const DATE = "(\\d{4}-\\d{2}-\\d{2})";

export interface ParsedTask {
  indent: string;
  bullet: string;
  statusChar: string; // ' ', 'x', '/', '-', 'b' ...
  checked: boolean; // [x] 또는 [X]
  body: string; // 체크박스 이후 원문
  title: string; // 캘린더 제목용으로 정제된 텍스트
  due?: string;
  scheduled?: string;
  start?: string;
  done?: string;
  created?: string;
  id?: string;
  recurrence?: string;
  tags: string[]; // 본문의 모든 #태그 (라우팅용)
}

export function isTaskLine(line: string): boolean {
  return TASK_LINE_RE.test(line);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDate(body: string, emoji: string): string | undefined {
  const m = body.match(reU(reEsc(emoji) + "\\s*" + DATE));
  return m ? m[1] : undefined;
}

export function parseTaskLine(
  line: string,
  globalFilter: string
): ParsedTask | null {
  const m = line.match(TASK_LINE_RE);
  if (!m) return null;
  const [, indent, bullet, statusChar, body] = m;
  if (globalFilter && !body.includes(globalFilter)) return null;

  const checked = statusChar === "x" || statusChar === "X";
  const idM = body.match(reU(reEsc(EMOJI.id) + "\\s*([A-Za-z0-9]+)"));
  const recM = body.match(
    reU(reEsc(EMOJI.recurrence) + "\\s*(.+?)\\s*" + FIELD_LOOKAHEAD)
  );

  return {
    indent,
    bullet,
    statusChar,
    checked,
    body,
    title: cleanTitle(body, globalFilter),
    due: extractDate(body, EMOJI.due),
    scheduled: extractDate(body, EMOJI.scheduled),
    start: extractDate(body, EMOJI.start),
    done: extractDate(body, EMOJI.done),
    created: extractDate(body, EMOJI.created),
    id: idM ? idM[1] : undefined,
    recurrence: recM ? recM[1].trim() : undefined,
    tags: body.match(/#[A-Za-z0-9_/\-가-힣]+/g) ?? [],
  };
}

/** 캘린더 이벤트 제목으로 쓰기 위해 이모지 메타데이터/필터 태그를 제거한 텍스트 */
export function cleanTitle(body: string, globalFilter: string): string {
  let t = body;
  for (const e of [
    EMOJI.due,
    EMOJI.scheduled,
    EMOJI.start,
    EMOJI.done,
    EMOJI.created,
    EMOJI.cancelled,
  ]) {
    t = t.replace(reU(reEsc(e) + "\\s*\\d{4}-\\d{2}-\\d{2}", "g"), " ");
  }
  t = t.replace(reU(reEsc(EMOJI.id) + "\\s*[A-Za-z0-9]+", "g"), " ");
  t = t.replace(reU(reEsc(EMOJI.dependsOn) + "\\s*[A-Za-z0-9, ]+", "g"), " ");
  t = t.replace(
    reU(reEsc(EMOJI.recurrence) + "\\s*.+?\\s*" + FIELD_LOOKAHEAD, "g"),
    " "
  );
  for (const p of PRIORITY_EMOJIS) t = t.split(p).join(" ");
  // globalFilter 태그와 그 하위태그(#task/sheet 등)를 통째로 제거
  if (globalFilter) {
    t = t.replace(
      new RegExp(escapeRegExp(globalFilter) + "[\\w/\\-\\uAC00-\\uD7A3]*", "g"),
      " "
    );
  }
  return t.replace(/\s+/g, " ").trim();
}

// ---- 수술적 재작성 (순수 함수) ----

/** 📅 due 날짜를 교체(없으면 줄 끝에 추가). 다른 필드는 절대 건드리지 않음. */
export function setDue(raw: string, date: string): string {
  const re = reU(reEsc(EMOJI.due) + "\\s*\\d{4}-\\d{2}-\\d{2}");
  if (re.test(raw)) return raw.replace(re, EMOJI.due + " " + date);
  return raw.replace(/\s+$/, "") + " " + EMOJI.due + " " + date;
}

/** 📅 due 제거(미일정화). */
export function removeDue(raw: string): string {
  return raw
    .replace(reU("\\s*" + reEsc(EMOJI.due) + "\\s*\\d{4}-\\d{2}-\\d{2}"), "")
    .replace(/\s+$/, "");
}

/** 🛫 start 날짜 교체(없으면 줄 끝에 추가). 다른 필드는 건드리지 않음. */
export function setStart(raw: string, date: string): string {
  const re = reU(reEsc(EMOJI.start) + "\\s*\\d{4}-\\d{2}-\\d{2}");
  if (re.test(raw)) return raw.replace(re, EMOJI.start + " " + date);
  return raw.replace(/\s+$/, "") + " " + EMOJI.start + " " + date;
}

/** 🛫 start 제거. */
export function removeStart(raw: string): string {
  return raw
    .replace(reU("\\s*" + reEsc(EMOJI.start) + "\\s*\\d{4}-\\d{2}-\\d{2}"), "")
    .replace(/\s+$/, "");
}

/**
 * 본문 제목 텍스트만 교체. oldTitle이 줄에서 "정확히 1회"만 매칭될 때만 안전하게 교체.
 * 비거나 0회/2회 이상이면 null(호출자가 skip) → 태그·이모지 필드 오손상 방지.
 */
export function replaceTitle(
  raw: string,
  oldTitle: string,
  newTitle: string
): string | null {
  const o = oldTitle.trim();
  if (!o) return null;
  const idx = raw.indexOf(o);
  if (idx < 0) return null;
  if (raw.indexOf(o, idx + o.length) >= 0) return null; // 2회 이상 → 모호, skip
  return raw.slice(0, idx) + newTitle.trim() + raw.slice(idx + o.length);
}

/** 🆔 가 없으면 줄 끝에 추가. 이미 있으면 그대로. */
export function setId(raw: string, id: string): string {
  if (reU(reEsc(EMOJI.id)).test(raw)) return raw;
  return raw.replace(/\s+$/, "") + " " + EMOJI.id + " " + id;
}

/** 체크박스 상태 문자 교체: `- [ ]` → `- [x]` 등. */
export function setStatusChar(raw: string, char: string): string {
  return raw.replace(/^(\s*[-*+] )\[.\]/, "$1[" + char + "]");
}

/** ✅ 완료일 추가(없을 때만). */
export function setDoneDate(raw: string, date: string): string {
  if (reU(reEsc(EMOJI.done) + "\\s*\\d{4}-\\d{2}-\\d{2}").test(raw)) return raw;
  return raw.replace(/\s+$/, "") + " " + EMOJI.done + " " + date;
}

/** ✅ 완료일 제거(완료 취소용). */
export function removeDone(raw: string): string {
  return raw
    .replace(reU("\\s*" + reEsc(EMOJI.done) + "\\s*\\d{4}-\\d{2}-\\d{2}"), "")
    .replace(/\s+$/, "");
}
