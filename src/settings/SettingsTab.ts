import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TasksGcalSyncPlugin from "../main";

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

export class SettingsTab extends PluginSettingTab {
  /** 접힘 상태는 화면 상태일 뿐이라 저장하지 않는다(설정 창을 닫으면 초기값으로). */
  private showDoneDetails = false;

  constructor(app: App, private plugin: TasksGcalSyncPlugin) {
    super(app, plugin);
  }

  /** '세부 설정 보기' 토글 + 그 아래 접히는 컨테이너. 반환된 곳에 Setting을 넣는다. */
  private collapsible(
    parent: HTMLElement,
    desc: string,
    open: boolean,
    onToggle: (v: boolean) => void
  ): HTMLElement {
    let box: HTMLElement;
    new Setting(parent)
      .setName("세부 설정 보기")
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(open).onChange((v) => {
          onToggle(v);
          box.style.display = v ? "" : "none";
        })
      );
    box = parent.createDiv();
    box.style.display = open ? "" : "none";
    return box;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl("h2", { text: "Tasks ⇄ Google Calendar Sync" });

    // ---- 1. Google 인증 ----
    containerEl.createEl("h3", { text: "1. Google 인증" });
    containerEl.createEl("p", {
      text: "Google Cloud Console에서 OAuth 클라이언트(Desktop app)를 만들고 Client ID/Secret을 입력하세요. 인증은 데스크탑에서 실행합니다. 자격증명은 이 기기의 localStorage에만 저장되어 Obsidian Sync를 타지 않습니다 — 기기마다 개별 설정이 필요합니다.",
      cls: "setting-item-description",
    });

    new Setting(containerEl).setName("Client ID").addText((t) =>
      t
        .setPlaceholder("xxxx.apps.googleusercontent.com")
        .setValue(s.clientId)
        .onChange(async (v) => {
          s.clientId = v.trim();
          await this.plugin.saveAll();
        })
    );

    new Setting(containerEl).setName("Client Secret").addText((t) => {
      t.setValue(s.clientSecret).onChange(async (v) => {
        s.clientSecret = v.trim();
        await this.plugin.saveAll();
      });
      t.inputEl.type = "password";
    });

    new Setting(containerEl)
      .setName("인증 상태")
      .setDesc(this.plugin.auth.isAuthenticated() ? "✅ 인증됨" : "❌ 미인증")
      .addButton((b) =>
        b
          .setButtonText("Google 인증")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.auth.authenticateInteractive();
              new Notice("Google 인증 완료");
              this.display();
            } catch (e: any) {
              new Notice("인증 실패: " + e.message);
              console.error(e);
            }
          })
      );

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
            const cals = await this.plugin.client.listCalendars();
            s.calendars = cals.map((c) => ({ id: c.id, name: c.summary }));
            await this.plugin.saveAll();
            new Notice(`${cals.length}개 캘린더 로드됨`);
            this.display();
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
          await this.plugin.saveAll();
        });
      });

    // 태그 prefix
    new Setting(containerEl)
      .setName("라우팅 태그 prefix")
      .setDesc("기본 #gcal/ — task의 이 prefix 뒤 이름으로 캘린더를 찾습니다.")
      .addText((t) =>
        t.setValue(s.routingTagPrefix).onChange(async (v) => {
          s.routingTagPrefix = v.trim() || "#gcal/";
          await this.plugin.saveAll();
        })
      );

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
              await this.plugin.saveAll();
            })
        )
        .addDropdown((d) => {
          d.addOption("", "— 캘린더 —");
          for (const c of cals) d.addOption(c.id, c.name);
          d.setValue(rule.calendarId);
          d.onChange(async (v) => {
            rule.calendarId = v;
            rule.calendarName = cals.find((c) => c.id === v)?.name ?? "";
            await this.plugin.saveAll();
          });
        })
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("규칙 삭제")
            .onClick(async () => {
              s.rules.splice(idx, 1);
              await this.plugin.saveAll();
              this.display();
            })
        );
      setting.controlEl.style.flexWrap = "wrap";
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("+ 규칙 추가").onClick(async () => {
        s.rules.push({ tag: "", calendarId: "", calendarName: "" });
        await this.plugin.saveAll();
        this.display();
      })
    );

    // ---- 3. 동작 ----
    containerEl.createEl("h3", { text: "3. 동작" });

    new Setting(containerEl)
      .setName("Global filter")
      .setDesc("이 태그가 있는 task만 대상. Obsidian Tasks 설정과 동일하게.")
      .addText((t) =>
        t.setValue(s.globalFilter).onChange(async (v) => {
          s.globalFilter = v.trim();
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("제목 접두사 (미완료 / 완료)")
      .setDesc(
        "이벤트 제목 앞 체크박스 표식. 미완료=☐, 완료=☑️ → 색이 안 보이는 모바일에서도 제목으로 완료 확인. 비우면 안 붙음."
      )
      .addText((t) =>
        t
          .setPlaceholder("☐ (미완료)")
          .setValue(s.todoPrefix)
          .onChange(async (v) => {
            s.todoPrefix = v;
            await this.plugin.saveAll();
          })
      )
      .addText((t) =>
        t
          .setPlaceholder("☑️ (완료)")
          .setValue(s.donePrefix)
          .onChange(async (v) => {
            s.donePrefix = v;
            await this.plugin.saveAll();
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
            await this.plugin.saveAll();
          })
      );

    new Setting(containerEl)
      .setName("완료 색")
      .setDesc(
        "캘린더 앱에서 이벤트를 이 색으로 바꾸면 Obsidian에서 완료 처리(되돌리면 완료 취소). 이게 GCal 쪽 완료 제스처다. '끄기' 선택 시 제목 #done 방식으로 폴백."
      )
      .addDropdown((d) => {
        d.addOption("", "끄기 (제목 #done)");
        for (const c of GCAL_COLORS) d.addOption(c.id, `${c.id}. ${c.name}`);
        d.setValue(s.doneColorId);
        d.onChange(async (v) => {
          s.doneColorId = v;
          await this.plugin.saveAll();
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
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Overdue 포함")
      .setDesc("오늘 이전인데 아직 미완료인 task도 동기화.")
      .addToggle((t) =>
        t.setValue(s.includeOverdue).onChange(async (v) => {
          s.includeOverdue = v;
          await this.plugin.saveAll();
        })
      );

    // 완료 색·free를 둘 다 꺼야 쓰이는 폴백이라 평소엔 접어 둔다.
    const doneBox = this.collapsible(
      containerEl,
      "완료 색을 껐을 때만 쓰이는 폴백 설정.",
      this.showDoneDetails,
      (v) => (this.showDoneDetails = v)
    );

    new Setting(doneBox)
      .setName("완료 표시 태그 (#done 폴백용)")
      .setDesc("완료 색이 '끄기'일 때 — 완료 task 제목 앞에 붙는 태그.")
      .addText((t) =>
        t.setValue(s.doneTag).onChange(async (v) => {
          s.doneTag = v.trim() || "#done";
          await this.plugin.saveAll();
        })
      );

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
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("편집 후 대기(초)")
      .setDesc(
        "편집이 멎고 이 시간이 지나면 동기화. 길수록 연속 작업(날짜 → 시작일 → 우선순위)이 한 번으로 합쳐진다."
      )
      .addText((t) =>
        t.setValue(String(s.autoPushDebounceSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.autoPushDebounceSeconds = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("자동 동기화 최소 간격(초)")
      .setDesc(
        "직전 동기화 후 이 시간 안에는 자동으로 다시 돌지 않는다(자동 트리거만 해당, 수동/리본은 항상 즉시). 0이면 제한 없음."
      )
      .addText((t) =>
        t.setValue(String(s.minSyncIntervalSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.minSyncIntervalSeconds = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl).setName("시작 시 동기화").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.plugin.saveAll();
      })
    );

    new Setting(containerEl)
      .setName("자동 동기화 주기(분)")
      .setDesc("0이면 주기 동기화 없음.")
      .addText((t) =>
        t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.syncIntervalMinutes = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveAll();
          this.plugin.setupInterval();
        })
      );

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("지금 동기화")
        .setCta()
        .onClick(() => this.plugin.runSync())
    );
  }
}
