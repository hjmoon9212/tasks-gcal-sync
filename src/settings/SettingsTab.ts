import { App, PluginSettingTab } from "obsidian";
import type TasksGcalSyncPlugin from "../main";
import { SectionCtx } from "./controls";
import { renderMobileSection } from "./sections/mobile";
import { renderAuthSection } from "./sections/auth";
import { renderRoutingSection } from "./sections/routing";
import { renderFeedSection } from "./sections/feed";
import { renderBehaviorSection } from "./sections/behavior";
import { renderTimingSection } from "./sections/timing";
import { renderLogSection } from "./sections/log";

export class SettingsTab extends PluginSettingTab {
  /** 기기 태그가 붙은 실제 로그 경로를 보여주는 줄. 경로·기기명이 바뀌면 다시 그린다. */
  private logPathEl?: HTMLElement;

  constructor(app: App, private plugin: TasksGcalSyncPlugin) {
    super(app, plugin);
  }

  /**
   * 세부 값이 바뀔 때 display()로 전체를 다시 그리면 텍스트 입력 중 포커스가 날아간다.
   * 그래서 이 한 줄만 갈아끼운다.
   */
  private renderLogPath(): void {
    if (!this.logPathEl) return;
    this.logPathEl.setText(`실제 파일: ${this.plugin.logPath()}`);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Tasks ⇄ Google Calendar Sync" });

    // 섹션 순서가 곧 화면 순서다. 값 입력칸은 다시 그리지 않는다(포커스 유실) —
    // 목록·버튼처럼 모양이 바뀌는 조작만 rerender() 로 전체를 다시 그린다.
    const ctx: SectionCtx = {
      containerEl,
      plugin: this.plugin,
      rerender: () => this.display(),
      setLogPathEl: (el) => {
        this.logPathEl = el;
      },
      renderLogPath: () => this.renderLogPath(),
    };
    renderMobileSection(ctx);
    renderAuthSection(ctx);
    renderRoutingSection(ctx);
    renderFeedSection(ctx);
    renderBehaviorSection(ctx);
    renderTimingSection(ctx);
    renderLogSection(ctx);
  }
}
