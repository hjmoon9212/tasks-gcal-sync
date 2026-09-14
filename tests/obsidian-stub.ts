/*
 * 테스트용 obsidian 모듈 스텁. 실제 앱 API는 테스트가 직접 스텁 객체로 주입하므로,
 * 여기서는 "번들이 깨지지 않을 최소한의 값"만 제공한다.
 *
 * ⚠️ 스텁은 실제 계약을 흉내내야 한다 — 느슨하면 그만큼이 검증되지 않는다
 *    (instanceof TFile 을 안 지켜 9개가 한꺼번에 깨진 적이 있다, 0.9.11).
 */
export class TFile {
  path = "";
  extension = "md";
}
export class TAbstractFile {}

/** 띄운 Notice 를 모아 둔다 — "사용자에게 무엇을 말했나" 를 테스트가 볼 수 있게. */
export const noticeLog: string[] = [];
export class Notice {
  constructor(msg: string, _timeout?: number) {
    noticeLog.push(msg);
  }
  setMessage(msg: string): this {
    noticeLog.push(msg);
    return this;
  }
  hide(): void {}
}

/**
 * Plugin 최소 구현. 등록 API 는 호출을 기록만 한다(main.test 가 명령·이벤트 배선을 본다).
 * 생성자 시그니처는 실제와 같다: `new Plugin(app, manifest)`.
 */
export class Plugin {
  app: any;
  manifest: any;
  __commands: any[] = [];
  __ribbon: any[] = [];
  __events: any[] = [];
  __intervals: number[] = [];
  __settingTabs: any[] = [];
  __data: any = null;
  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest ?? { id: "tasks-gcal-sync", version: "0.0.0-test" };
  }
  addCommand(cmd: any): any {
    this.__commands.push(cmd);
    return cmd;
  }
  addRibbonIcon(icon: string, title: string, cb: (evt?: any) => any): any {
    const el = { icon, title, cb };
    this.__ribbon.push(el);
    return el;
  }
  addStatusBarItem(): any {
    return {
      text: "",
      title: "",
      setText(t: string) {
        this.text = t;
      },
      setAttr(k: string, v: string) {
        if (k === "title" || k === "aria-label") this.title = v;
      },
      addEventListener() {},
      onClickEvent() {},
    };
  }
  addSettingTab(tab: any): void {
    this.__settingTabs.push(tab);
  }
  registerEvent(ref: any): void {
    this.__events.push(ref);
  }
  registerInterval(id: number): number {
    this.__intervals.push(id);
    return id;
  }
  register(_cb: () => any): void {}
  async loadData(): Promise<any> {
    return this.__data;
  }
  async saveData(data: any): Promise<void> {
    this.__data = JSON.parse(JSON.stringify(data));
  }
}
export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any;
  constructor(app?: any, plugin?: any) {
    this.app = app;
    this.plugin = plugin;
  }
}
export class Setting {}
export const Platform = { isDesktopApp: true, isMobile: false };
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

type RequestFn = (opts: any) => Promise<any>;
let requestImpl: RequestFn | null = null;
/**
 * `requestUrl` 구현을 테스트가 주입한다. null 이면 호출 즉시 던진다 —
 * 모르는 사이 네트워크 경로를 타는 테스트가 생기면 안 되기 때문이다.
 */
export function __setRequestUrl(fn: RequestFn | null): void {
  requestImpl = fn;
}
export async function requestUrl(opts: unknown): Promise<any> {
  if (!requestImpl) {
    throw new Error("requestUrl은 테스트에서 호출되면 안 됩니다 (스텁을 주입하세요).");
  }
  return requestImpl(opts);
}
