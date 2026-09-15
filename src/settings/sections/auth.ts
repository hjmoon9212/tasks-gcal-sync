/** 설정 탭 § 1. Google 인증 — 자격증명은 기기-로컬(localStorage). 기기 간에는 복사·붙여넣기로 옮긴다. SettingsTab.display() 에서 그대로 옮겼다(0.12.9). */
import { Notice, Platform, Setting } from "obsidian";
import { SectionCtx } from "../controls";

export function renderAuthSection(ctx: SectionCtx): void {
  const { containerEl, plugin, rerender } = ctx;
  const s = plugin.settings;
  containerEl.createEl("h3", { text: "1. Google 인증" });
  containerEl.createEl("p", {
    text:
      "Google Cloud Console에서 OAuth 클라이언트(Desktop app)를 만들고 Client ID/Secret을 입력하세요. " +
      "**대화형 인증은 데스크탑에서만** 실행됩니다(루프백 서버를 씁니다). " +
      "자격증명은 이 기기의 localStorage에만 저장되어 Obsidian Sync를 타지 않습니다 — 기기마다 개별 설정이 필요합니다. " +
      "모바일에서는 아래 「Refresh Token」에 데스크탑에서 받은 값을 붙여넣으세요.",
    cls: "setting-item-description",
  });

  new Setting(containerEl).setName("Client ID").addText((t) =>
    t
      .setPlaceholder("xxxx.apps.googleusercontent.com")
      .setValue(s.clientId)
      .onChange(async (v) => {
        s.clientId = v.trim();
        await plugin.saveAll();
      })
  );

  new Setting(containerEl).setName("Client Secret").addText((t) => {
    t.setValue(s.clientSecret).onChange(async (v) => {
      s.clientSecret = v.trim();
      await plugin.saveAll();
    });
    t.inputEl.type = "password";
  });

  // 모바일에는 대화형 인증 경로가 없다(루프백 서버 = Node http = 데스크탑 전용).
  // refresh token 은 **기기에 묶이지 않으므로** 데스크탑에서 받은 값을 그대로 쓸 수 있다.
  // 이 칸이 없던 동안은 그것이 모바일 지원을 통째로 막는 관문이었다.
  new Setting(containerEl)
    .setName("Refresh Token")
    .setDesc(
      "데스크탑에서 「Google 인증」을 마치면 채워집니다. 모바일에는 인증 경로가 없으므로 " +
        "여기에 붙여넣으세요. ⚠️ 이 값이 곧 계정 접근 권한입니다 — 볼트 노트에 적어 두지 마세요."
    )
    .addText((t) => {
      t.setPlaceholder("1//0e...").setValue(s.refreshToken ?? "");
      t.onChange(async (v) => {
        const next = v.trim();
        s.refreshToken = next === "" ? null : next;
        await plugin.saveAll();
      });
      t.inputEl.type = "password";
      t.inputEl.style.width = "100%";
    });

  // ── 기기 간 자격증명 옮기기 ──
  //
  // 세 값은 **기기-로컬 localStorage** 에 산다(볼트 단위 네임스페이스). 볼트 파일에 두면
  // Sync 를 타는데 **그게 v0.3.1/v0.3.8 사고의 원인**이었다 — 며칠 오프라인이던 기기가
  // 자기가 든 옛 clientSecret 을 서버로 밀어 올려 인증이 통째로 깨졌다.
  //
  // 그래서 「동기화되게 하는 것」은 답이 아니고, **옮기는 수고를 줄이는 것**이 답이다.
  // 기기 × 볼트마다 세 칸을 손으로 채우는 대신 한 덩어리로 복사·붙여넣는다.
  new Setting(containerEl)
    .setName("다른 기기로 옮기기")
    .setDesc(
      "자격증명은 기기마다·볼트마다 따로 넣어야 합니다(Obsidian Sync를 타지 않습니다 — 옛 값이 " +
        "서버로 올라가 인증이 깨진 사고가 있었습니다). 데스크탑에서 「복사」하고 다른 기기에서 " +
        "「붙여넣기」하면 세 칸이 한 번에 채워집니다. ⚠️ 이 문자열이 곧 계정 접근 권한입니다 — " +
        "옮긴 뒤 메신저·노트에 남기지 마세요."
    )
    .addButton((b) =>
      b.setButtonText("복사").onClick(async () => {
        if (!s.clientId && !s.refreshToken) {
          new Notice("옮길 자격증명이 없습니다 — 이 기기는 아직 설정 전입니다");
          return;
        }
        const blob = JSON.stringify({
          v: 1,
          clientId: s.clientId,
          clientSecret: s.clientSecret,
          refreshToken: s.refreshToken,
        });
        try {
          await navigator.clipboard.writeText(blob);
          new Notice("자격증명을 복사했습니다 — 다른 기기에서 「붙여넣기」");
        } catch {
          new Notice("클립보드에 쓰지 못했습니다");
        }
      })
    )
    .addButton((b) =>
      b.setButtonText("붙여넣기").onClick(async () => {
        try {
          const txt = (await navigator.clipboard.readText()).trim();
          const o = JSON.parse(txt);
          // 셋 다 있어야 받는다 — 반쪽만 덮으면 기존 값과 섞여 더 못 쓰게 된다.
          if (!o || typeof o.clientId !== "string" || typeof o.refreshToken !== "string") {
            new Notice("클립보드 내용이 자격증명 형식이 아닙니다");
            return;
          }
          s.clientId = o.clientId;
          s.clientSecret = typeof o.clientSecret === "string" ? o.clientSecret : "";
          s.refreshToken = o.refreshToken || null;
          await plugin.saveAll();
          rerender(); // 인증 상태 줄을 다시 그린다
          new Notice("자격증명을 넣었습니다 — 「지금 동기화」로 확인하세요");
        } catch {
          new Notice("클립보드를 읽지 못했습니다(형식 오류)");
        }
      })
    );

  new Setting(containerEl)
    .setName("인증 상태")
    .setDesc(
      (plugin.auth.isAuthenticated() ? "✅ 인증됨" : "❌ 미인증") +
        (Platform.isDesktopApp
          ? ""
          : " — 이 기기에서는 대화형 인증을 할 수 없습니다(루프백 서버가 데스크탑 전용). " +
            "데스크탑에서 인증한 뒤 위 「복사 → 붙여넣기」로 옮기세요.")
    )
    .addButton((b) =>
      b
        .setButtonText(
          Platform.isDesktopApp ? "Google 인증" : "인증은 데스크탑에서"
        )
        .setCta()
        .setDisabled(!Platform.isDesktopApp)
        .onClick(async () => {
          try {
            await plugin.auth.authenticateInteractive();
            new Notice("Google 인증 완료");
            rerender();
          } catch (e: any) {
            new Notice("인증 실패: " + e.message);
            console.error(e);
          }
        })
    );
}
