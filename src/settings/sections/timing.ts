/** 설정 탭 § 4. 동기화 타이밍 — 편집 자동 · 대기 · 최소 간격 · 시작 시 · 주기 · 지금 동기화. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Setting } from "obsidian";
import { SectionCtx, nonNegInt } from "../controls";

export function renderTimingSection(ctx: SectionCtx): void {
  const { containerEl, plugin } = ctx;
  const s = plugin.settings;
  // ---- 4. 동기화 타이밍 ----
  containerEl.createEl("h3", { text: "4. 동기화 타이밍" });

  new Setting(containerEl)
    .setName("편집 시 자동 동기화")
    .setDesc(
      "task를 수정하면 잠시 뒤 자동으로 밀어 올린다(push만 — GCal 쪽 변경은 시작/주기에서 받아온다)."
    )
    .addToggle((t) =>
      t.setValue(s.autoPushOnEdit).onChange(async (v) => {
        s.autoPushOnEdit = v;
        await plugin.saveAll();
      })
    );

  new Setting(containerEl)
    .setName("편집 후 대기(초)")
    .setDesc(
      "편집이 멎고 이 시간이 지나면 동기화. 길수록 연속 작업(날짜 → 시작일 → 우선순위)이 한 번으로 합쳐진다."
    )
    .addText((t) =>
      t.setValue(String(s.autoPushDebounceSeconds)).onChange(async (v) => {
        s.autoPushDebounceSeconds = nonNegInt(v);
        await plugin.saveAll();
      })
    );

  new Setting(containerEl)
    .setName("자동 동기화 최소 간격(초)")
    .setDesc(
      "직전 동기화 후 이 시간 안에는 자동으로 다시 돌지 않는다(자동 트리거만 해당, 수동/리본은 항상 즉시). 0이면 제한 없음."
    )
    .addText((t) =>
      t.setValue(String(s.minSyncIntervalSeconds)).onChange(async (v) => {
        s.minSyncIntervalSeconds = nonNegInt(v);
        await plugin.saveAll();
      })
    );

  new Setting(containerEl).setName("시작 시 동기화").addToggle((t) =>
    t.setValue(s.syncOnStartup).onChange(async (v) => {
      s.syncOnStartup = v;
      await plugin.saveAll();
    })
  );

  new Setting(containerEl)
    .setName("자동 동기화 주기(분)")
    .setDesc("0이면 주기 동기화 없음.")
    .addText((t) =>
      t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
        s.syncIntervalMinutes = nonNegInt(v);
        await plugin.saveAll();
        plugin.setupInterval();
      })
    );

  new Setting(containerEl).addButton((b) =>
    b
      .setButtonText("지금 동기화")
      .setCta()
      .onClick(() => plugin.runSync(false, { manual: true, trigger: "수동(설정)" }))
  );
}
