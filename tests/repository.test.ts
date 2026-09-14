/**
 * TaskRepository 특성화 테스트(0.12.0 안전망) — 현재 동작을 그대로 고정한다.
 *
 * 가짜 app: vault.getMarkdownFiles / cachedRead / read(호출되면 안 됨) /
 * getAbstractFileByPath, metadataCache.getFileCache.
 */
import { TFile } from "obsidian";
import { eq, ok, done } from "./helpers/assert";
import { TaskRepository } from "../src/data/TaskRepository";

type Fixture = { content: string; cache: any };

/** 내용의 체크박스/목록 줄에서 listItems 를 만든다(task: 체크박스 상태 문자, 목록이면 undefined). */
function items(content: string): any[] {
  const out: any[] = [];
  content.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*[-*+] (\[(.)\] )?/);
    if (!m) return;
    out.push({ task: m[1] ? m[2] : undefined, position: { start: { line: i } } });
  });
  return out;
}

function makeApp(fixtures: Record<string, Fixture>) {
  const reads: string[] = [];
  const plainReads: string[] = [];
  const files = Object.keys(fixtures).map((p) => {
    const f = new TFile();
    f.path = p;
    return f;
  });
  const app: any = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (f: TFile) => {
        reads.push(f.path);
        return fixtures[f.path].content;
      },
      read: async (f: TFile) => {
        plainReads.push(f.path);
        return fixtures[f.path].content;
      },
      getAbstractFileByPath: (p: string) =>
        files.find((f) => f.path === p) ?? (p === "folder" ? { path: "folder", children: [] } : null),
    },
    metadataCache: {
      getFileCache: (f: TFile) => fixtures[f.path].cache,
    },
  };
  return { app, reads, plainReads, files };
}

const A = [
  "# A", // 0
  "- [ ] #task 보고서 📅 2026-08-06 🆔 aaa111", // 1
  "- [x] 그냥 체크박스", // 2 — 필터 없음
  "- 일반 목록 #task", // 3 — 체크박스 아님
  "\t- [ ] #task 하위 작업 🛫 2026-08-01 📅 2026-08-03", // 4 — 들여쓴 하위 task
  "    * [/] #task/toBuy 우유 ⏰ 9:05 🔁 every week", // 5 — 하위태그
].join("\n");

const fixtures: Record<string, Fixture> = {
  // 본문 태그로 통과
  "a.md": { content: A, cache: { tags: [{ tag: "#task" }], listItems: items(A) } },
  // task 체크박스는 있으나 태그 색인 없음 → 읽지 않는다
  "b.md": {
    content: "- [ ] #task 색인 누락",
    cache: { listItems: items("- [ ] #task 색인 누락") },
  },
  // 하위태그만 색인됨 → startsWith 로 통과
  "c.md": {
    content: "메모\n- [ ] #task/sheet 시트 정리 📅 2026-08-09",
    cache: {
      tags: [{ tag: "#task/sheet" }],
      listItems: items("메모\n- [ ] #task/sheet 시트 정리 📅 2026-08-09"),
    },
  },
  // frontmatter 문자열 태그
  "d.md": {
    content: "---\ntags: task\n---\n- [ ] 프론트매터 전용 체크박스",
    cache: {
      frontmatter: { tags: "task" },
      listItems: items("---\ntags: task\n---\n- [ ] 프론트매터 전용 체크박스"),
    },
  },
  // frontmatter 배열 태그(숫자 섞임) + 본문에 필터 있는 task
  "e.md": {
    content: "- [ ] #task 배열 태그 ⏳ 2026-08-02",
    cache: {
      frontmatter: { tags: [42, "project", "task/sub"] },
      listItems: items("- [ ] #task 배열 태그 ⏳ 2026-08-02"),
    },
  },
  // frontmatter 에 '#task' 로 적힌 경우 — bare('task') 와 startsWith 불일치 → 읽지 않는다
  "f.md": {
    content: "- [ ] #task 해시 프론트매터",
    cache: { frontmatter: { tags: ["#task"] }, listItems: items("- [ ] #task 해시 프론트매터") },
  },
  // listItems 없음(태그는 있음) → 읽지 않는다
  "g.md": { content: "#task 만 있는 글", cache: { tags: [{ tag: "#task" }] } },
  // listItems 전부 task undefined → 읽지 않는다
  "h.md": {
    content: "- 목록 #task",
    cache: { tags: [{ tag: "#task" }], listItems: items("- 목록 #task") },
  },
  // 캐시 없음 → 읽지 않는다
  "i.md": { content: "- [ ] #task 캐시 없음", cache: null },
  // #taskforce 도 startsWith('#task') 로 통과하고 parseTaskLine 의 includes 도 통과한다
  "j.md": {
    content: "- [ ] #taskforce 팀 일",
    cache: { tags: [{ tag: "#taskforce" }], listItems: items("- [ ] #taskforce 팀 일") },
  },
  // 캐시가 낡음: 범위 밖 줄 번호 + task 로 색인됐지만 지금은 체크박스가 아닌 줄
  "k.md": {
    content: "- [ ] #task 남은 줄\n바뀐 줄 #task",
    cache: {
      tags: [{ tag: "#task" }],
      listItems: [
        { task: " ", position: { start: { line: 1 } } },
        { task: " ", position: { start: { line: 7 } } },
        { task: " ", position: { start: { line: 0 } } },
      ],
    },
  },
  // CRLF: 줄 끝 \r 때문에 TASK_LINE_RE 가 매치하지 않는다 → 읽기는 하지만 0건
  "l.md": {
    content: "- [ ] #task 윈도우 줄바꿈 📅 2026-08-06\r\n- [ ] #task 둘째\r\n",
    cache: {
      tags: [{ tag: "#task" }],
      listItems: [
        { task: " ", position: { start: { line: 0 } } },
        { task: " ", position: { start: { line: 1 } } },
      ],
    },
  },
};

(async () => {
  // ── 기본 필터 '#task'
  {
    const { app, reads, plainReads } = makeApp(fixtures);
    const repo = new TaskRepository(app, () => "#task");
    const tasks = await repo.getTasks();

    eq(reads, ["a.md", "c.md", "d.md", "e.md", "j.md", "k.md", "l.md"], "#task: files read after pre-filter (once each)");
    eq(plainReads, [], "#task: vault.read never used");

    eq(
      tasks.map((t) => `${t.path}:${t.line}`),
      ["a.md:1", "a.md:4", "a.md:5", "c.md:1", "e.md:0", "j.md:0", "k.md:0"],
      "#task: produced task locations (listItems order)"
    );

    eq(
      tasks[0],
      {
        indent: "",
        bullet: "-",
        statusChar: " ",
        checked: false,
        body: "#task 보고서 📅 2026-08-06 🆔 aaa111",
        title: "보고서",
        due: "2026-08-06",
        id: "aaa111",
        tags: ["#task"],
        path: "a.md",
        line: 1,
        raw: "- [ ] #task 보고서 📅 2026-08-06 🆔 aaa111",
      },
      "a.md:1 full object"
    );
    eq(
      tasks[1],
      {
        indent: "\t",
        bullet: "-",
        statusChar: " ",
        checked: false,
        body: "#task 하위 작업 🛫 2026-08-01 📅 2026-08-03",
        title: "하위 작업",
        due: "2026-08-03",
        start: "2026-08-01",
        tags: ["#task"],
        path: "a.md",
        line: 4,
        raw: "\t- [ ] #task 하위 작업 🛫 2026-08-01 📅 2026-08-03",
      },
      "a.md:4 indented subtask"
    );
    eq(
      tasks[2],
      {
        indent: "    ",
        bullet: "*",
        statusChar: "/",
        checked: false,
        body: "#task/toBuy 우유 ⏰ 9:05 🔁 every week",
        title: "우유",
        recurrence: "every week",
        time: "09:05-10:05",
        tags: ["#task/toBuy"],
        path: "a.md",
        line: 5,
        raw: "    * [/] #task/toBuy 우유 ⏰ 9:05 🔁 every week",
      },
      "a.md:5 sub-tag task"
    );
    eq(
      tasks[3],
      {
        indent: "",
        bullet: "-",
        statusChar: " ",
        checked: false,
        body: "#task/sheet 시트 정리 📅 2026-08-09",
        title: "시트 정리",
        due: "2026-08-09",
        tags: ["#task/sheet"],
        path: "c.md",
        line: 1,
        raw: "- [ ] #task/sheet 시트 정리 📅 2026-08-09",
      },
      "c.md:1"
    );
    eq(tasks[4].scheduled, "2026-08-02", "e.md:0 scheduled");
    eq(tasks[4].title, "배열 태그", "e.md:0 title");
    eq(tasks[5].title, "팀 일", "j.md:0 #taskforce stripped from title as filter prefix");
    eq(tasks[5].tags, ["#taskforce"], "j.md:0 tags");
    eq(tasks[6].raw, "- [ ] #task 남은 줄", "k.md: stale cache — only still-valid line");
    ok(tasks.every((t) => t.path !== "d.md"), "d.md: read but checkbox lacks filter → no task");
  }

  // ── 빈 globalFilter: 사전 필터 통과, 모든 체크박스가 task
  {
    const { app, reads } = makeApp(fixtures);
    const repo = new TaskRepository(app, () => "");
    const tasks = await repo.getTasks();
    eq(
      reads,
      ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "j.md", "k.md", "l.md"],
      "empty filter: every file with a task listItem is read"
    );
    eq(
      tasks.map((t) => `${t.path}:${t.line}`),
      ["a.md:1", "a.md:2", "a.md:4", "a.md:5", "b.md:0", "c.md:1", "d.md:3", "e.md:0", "f.md:0", "j.md:0", "k.md:0"],
      "empty filter: task locations"
    );
    eq(tasks[1].checked, true, "empty filter: plain checkbox parsed, checked");
    eq(tasks[1].title, "그냥 체크박스", "empty filter: plain checkbox title");
    eq(tasks[0].title, "#task 보고서", "empty filter: #task not stripped from title");
  }

  // ── 다른 필터: 하위태그 색인만 있는 파일
  {
    const { app, reads } = makeApp(fixtures);
    const tasks = await new TaskRepository(app, () => "#task/sheet").getTasks();
    eq(reads, ["c.md"], "#task/sheet: only c.md read");
    eq(tasks.map((t) => t.title), ["시트 정리"], "#task/sheet: title");
  }
  // 필터가 '#' 없이 주어지면 태그 색인(#...)과는 불일치, frontmatter 와는 일치
  {
    const { app, reads } = makeApp(fixtures);
    const tasks = await new TaskRepository(app, () => "task").getTasks();
    eq(reads, ["d.md", "e.md"], "bare filter 'task': only frontmatter-tag files pass");
    eq(tasks.map((t) => `${t.path}:${t.line}`), ["e.md:0"], "bare filter: body includes 'task'");
  }

  // ── getFilter 는 getTasks 호출 시점에 읽는다
  {
    const { app } = makeApp(fixtures);
    let filter = "#none";
    const repo = new TaskRepository(app, () => filter);
    eq((await repo.getTasks()).length, 0, "dynamic filter: none");
    filter = "#task/sheet";
    eq((await repo.getTasks()).length, 1, "dynamic filter: re-read per call");
  }

  // ── getFile
  {
    const { app, files } = makeApp(fixtures);
    const repo = new TaskRepository(app, () => "#task");
    ok(repo.getFile("a.md") === files[0], "getFile: returns TFile");
    eq(repo.getFile("nope.md"), null, "getFile: missing → null");
    eq(repo.getFile("folder"), null, "getFile: non-TFile → null");
  }

  done();
})();
