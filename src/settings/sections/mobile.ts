/** 설정 탭 § 0. 이 기기(모바일) — 폰에서만 보인다. 기본은 읽기 전용(Settings.mobileReadOnly). SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Platform, Setting } from "obsidian";
import { SectionCtx } from "../controls";

export function renderMobileSection(ctx: SectionCtx): void {
  const { containerEl, plugin } = ctx;
  const s = plugin.settings;
  // ---- 0. 모바일 ----
  // 폰에서도 로드되지만 **기본은 읽기 전용**이다. 그 이유는 Settings.mobileReadOnly 에.
  if (Platform.isMobile) {
    containerEl.createEl("h3", { text: "0. 이 기기(모바일)" });
    new Setting(containerEl)
      .setName("모바일에서는 GCal에 쓰지 않기")
      .setDesc(
        "켜 두면 이 기기는 **pull 만** 합니다 — GCal에서 고친 것이 노트에 들어오고, 📆 일정도 보입니다. " +
          "노트 편집의 GCal 반영은 데스크탑이 맡습니다. " +
          "끄면 폰에서도 GCal에 씁니다 ⚠️ 폰 세션은 콜드 스타트 60초·정착 30초를 못 채우는 일이 잦고, " +
          "종료 직전 플러시도 폰에서는 돌지 않으며, 체크박스 오탭이 곧바로 GCal 완료 해제가 됩니다."
      )
      .addToggle((t) =>
        t.setValue(s.mobileReadOnly).onChange(async (v) => {
          s.mobileReadOnly = v;
          await plugin.saveAll();
        })
      );
  }
}
