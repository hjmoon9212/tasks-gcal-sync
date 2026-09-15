/** 설정 탭 § 캘린더 뷰에 표시할 일정 — 어느 캘린더를 가져올지만 정한다. 색은 gcal-calendar-view 가 갖는다. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Notice, Setting } from "obsidian";
import { SectionCtx, nonNegInt } from "../controls";

export function renderFeedSection(ctx: SectionCtx): void {
  const { containerEl, plugin, rerender } = ctx;
  const s = plugin.settings;
  const cals = s.calendars;
  // ---- 캘린더 뷰에 표시할 일정 ----
  containerEl.createEl("h4", { text: "캘린더 뷰에 표시할 일정" });
  containerEl.createEl("p", {
    text:
      "여기서 고른 캘린더의 일정(회의·약속·초대)이 gcal-calendar-view 위젯에 " +
      "읽기 전용으로 그려집니다. task로 만든 이벤트는 자동으로 빠집니다. " +
      "아무것도 고르지 않으면 기능이 꺼진 것과 같습니다.",
    cls: "setting-item-description",
  });
  containerEl.createEl("p", {
    text:
      "여기서는 «어느 캘린더를 가져올지» 만 정합니다. 색은 그리는 쪽인 " +
      "gcal-calendar-view 설정 → «GCal 일정 캘린더» 에 모여 있습니다 — " +
      "카테고리 색 바로 아래라 task 막대와 나란히 놓고 맞출 수 있습니다.",
    cls: "setting-item-description",
  });

  if (!cals.length) {
    containerEl.createEl("p", {
      text: "먼저 위에서 «목록 불러오기»를 눌러 캘린더를 가져오세요.",
      cls: "setting-item-description",
    });
  }

  for (const c of cals) {
    const picked = s.feedCalendars.find((f) => f.id === c.id);
    const row = new Setting(containerEl).setName(c.name);
    row.addToggle((t) =>
      t.setValue(!!picked).onChange(async (on) => {
        if (on) {
          if (!s.feedCalendars.some((f) => f.id === c.id)) {
            // color "" = 캘린더 뷰의 카테고리 색을 따른다(기본).
            // 여기서 Google 배경색을 넣어 두면 카테고리와 어긋난 채로 굳는다.
            s.feedCalendars.push({ id: c.id, name: c.name, color: "" });
          }
        } else {
          s.feedCalendars = s.feedCalendars.filter((f) => f.id !== c.id);
        }
        await plugin.saveAll();
        plugin.feed.dropUnselected();
        rerender();
      })
    );
  }

  new Setting(containerEl)
    .setName("일정 갱신 주기(분)")
    .setDesc(
      "이 일정들을 몇 분마다 조용히 다시 받아올지. 0이면 자동 갱신 없음. " +
        "자동 동기화 주기와 무관합니다 — 회의는 우리 동기화와 상관없이 바뀝니다. " +
        "손으로 «지금 동기화»(리본·명령·아래 버튼)를 누르면 주기와 상관없이 같이 받아옵니다. " +
        "받아오는 동안에도 화면은 비지 않고, 내용이 실제로 달라졌을 때만 다시 그립니다."
    )
    .addText((t) =>
      t.setValue(String(s.feedRefreshMinutes)).onChange(async (v) => {
        s.feedRefreshMinutes = nonNegInt(v);
        await plugin.saveAll();
        plugin.setupFeedInterval();
      })
    );

  new Setting(containerEl).addButton((b) =>
    b
      .setButtonText("지금 다시 받아오기")
      .setDisabled(!s.feedCalendars.length)
      .onClick(() => {
        void plugin.feed.refreshAll();
        new Notice("캘린더 뷰 일정을 다시 받아옵니다.");
      })
  );
}
