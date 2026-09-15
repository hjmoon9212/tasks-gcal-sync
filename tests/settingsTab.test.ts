/**
 * 설정 탭 특성화(0.12.9 분리 전에 먼저 고정한다).
 *
 * 설정 탭은 지금까지 테스트가 없었다. 575줄짜리 display() 를 섹션별 파일로 나누기 전에 두 가지를
 * 골든으로 못 박는다:
 *   1. **무엇을 어떤 순서로 그리나** — 제목 · 설명 · 설정 줄 · 컨트롤(값·placeholder·옵션·버튼 문구)
 *   2. **각 핸들러가 무엇을 하나** — 바꾸는 설정 키 · 부르는 플러그인 메서드 · 띄우는 Notice ·
 *      ★ display() 를 다시 부르는가(값 입력 중에 부르면 포커스가 날아간다 → 목록·버튼만 다시 그린다)
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { Platform, noticeLog } from "./obsidian-stub";
import { SettingsTab } from "../src/settings/SettingsTab";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/settings/Settings";
import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";

// ── 가짜 컨테이너 ──
function fakeContainer() {
  const children: any[] = [];
  return {
    children,
    empty() {
      children.length = 0;
    },
    createEl(tag: string, o: { text?: string; cls?: string } = {}) {
      const el: any = {
        tag,
        text: o.text ?? "",
        cls: o.cls ?? "",
        setText(t: string) {
          this.text = t;
        },
      };
      children.push({ kind: "el", el });
      return el;
    },
    __push(node: any) {
      children.push(node);
    },
  };
}

function serialize(container: ReturnType<typeof fakeContainer>) {
  return container.children.map((n) => {
    if (n.kind === "el") return { el: n.el.tag, text: n.el.text, cls: n.el.cls || undefined };
    const s = n.setting;
    return {
      setting: s.nameText || "(이름 없음)",
      desc: s.descText || undefined,
      controls: s.controls.map((c: any) => {
        const o: any = { type: c.type };
        if ("value" in c) o.value = c.value;
        if (c.placeholder) o.placeholder = c.placeholder;
        if (c.options) o.options = c.options;
        if (c.inputEl && c.inputEl.type !== "text") o.inputType = c.inputEl.type;
        if (c.buttonText) o.buttonText = c.buttonText;
        if (c.icon) o.icon = c.icon;
        if (c.tooltip) o.tooltip = c.tooltip;
        if (c.cta) o.cta = true;
        if (c.disabled) o.disabled = true;
        o.handler = !!(c.onChangeCb || c.onClickCb);
        return o;
      }),
    };
  });
}

// ── 가짜 플러그인 ──
function makePlugin(over: Partial<PluginSettings> = {}) {
  const calls: any[] = [];
  const rec = (name: string) => async (...args: any[]) => {
    calls.push([name, ...JSON.parse(JSON.stringify(args))]);
  };
  const settings: PluginSettings = JSON.parse(
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "secret",
      refreshToken: "1//tok",
      calendars: [
        { id: "cal-a", name: "Growth", color: "#123456" },
        { id: "cal-b", name: "Work", color: "#654321" },
      ],
      defaultCalendarId: "cal-a",
      defaultCalendarName: "Growth",
      rules: [{ tag: "Personal", calendarId: "cal-b", calendarName: "Work" }],
      feedCalendars: [{ id: "cal-b", name: "Work", color: "" }],
      ...over,
    })
  );
  const plugin: any = {
    settings,
    calls,
    saveAll: rec("saveAll"),
    setupInterval: rec("setupInterval"),
    setupFeedInterval: rec("setupFeedInterval"),
    runSync: rec("runSync"),
    openSyncLog: rec("openSyncLog"),
    setDeviceTag: rec("setDeviceTag"),
    deviceTag: () => "기기-test",
    logPath: () => `${settings.syncLogPath} (기기-test)`,
    auth: {
      isAuthenticated: () => true,
      authenticateInteractive: rec("auth.authenticateInteractive"),
    },
    client: {
      listCalendars: async () => {
        calls.push(["client.listCalendars"]);
        return [{ id: "cal-z", summary: "Z", backgroundColor: "#000000" }];
      },
    },
    feed: {
      dropUnselected: () => calls.push(["feed.dropUnselected"]),
      refreshAll: rec("feed.refreshAll"),
    },
  };
  return plugin;
}

function mount(plugin: any) {
  const tab: any = new SettingsTab({} as any, plugin);
  const container = fakeContainer();
  tab.containerEl = container;
  tab.display();
  return { tab, container };
}

/** 컨트롤마다 새로 마운트해 핸들러 하나만 실행하고, 무엇이 바뀌었는지 적는다. */
async function exerciseAll(label: string, over: Partial<PluginSettings>) {
  const base = mount(makePlugin(over));
  const out: any[] = [];
  let section = "";
  const plan: { section: string; setting: string; ci: number; type: string; nodeIndex: number }[] = [];
  base.container.children.forEach((n: any, nodeIndex: number) => {
    if (n.kind === "el" && /^h[234]$/.test(n.el.tag)) section = n.el.text;
    if (n.kind !== "setting") return;
    n.setting.controls.forEach((c: any, ci: number) => {
      if (c.onChangeCb || c.onClickCb) {
        plan.push({ section, setting: n.setting.nameText || "(이름 없음)", ci, type: c.type, nodeIndex });
      }
    });
  });

  for (const p of plan) {
    const plugin = makePlugin(over);
    const { tab, container } = mount(plugin);
    const node = container.children[p.nodeIndex];
    const c = node.setting.controls[p.ci];
    const before = JSON.parse(JSON.stringify(plugin.settings));
    let displays = 0;
    const realDisplay = tab.display.bind(tab);
    tab.display = () => {
      displays++;
      realDisplay();
    };
    noticeLog.length = 0;
    let input: any;
    if (c.type === "text") input = "  7  ";
    else if (c.type === "toggle") input = !c.value;
    else if (c.type === "dropdown") {
      // 현재 값과 **다른** 마지막 옵션 — 같은 값을 고르면 핸들러가 무엇을 바꾸는지 안 보인다
      const others = c.options.filter(([v]: [string, string]) => v !== c.value);
      input = (others.length ? others : c.options)[(others.length ? others : c.options).length - 1][0];
    }
    try {
      if (c.onChangeCb) await c.onChangeCb(input);
      else await c.onClickCb();
    } catch (e) {
      plugin.calls.push(["THREW", e instanceof Error ? e.message : String(e)]);
    }
    await new Promise((r) => setTimeout(r, 0));
    const after = plugin.settings;
    const changed: Record<string, any> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify((after as any)[k])) changed[k] = (after as any)[k];
    }
    out.push({
      section: p.section,
      setting: p.setting,
      control: `${p.ci}:${p.type}${c.buttonText ? " " + c.buttonText : ""}`,
      input,
      changed,
      calls: plugin.calls,
      notices: [...noticeLog],
      display: displays,
      logPathLine: tab.logPathEl?.text,
    });
  }
  golden(`settingsTab.handlers.${label}`, out);
}

(async () => {
  // 클립보드: 복사는 기록, 붙여넣기는 유효한 자격증명 묶음을 준다
  const clip: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (t: string) => {
          clip.push(t);
        },
        readText: async () =>
          JSON.stringify({ v: 1, clientId: "pasted-id", clientSecret: "pasted-secret", refreshToken: "1//pasted" }),
      },
    },
  });

  // ── 화면 트리 ──
  (Platform as any).isMobile = false;
  (Platform as any).isDesktopApp = true;
  golden("settingsTab.tree.desktop", serialize(mount(makePlugin()).container));
  golden("settingsTab.tree.no-calendars", serialize(mount(makePlugin({ calendars: [], rules: [], feedCalendars: [] })).container));
  (Platform as any).isMobile = true;
  (Platform as any).isDesktopApp = false;
  golden("settingsTab.tree.mobile", serialize(mount(makePlugin()).container));

  // ── 핸들러 ──
  (Platform as any).isMobile = false;
  (Platform as any).isDesktopApp = true;
  await exerciseAll("desktop", {});
  (Platform as any).isMobile = true;
  (Platform as any).isDesktopApp = false;
  await exerciseAll("mobile-no-creds", { clientId: "", clientSecret: "", refreshToken: null });
  (Platform as any).isMobile = false;
  (Platform as any).isDesktopApp = true;
  golden("settingsTab.clipboard", clip);

  done();
})();
