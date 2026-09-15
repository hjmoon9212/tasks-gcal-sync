/** 설정 탭 § 2. 캘린더 라우팅 — 캘린더 목록 · 기본 캘린더 · 보정 규칙. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Notice, Setting } from "obsidian";
import { SectionCtx } from "../controls";

export function renderRoutingSection(ctx: SectionCtx): void {
  const { containerEl, plugin, rerender } = ctx;
  const s = plugin.settings;
  // ---- 2. 캘린더 라우팅 ----
  containerEl.createEl("h3", { text: "2. 캘린더 라우팅 (#gcal/캘린더명)" });
  containerEl.createEl("p", {
    text: "task에 #gcal/캘린더명 태그를 붙이면 그 이름의 캘린더로 보냅니다 (예: #gcal/Growth → Growth 캘린더, 자동 매칭). 태그가 없으면 기본 캘린더로. 먼저 캘린더 목록을 불러오세요.",
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName("캘린더 목록")
    .setDesc(
      s.calendars.length
        ? `${s.calendars.length}개 로드됨`
        : "아직 안 불러옴"
    )
    .addButton((b) =>
      b.setButtonText("목록 불러오기").onClick(async () => {
        try {
          const cals = await plugin.client.listCalendars();
          s.calendars = cals.map((c) => ({
            id: c.id,
            name: c.summary,
            color: c.backgroundColor,
          }));
          await plugin.saveAll();
          new Notice(`${cals.length}개 캘린더 로드됨`);
          rerender();
        } catch (e: any) {
          new Notice("불러오기 실패: " + e.message);
          console.error(e);
        }
      })
    );

  const cals = s.calendars;

  // 기본 캘린더
  new Setting(containerEl)
    .setName("기본 캘린더")
    .setDesc("어느 규칙에도 매칭되지 않는 task가 갈 곳.")
    .addDropdown((d) => {
      d.addOption("", "— 선택 —");
      for (const c of cals) d.addOption(c.id, c.name);
      d.setValue(s.defaultCalendarId);
      d.onChange(async (v) => {
        s.defaultCalendarId = v;
        s.defaultCalendarName = cals.find((c) => c.id === v)?.name ?? "";
        await plugin.saveAll();
      });
    });

  // 보정 규칙 (선택)
  containerEl.createEl("h4", { text: "보정 규칙 (선택)" });
  containerEl.createEl("p", {
    text: "태그 이름과 실제 캘린더명이 다를 때만 사용 (예: #gcal/Personal → '개인 일정' 캘린더). 보통은 비워두면 됩니다.",
    cls: "setting-item-description",
  });
  s.rules.forEach((rule, idx) => {
    const setting = new Setting(containerEl)
      .addText((t) =>
        t
          .setPlaceholder("Personal (= #gcal/Personal)")
          .setValue(rule.tag)
          .onChange(async (v) => {
            rule.tag = v.trim();
            await plugin.saveAll();
          })
      )
      .addDropdown((d) => {
        d.addOption("", "— 캘린더 —");
        for (const c of cals) d.addOption(c.id, c.name);
        d.setValue(rule.calendarId);
        d.onChange(async (v) => {
          rule.calendarId = v;
          rule.calendarName = cals.find((c) => c.id === v)?.name ?? "";
          await plugin.saveAll();
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("규칙 삭제")
          .onClick(async () => {
            s.rules.splice(idx, 1);
            await plugin.saveAll();
            rerender();
          })
      );
    setting.controlEl.style.flexWrap = "wrap";
  });

  new Setting(containerEl).addButton((b) =>
    b.setButtonText("+ 규칙 추가").onClick(async () => {
      s.rules.push({ tag: "", calendarId: "", calendarName: "" });
      await plugin.saveAll();
      rerender();
    })
  );
}
