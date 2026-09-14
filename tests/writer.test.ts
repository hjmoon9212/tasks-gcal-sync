/**
 * TaskWriter 특성화 테스트(0.12.0 안전망) — 현재 동작을 그대로 고정한다.
 *
 * 가짜 vault: `process(file, fn)` 는 인메모리 문자열에 fn 을 적용하고(fn 이 던지면 내용은
 * 그대로), `getAbstractFileByPath` 는 obsidian 스텁의 TFile 인스턴스를 돌려준다
 * (TaskWriter 는 `instanceof TFile` 로 파일을 확인한다).
 */
import { installFakeEnv, resetClock, advanceClock } from "./helpers/fakeEnv";
installFakeEnv();

import { TFile } from "obsidian";
import { eq, ok, done } from "./helpers/assert";
import { TaskWriter, TaskLineDriftError } from "../src/write/TaskWriter";
import { parseTaskLine } from "../src/shared/tasks/TaskLine";
import { VaultTask } from "../src/data/TaskRepository";

const F = "#task";

function env(files: Record<string, string>, filter = F) {
  const store: Record<string, string> = { ...files };
  const calls = { process: 0, lookups: [] as string[] };
  const app: any = {
    vault: {
      getAbstractFileByPath: (p: string) => {
        calls.lookups.push(p);
        if (!(p in store)) return null;
        const f = new TFile();
        f.path = p;
        return f;
      },
      process: async (file: TFile, fn: (data: string) => string) => {
        calls.process++;
        const next = fn(store[file.path]);
        store[file.path] = next;
        return next;
      },
    },
  };
  const writer = new TaskWriter(app, () => filter);
  return { store, calls, writer, app };
}

/** 파일 내용의 n 번째 줄로 VaultTask 를 만든다(TaskRepository 와 같은 모양). */
function vt(content: string, path: string, line: number, filter = F): VaultTask {
  const raw = content.split("\n")[line];
  const parsed = parseTaskLine(raw, filter)!;
  return { ...parsed, path, line, raw };
}

async function rejects(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

const L0 = "# 회의록";
const L1 = "- [ ] #task 보고서 작성 📅 2026-08-06 🆔 abc123";
const L2 = "- [ ] #task 회의 ⏳ 2026-08-01 🛫 2026-08-05 📅 2026-08-07";
const L3 = "\t- [x] #task 하위 작업 ⏰ 09:00-10:30 📅 2026-08-06 ✅ 2026-08-06";
const L4 = "본문 텍스트";
const DOC = [L0, L1, L2, L3, L4].join("\n");
const P = "notes/a.md";

/** 파일의 한 줄만 바꾼 기대 텍스트. */
const withLine = (i: number, s: string) => {
  const lines = DOC.split("\n");
  lines[i] = s;
  return lines.join("\n");
};

(async () => {
  resetClock();

  // ── 드리프트 가드: 대상 줄이 raw 와 다르면 TaskLineDriftError, 파일 불변
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    t.raw = "- [ ] #task 보고서 작성 📅 2026-08-05 🆔 abc123"; // 기억한 원문이 낡음
    const err = await rejects(e.writer.setDue(t, "2026-09-01"));
    ok(err instanceof TaskLineDriftError, "drift: TaskLineDriftError");
    eq(err?.name, "TaskLineDriftError", "drift: name");
    eq(err?.message, "Task line drift at notes/a.md:2 — skip write", "drift: message (1-based line)");
    eq(e.store[P], DOC, "drift: file unchanged");
    eq(e.calls.process, 1, "drift: process was entered once");
    eq(t.raw, "- [ ] #task 보고서 작성 📅 2026-08-05 🆔 abc123", "drift: task.raw untouched");
    eq(t.due, "2026-08-06", "drift: parsed fields untouched");
    eq(e.writer.wroteRecently(P, 10_000), false, "drift: not recorded as recent write");
  }
  // 줄 번호가 파일 범위를 벗어나도 드리프트로 본다
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    t.line = 99;
    const err = await rejects(e.writer.removeId(t));
    ok(err instanceof TaskLineDriftError, "out-of-range line → drift");
    eq(err?.message, "Task line drift at notes/a.md:100 — skip write", "out-of-range message");
    eq(e.store[P], DOC, "out-of-range: file unchanged");
  }

  // ── 파일 없음: 일반 Error, process 호출 없음
  {
    const e = env({});
    const t = vt(DOC, "missing.md", 1);
    const err = await rejects(e.writer.setDue(t, "2026-09-01"));
    ok(err instanceof Error && !(err instanceof TaskLineDriftError), "missing: plain Error");
    eq(err?.message, "File not found: missing.md", "missing: message");
    eq(e.calls.process, 0, "missing: no process call");
    eq(e.calls.lookups, ["missing.md"], "missing: looked up by task.path");
    eq(t.raw, L1, "missing: raw untouched");
  }
  // TFile 이 아닌 객체(폴더 등)도 파일 없음으로 본다
  {
    const e = env({ [P]: DOC });
    e.app.vault.getAbstractFileByPath = () => ({ path: P, children: [] });
    const err = await rejects(e.writer.setDue(vt(DOC, P, 1), "2026-09-01"));
    eq(err?.message, "File not found: notes/a.md", "non-TFile → File not found");
    eq(e.store[P], DOC, "non-TFile: file unchanged");
  }

  // ── setDue: 교체 + raw/파싱 필드 갱신 + 반환값
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const r = await e.writer.setDue(t, "2026-08-10");
    const exp = "- [ ] #task 보고서 작성 📅 2026-08-10 🆔 abc123";
    eq(r, exp, "setDue: returns updated line");
    eq(e.store[P], withLine(1, exp), "setDue: file text");
    eq(t.raw, exp, "setDue: task.raw");
    eq(t.due, "2026-08-10", "setDue: task.due refreshed");
    eq(t.id, "abc123", "setDue: id kept");
    eq(t.title, "보고서 작성", "setDue: title");
    eq(t.body, "#task 보고서 작성 📅 2026-08-10 🆔 abc123", "setDue: body refreshed");
    eq(e.calls.process, 1, "setDue: one process call");
  }
  // setDue: 📅 없으면 끝에 추가
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.unschedule(t);
    await e.writer.setDue(t, "2026-08-20");
    eq(e.store[P], withLine(1, "- [ ] #task 보고서 작성 📅 2026-08-20"), "setDue append after unschedule");
    eq(t.due, "2026-08-20", "setDue append: due");
    eq(t.line, 1, "line index unchanged");
    eq(t.path, P, "path unchanged");
  }

  // ── wroteRecently: 창(main 은 10_000ms) 안이면 true, 경계 포함, 지나면 false 로 정리
  {
    resetClock();
    const e = env({ [P]: DOC, "other.md": L1 });
    eq(e.writer.wroteRecently(P, 10_000), false, "wroteRecently: before any write");
    await e.writer.setDue(vt(DOC, P, 1), "2026-08-10");
    eq(e.writer.wroteRecently(P, 10_000), true, "wroteRecently: immediately after");
    eq(e.writer.wroteRecently("other.md", 10_000), false, "wroteRecently: other path");
    advanceClock(10_000);
    eq(e.writer.wroteRecently(P, 10_000), true, "wroteRecently: exactly at window edge");
    advanceClock(1);
    eq(e.writer.wroteRecently(P, 10_000), false, "wroteRecently: past window");
    // 한 번 지나 정리되면 더 긴 창으로 물어도 false
    eq(e.writer.wroteRecently(P, 60_000), false, "wroteRecently: expired entry was deleted");
    resetClock();
  }
  {
    resetClock();
    const e = env({ [P]: DOC });
    await e.writer.setDue(vt(DOC, P, 1), "2026-08-10");
    advanceClock(5_000);
    eq(e.writer.wroteRecently(P, 60_000), true, "wroteRecently: window is per-call");
    eq(e.writer.wroteRecently(P, 1_000), false, "wroteRecently: short window expires");
    eq(e.writer.wroteRecently(P, 60_000), false, "wroteRecently: short-window query deleted entry");
    resetClock();
  }
  // 두 번째 쓰기가 시각을 갱신한다
  {
    resetClock();
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.setDue(t, "2026-08-10");
    advanceClock(8_000);
    await e.writer.setDue(t, "2026-08-11");
    advanceClock(8_000);
    eq(e.writer.wroteRecently(P, 10_000), true, "wroteRecently: refreshed by second write");
    resetClock();
  }

  // ── ensureId
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 2);
    const r = await e.writer.ensureId(t, "NEW001");
    const exp = "- [ ] #task 회의 ⏳ 2026-08-01 🛫 2026-08-05 📅 2026-08-07 🆔 NEW001";
    eq(r, exp, "ensureId: appended");
    eq(e.store[P], withLine(2, exp), "ensureId: file text");
    eq(t.id, "NEW001", "ensureId: id refreshed");
    eq(t.scheduled, "2026-08-01", "ensureId: scheduled parsed");
  }
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const r = await e.writer.ensureId(t, "OTHER1");
    eq(r, L1, "ensureId: existing 🆔 kept as is");
    eq(e.store[P], DOC, "ensureId existing: file text same");
    eq(t.id, "abc123", "ensureId existing: id unchanged");
    eq(e.calls.process, 1, "ensureId existing: still a process call");
    eq(e.writer.wroteRecently(P, 10_000), true, "ensureId existing: still recorded as write");
  }

  // ── unschedule: 📅 와 🆔 를 한 번의 process 로
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const r = await e.writer.unschedule(t);
    eq(r, "- [ ] #task 보고서 작성", "unschedule: line");
    eq(e.store[P], withLine(1, "- [ ] #task 보고서 작성"), "unschedule: file text");
    eq(e.calls.process, 1, "unschedule: single process call");
    eq(t.due, undefined, "unschedule: due cleared");
    eq(t.id, undefined, "unschedule: id cleared");
    ok("due" in t && "id" in t, "unschedule: keys present with undefined (Object.assign)");
  }
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 3);
    await e.writer.unschedule(t);
    eq(
      e.store[P],
      withLine(3, "\t- [x] #task 하위 작업 ⏰ 09:00-10:30 ✅ 2026-08-06"),
      "unschedule indented: ⏰/✅ kept"
    );
    eq(t.indent, "\t", "unschedule indented: indent");
    eq(t.time, "09:00-10:30", "unschedule indented: time kept");
  }

  // ── removeId
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.removeId(t);
    eq(e.store[P], withLine(1, "- [ ] #task 보고서 작성 📅 2026-08-06"), "removeId: file text");
    eq(t.id, undefined, "removeId: id cleared");
    eq(t.due, "2026-08-06", "removeId: due kept");
  }

  // ── rewriteLine: 통째로 교체
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const line = "- [x] #task 다른 제목 📅 2026-07-01 🆔 zzz999 ✅ 2026-07-02";
    const r = await e.writer.rewriteLine(t, line);
    eq(r, line, "rewriteLine: returns line");
    eq(e.store[P], withLine(1, line), "rewriteLine: file text");
    eq(t.checked, true, "rewriteLine: checked refreshed");
    eq(t.statusChar, "x", "rewriteLine: statusChar");
    eq(t.id, "zzz999", "rewriteLine: id");
    eq(t.done, "2026-07-02", "rewriteLine: done");
    eq(t.title, "다른 제목", "rewriteLine: title");
  }
  // 파싱이 안 되는 결과(필터 없음)면 raw 만 바뀌고 파싱 필드는 낡은 값 그대로
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.rewriteLine(t, "그냥 텍스트");
    eq(e.store[P], withLine(1, "그냥 텍스트"), "rewriteLine non-task: file text");
    eq(t.raw, "그냥 텍스트", "rewriteLine non-task: raw updated");
    eq(t.due, "2026-08-06", "rewriteLine non-task: stale due kept");
    eq(t.title, "보고서 작성", "rewriteLine non-task: stale title kept");
    eq(t.body, "#task 보고서 작성 📅 2026-08-06 🆔 abc123", "rewriteLine non-task: stale body");
  }

  // ── setStart / removeStart
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.setStart(t, "2026-08-01");
    eq(
      e.store[P],
      withLine(1, "- [ ] #task 보고서 작성 📅 2026-08-06 🆔 abc123 🛫 2026-08-01"),
      "setStart: appended at end"
    );
    eq(t.start, "2026-08-01", "setStart: start refreshed");
  }
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 2);
    await e.writer.setStart(t, "2026-08-03");
    eq(
      e.store[P],
      withLine(2, "- [ ] #task 회의 ⏳ 2026-08-01 🛫 2026-08-03 📅 2026-08-07"),
      "setStart: replaced in place"
    );
    eq(t.start, "2026-08-03", "setStart replace: start");
    await e.writer.removeStart(t);
    eq(
      e.store[P],
      withLine(2, "- [ ] #task 회의 ⏳ 2026-08-01 📅 2026-08-07"),
      "removeStart: file text"
    );
    eq(t.start, undefined, "removeStart: start cleared");
    eq(e.calls.process, 2, "setStart+removeStart: two process calls");
  }

  // ── setTime: 첫 Tasks 필드 이모지 앞에 삽입
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    await e.writer.setTime(t, "09:00-10:30");
    eq(
      e.store[P],
      withLine(1, "- [ ] #task 보고서 작성 ⏰ 09:00-10:30 📅 2026-08-06 🆔 abc123"),
      "setTime: before first field emoji"
    );
    eq(t.time, "09:00-10:30", "setTime: time refreshed");
    eq(t.title, "보고서 작성", "setTime: title excludes ⏰");
  }
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 2);
    await e.writer.setTime(t, "14:00-15:00");
    eq(
      e.store[P],
      withLine(2, "- [ ] #task 회의 ⏰ 14:00-15:00 ⏳ 2026-08-01 🛫 2026-08-05 📅 2026-08-07"),
      "setTime: before ⏳ (first field)"
    );
  }
  // 기존 ⏰ 교체(자리는 다시 첫 필드 앞)
  {
    const doc = "- [ ] #task 일 📅 2026-08-06 ⏰ 8:00";
    const e = env({ "t.md": doc });
    const t = vt(doc, "t.md", 0);
    eq(t.time, "08:00-09:00", "fixture: single time normalized");
    await e.writer.setTime(t, "13:00-14:00");
    eq(e.store["t.md"], "- [ ] #task 일 ⏰ 13:00-14:00 📅 2026-08-06", "setTime: replaces and moves ⏰");
    eq(t.time, "13:00-14:00", "setTime replace: time");
  }
  // 우선순위 이모지도 필드로 본다
  {
    const doc = "- [ ] #task 급한 일 ⏫ 📅 2026-08-06";
    const e = env({ "t.md": doc });
    const t = vt(doc, "t.md", 0);
    await e.writer.setTime(t, "09:00-10:00");
    eq(e.store["t.md"], "- [ ] #task 급한 일 ⏰ 09:00-10:00 ⏫ 📅 2026-08-06", "setTime: before priority emoji");
  }
  // 필드가 하나도 없으면 줄 끝
  {
    const doc = "- [ ] #task 메모  ";
    const e = env({ "t.md": doc });
    const t = vt(doc, "t.md", 0);
    await e.writer.setTime(t, "09:00-10:00");
    eq(e.store["t.md"], "- [ ] #task 메모 ⏰ 09:00-10:00", "setTime: no fields → end (trailing ws trimmed)");
  }
  // removeTime
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 3);
    await e.writer.removeTime(t);
    eq(
      e.store[P],
      withLine(3, "\t- [x] #task 하위 작업 📅 2026-08-06 ✅ 2026-08-06"),
      "removeTime: file text"
    );
    eq(t.time, undefined, "removeTime: time cleared");
  }

  // ── replaceTitle: 정확히 1회
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const r = await e.writer.replaceTitle(t, " 보고서 작성 ", " 보고서 제출 ");
    eq(r, "- [ ] #task 보고서 제출 📅 2026-08-06 🆔 abc123", "replaceTitle: trimmed replace");
    eq(e.store[P], withLine(1, "- [ ] #task 보고서 제출 📅 2026-08-06 🆔 abc123"), "replaceTitle: file text");
    eq(t.title, "보고서 제출", "replaceTitle: title refreshed");
  }
  // 0회
  {
    const e = env({ [P]: DOC });
    const t = vt(DOC, P, 1);
    const err = await rejects(e.writer.replaceTitle(t, "없는 제목", "새 제목"));
    ok(err instanceof Error && !(err instanceof TaskLineDriftError), "replaceTitle 0 match: plain Error");
    eq(err?.message, "title replace skipped (모호한 매칭)", "replaceTitle 0 match: message");
    eq(e.store[P], DOC, "replaceTitle 0 match: file unchanged");
    eq(t.raw, L1, "replaceTitle 0 match: raw unchanged");
    eq(e.writer.wroteRecently(P, 10_000), false, "replaceTitle 0 match: not recorded");
  }
  // 2회 이상(모호)
  {
    const doc = "- [ ] #task 회의 회의록 정리 📅 2026-08-06";
    const e = env({ "t.md": doc });
    const t = vt(doc, "t.md", 0);
    const err = await rejects(e.writer.replaceTitle(t, "회의", "미팅"));
    eq(err?.message, "title replace skipped (모호한 매칭)", "replaceTitle ambiguous: throws");
    eq(e.store["t.md"], doc, "replaceTitle ambiguous: file unchanged");
    eq(t.title, "회의 회의록 정리", "replaceTitle ambiguous: title unchanged");
  }
  // 빈 oldTitle
  {
    const e = env({ [P]: DOC });
    const err = await rejects(e.writer.replaceTitle(vt(DOC, P, 1), "   ", "x"));
    eq(err?.message, "title replace skipped (모호한 매칭)", "replaceTitle empty old: throws");
    eq(e.store[P], DOC, "replaceTitle empty old: file unchanged");
  }
  // 태그/이모지 영역과도 매칭한다(순수 indexOf) — 필터 태그를 바꾸면 파싱이 안 돼 필드가 낡는다
  {
    const doc = "- [ ] #task 일 📅 2026-08-06";
    const e = env({ "t.md": doc });
    const t = vt(doc, "t.md", 0);
    await e.writer.replaceTitle(t, "#task", "#todo");
    eq(e.store["t.md"], "- [ ] #todo 일 📅 2026-08-06", "replaceTitle: matches inside tag text");
    eq(t.body, "#task 일 📅 2026-08-06", "replaceTitle: unparseable result keeps stale body");
  }

  // ── 글로벌 필터: refresh 는 getGlobalFilter() 를 쓴다
  {
    const doc = "- [ ] #todo 할일 #todo/sub 📅 2026-08-06";
    const e = env({ "t.md": doc }, "#todo");
    const t = vt(doc, "t.md", 0, "#todo");
    await e.writer.setDue(t, "2026-08-07");
    eq(t.title, "할일", "custom filter: title strips #todo and sub-tag");
    eq(t.tags, ["#todo", "#todo/sub"], "custom filter: tags");
  }
  {
    const doc = "- [ ] 필터 없음 📅 2026-08-06";
    const e = env({ "t.md": doc }, "");
    const t = vt(doc, "t.md", 0, "");
    await e.writer.setDue(t, "2026-08-07");
    eq(t.due, "2026-08-07", "empty filter: refresh parses any checkbox");
  }

  // ── 다른 줄은 건드리지 않는다 / 같은 파일 연속 쓰기
  {
    const e = env({ [P]: DOC });
    const a = vt(DOC, P, 1);
    const b = vt(DOC, P, 2);
    await e.writer.setDue(a, "2026-09-01");
    await e.writer.removeStart(b);
    eq(
      e.store[P],
      [
        L0,
        "- [ ] #task 보고서 작성 📅 2026-09-01 🆔 abc123",
        "- [ ] #task 회의 ⏳ 2026-08-01 📅 2026-08-07",
        L3,
        L4,
      ].join("\n"),
      "two writes on different lines"
    );
  }

  // ── CRLF 파일: split("\n") 이라 줄 끝 \r 가 raw 에 남는다. 추가형 재작성은 /\s+$/ 로 \r 를 지운다
  {
    const doc = "# x\r\n- [ ] #task 일 📅 2026-08-06\r\n끝";
    const e = env({ "crlf.md": doc });
    const raw = doc.split("\n")[1];
    eq(parseTaskLine(raw, F), null, "CRLF raw does not parse (. excludes \\r)");
    const t: any = { path: "crlf.md", line: 1, raw };
    const r = await e.writer.ensureId(t, "ID0001");
    eq(r, "- [ ] #task 일 📅 2026-08-06 🆔 ID0001", "CRLF ensureId: \\r stripped");
    eq(e.store["crlf.md"], "# x\r\n- [ ] #task 일 📅 2026-08-06 🆔 ID0001\n끝", "CRLF ensureId: mixed line endings");
    eq(t.id, "ID0001", "CRLF ensureId: result (no \\r) parses → id");
  }

  done();
})();
