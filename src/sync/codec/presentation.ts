/**
 * 이벤트 **표현** — 제목(체크박스·반복 아이콘) · 설명 블록 · 완료색 · 딥링크.
 *
 * SyncEngine 에서 그대로 옮겼다(0.12.3). 설정은 `ctx.settings` 로 **원본을 참조**한다 —
 * SettingsTab 이 값을 제자리에서 바꾸므로 복사해 두면 다음 run 까지 옛 설정이 남는다.
 */
import { GCalEvent } from "../../gcal/CalendarClient";
import { VaultTask } from "../../data/TaskRepository";
import { LEGACY_DONE_TAG, ROUTING_TAG_PREFIX } from "../../settings/Settings";
import { CodecCtx } from "./ctx";

/** 우리가 관리하는 설명 블록의 시작 표시. 이 줄부터 끝까지가 플러그인 영역이다. */
export const NOTE_MARKER = "— tasks-gcal-sync —";

export function titleBase(t: VaultTask): string {
  const prefix = ROUTING_TAG_PREFIX;
  return t.title
    .split(/\s+/)
    .filter((w) => !w.startsWith(prefix))
    .join(" ")
    .trim();
}

export function summary(ctx: CodecCtx, t: VaultTask): string {
  const base = titleBase(t);
  // 반복(🔁) task는 아이콘으로 표시 → 캘린더에서 반복 할일임을 한눈에.
  const recur = t.recurrence ? ctx.settings.recurringPrefix?.trim() : "";
  const withIcon = recur ? `${recur} ${base}` : base;
  // 상태별 체크박스 접두사: 미완료=☐, 완료=☑️ → 모바일에서 제목만 보고 완료 확인.
  const box = (
    t.checked ? ctx.settings.donePrefix : ctx.settings.todoPrefix
  )?.trim();
  const title = box ? `${box} ${withIcon}` : withIcon;
  // ⛔ 색·접두사를 둘 다 껐으면 **제목에 아무것도 안 붙인다**(0.11.2~).
  //    예전에는 그때 `#done` 을 끼워 넣었는데, 둘 다 끈 것은 "제목에 표시하지 마라" 는
  //    뜻이라 그건 두 번째 추측이었다. 옛 이벤트에 붙어 있는 글자는 아래 gcalTitleBase 가
  //    계속 떼어낸다 → LEGACY_DONE_TAG
  return title;
}

/** 완료 상태에 대응하는 colorId. 색 완료 활성 시: 완료=완료색, 미완료=null(기본색). 비활성 시 undefined(색 안 건드림). */
export function doneColor(ctx: CodecCtx, t: VaultTask): string | null | undefined {
  if (!ctx.settings.doneColorId) return undefined;
  return t.checked ? ctx.settings.doneColorId : null;
}

/** GCal 이벤트 제목에서 체크박스/반복 아이콘/완료 접두사를 떼어 순수 제목 추출(pull용). */
export function gcalTitleBase(ctx: CodecCtx, ev: GCalEvent): string {
  let s = (ev.summary ?? "").trim();
  const prefixes = [
    ctx.settings.donePrefix,
    ctx.settings.todoPrefix,
    ctx.settings.recurringPrefix,
    LEGACY_DONE_TAG, // 설정에서는 사라졌지만 옛 이벤트 제목에는 남아 있다
  ]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  // ☐/☑️ 와 🔁 가 어떤 순서로 붙어도 앞에서부터 반복 제거.
  let changed = true;
  while (changed) {
    changed = false;
    for (const pp of prefixes) {
      if (s.startsWith(pp)) {
        s = s.slice(pp.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** task로 점프하는 Obsidian 딥링크. note=노트까지, line=정확한 줄(Advanced URI 필요). */
export function deepLink(ctx: CodecCtx, t: VaultTask): string | null {
  const mode = ctx.settings.deepLink;
  if (mode === "off") return null;
  const vault = encodeURIComponent(ctx.vaultName());
  const fp = encodeURIComponent(t.path);
  if (mode === "line") {
    // Advanced URI의 line은 1-based(에디터 표시 줄). VaultTask.line은 0-based.
    return `obsidian://adv-uri?vault=${vault}&filepath=${fp}&line=${t.line + 1}`;
  }
  return `obsidian://open?vault=${vault}&file=${fp}`;
}

/** 우리 블록: 볼트 이름 + task ID (+ 딥링크). */
export function noteBlock(ctx: CodecCtx, id: string, t?: VaultTask): string {
  const base = `${NOTE_MARKER}\n📁 ${ctx.vaultName()}\n🆔 ${id}`;
  const link = t ? deepLink(ctx, t) : null;
  return link ? `${base}\n🔗 ${link}` : base;
}

/**
 * 기존 설명에서 **사용자가 쓴 부분만** 남긴다.
 *
 * 예전에는 설명을 통째로 우리 블록으로 갈아치웠다 — GCal 이벤트에 적어 둔 메모가
 * 다음 push 마다 사라졌다. 이제 우리 영역은 마커 아래로 한정한다.
 * 마커가 없는 구버전 이벤트는 **끝에 붙은 📁/🆔/🔗 줄만** 걷어낸다(그 시절 설명은
 * 그 줄들이 전부였다).
 */
export function userDescription(prev: string): string {
  const lines = prev.split("\n");
  const i = lines.findIndex((l) => l.trim() === NOTE_MARKER);
  if (i >= 0) return lines.slice(0, i).join("\n").trimEnd();
  let end = lines.length;
  while (end > 0) {
    const t = lines[end - 1].trim();
    if (t === "" || /^(📁|🆔|🔗)/u.test(t)) end--;
    else break;
  }
  return lines.slice(0, end).join("\n").trimEnd();
}

/** 사용자 텍스트를 보존한 채 우리 블록만 갱신한 설명. */
export function mergeDescription(ctx: CodecCtx, prev: string, id: string, t?: VaultTask): string {
  const user = userDescription(prev);
  const block = noteBlock(ctx, id, t);
  return user ? `${user}\n\n${block}` : block;
}
