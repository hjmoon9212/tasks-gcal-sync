/** 설정 탭 § 5. 동기화 로그 — 기록 여부 · 경로(기기 태그가 붙은 실제 파일) · 기기 이름 · 크기. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Setting } from "obsidian";
import { DEFAULT_SYNC_LOG_PATH } from "../Settings";
import { SectionCtx, nonNegInt } from "../controls";

export function renderLogSection(ctx: SectionCtx): void {
  const { containerEl, plugin } = ctx;
  const s = plugin.settings;
  // ---- 5. 상세 로그 ----
  containerEl.createEl("h3", { text: "5. 동기화 로그" });
  containerEl.createEl("p", {
    text:
      "무엇이 왜 생성·수정·삭제됐는지 건별로 노트에 기록합니다. 충돌이면 어느 필드가 겹쳤고 노트와 GCal이 각각 무엇으로 바꿨고 어느 쪽이 채택돼 무엇이 폐기됐는지까지 남습니다. 변화가 없는 동기화는 기록하지 않습니다.",
    cls: "setting-item-description",
  });

  new Setting(containerEl).setName("로그 기록").addToggle((t) =>
    t.setValue(s.syncLogEnabled).onChange(async (v) => {
      s.syncLogEnabled = v;
      await plugin.saveAll();
    })
  );

  new Setting(containerEl)
    .setName("로그 파일 경로")
    .setDesc(
      "볼트 루트 기준. 볼트 안에 두면 바로 열어볼 수 있고, 이 파일의 수정은 자동 push 감시에서 제외됩니다."
    )
    .addText((t) =>
      t
        .setPlaceholder(DEFAULT_SYNC_LOG_PATH)
        .setValue(s.syncLogPath)
        .onChange(async (v) => {
          s.syncLogPath = v.trim();
          await plugin.saveAll();
          ctx.renderLogPath();
        })
    )
    .addButton((b) =>
      b.setButtonText("열기").onClick(() => plugin.openSyncLog())
    );

  // 기기마다 다른 파일에 쓴다는 사실이 **화면에 보여야** 한다. 설정에 적은 경로와
  // 실제 파일 이름이 다르면, 그걸 모르는 채로는 "왜 저 파일에 안 쌓이지"가 된다.
  ctx.setLogPathEl(containerEl.createEl("div", {
    cls: "setting-item-description",
  }));
  ctx.renderLogPath();

  new Setting(containerEl)
    .setName("이 기기 이름")
    .setDesc(
      "로그 파일 이름에 붙습니다. 기기마다 자기 파일에만 써야 하기 때문입니다 — " +
        "한 파일에 두 기기가 쓰면 Obsidian Sync가 두 사본을 병합하면서 기록이 중복·재정렬되고 " +
        "일부가 사라집니다. 이 값은 동기화되지 않습니다(기기 로컬). " +
        "바꾸면 새 파일로 옮겨 가고 옛 파일은 그대로 남습니다."
    )
    .addText((t) =>
      t
        .setPlaceholder("예: 회사PC")
        .setValue(plugin.deviceTag())
        .onChange(async (v) => {
          await plugin.setDeviceTag(v);
          ctx.renderLogPath();
        })
    );

  new Setting(containerEl)
    .setName("보류·건너뜀·실패도 기록")
    .setDesc(
      "콜드 스타트 보류, 🆔 중복, API 실패처럼 '아무 일도 안 일어난' 이유. 끄면 콘솔에만 남고 재시작하면 사라집니다. " +
        "켜도 목차(Outline)는 어지럽지 않습니다 — 보류·건너뜀만 있던 run 은 제목 없이 `- ⏸` 묶음으로 접혀 들어갑니다."
    )
    .addToggle((t) =>
      t.setValue(s.syncLogSkips).onChange(async (v) => {
        s.syncLogSkips = v;
        await plugin.saveAll();
      })
    );

  new Setting(containerEl)
    .setName("최대 크기(KB)")
    .setDesc("초과하면 오래된 앞부분부터 잘라냅니다. 0 = 무제한.")
    .addText((t) =>
      t.setValue(String(s.syncLogMaxKB)).onChange(async (v) => {
        s.syncLogMaxKB = nonNegInt(v);
        await plugin.saveAll();
      })
    );
}
