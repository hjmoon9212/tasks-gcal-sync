/** 설정 탭 § 3. 동작 — 필터 · 제목 표식 · 완료 색 · 딥링크 · overdue. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Setting } from "obsidian";
import { SectionCtx } from "../controls";

/** Google Calendar 이벤트 색(colorId 1~11). */
const GCAL_COLORS: { id: string; name: string }[] = [
  { id: "1", name: "라벤더 (연보라)" },
  { id: "2", name: "세이지 (연녹)" },
  { id: "3", name: "포도 (자주)" },
  { id: "4", name: "플라밍고 (연빨강)" },
  { id: "5", name: "바나나 (노랑)" },
  { id: "6", name: "귤 (주황)" },
  { id: "7", name: "공작 (청록)" },
  { id: "8", name: "그래파이트 (회색)" },
  { id: "9", name: "블루베리 (남색)" },
  { id: "10", name: "바질 (진녹)" },
  { id: "11", name: "토마토 (빨강)" },
];

export function renderBehaviorSection(ctx: SectionCtx): void {
  const { containerEl, plugin } = ctx;
  const s = plugin.settings;
  // ---- 3. 동작 ----
  containerEl.createEl("h3", { text: "3. 동작" });

  new Setting(containerEl)
    .setName("Global filter")
    .setDesc("이 태그가 있는 task만 대상. Obsidian Tasks 설정과 동일하게.")
    .addText((t) =>
      t.setValue(s.globalFilter).onChange(async (v) => {
        s.globalFilter = v.trim();
        await plugin.saveAll();
      })
    );

  new Setting(containerEl)
    .setName("제목 접두사 (미완료 / 완료)")
    .setDesc(
      "이벤트 제목 앞 체크박스 표식. 미완료=☐, 완료=☑️ → 색이 안 보이는 모바일에서도 제목으로 완료 확인. 표시 전용이며, 완료 여부는 Obsidian에서만 바꾼다. 비우면 안 붙음."
    )
    .addText((t) =>
      t
        .setPlaceholder("☐ (미완료)")
        .setValue(s.todoPrefix)
        .onChange(async (v) => {
          s.todoPrefix = v;
          await plugin.saveAll();
        })
    )
    .addText((t) =>
      t
        .setPlaceholder("☑️ (완료)")
        .setValue(s.donePrefix)
        .onChange(async (v) => {
          s.donePrefix = v;
          await plugin.saveAll();
        })
    );

  new Setting(containerEl)
    .setName("반복 task 아이콘")
    .setDesc(
      "🔁 반복 규칙이 있는 task의 이벤트 제목 앞에 붙일 아이콘. 캘린더에서 반복 할일임을 한눈에 확인. 비우면 안 붙음."
    )
    .addText((t) =>
      t
        .setPlaceholder("🔁")
        .setValue(s.recurringPrefix)
        .onChange(async (v) => {
          s.recurringPrefix = v;
          await plugin.saveAll();
        })
    );

  new Setting(containerEl)
    .setName("완료 색")
    .setDesc(
      "완료한 task의 이벤트를 이 색으로 표시한다(표시 전용 — 캘린더에서 색을 바꿔도 Obsidian은 바뀌지 않는다). '끄기' 선택 시 색을 건드리지 않는다."
    )
    .addDropdown((d) => {
      d.addOption("", "끄기 (제목 #done)");
      for (const c of GCAL_COLORS) d.addOption(c.id, `${c.id}. ${c.name}`);
      d.setValue(s.doneColorId);
      d.onChange(async (v) => {
        s.doneColorId = v;
        await plugin.saveAll();
      });
    });

  new Setting(containerEl)
    .setName("이벤트 → Obsidian 딥링크")
    .setDesc(
      "GCal 이벤트 설명에 🔗 링크를 넣어 캘린더에서 노트/task로 바로 점프. '줄 단위'는 Advanced URI 플러그인 필요."
    )
    .addDropdown((d) => {
      d.addOption("off", "끄기");
      d.addOption("note", "노트까지 (obsidian://open)");
      d.addOption("line", "줄 단위 (Advanced URI)");
      d.setValue(s.deepLink);
      d.onChange(async (v) => {
        s.deepLink = v as "off" | "note" | "line";
        await plugin.saveAll();
      });
    });

  new Setting(containerEl)
    .setName("Overdue 포함")
    .setDesc("오늘 이전인데 아직 미완료인 task도 동기화.")
    .addToggle((t) =>
      t.setValue(s.includeOverdue).onChange(async (v) => {
        s.includeOverdue = v;
        await plugin.saveAll();
      })
    );
}
