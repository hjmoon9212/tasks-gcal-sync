/*
 * 테스트용 obsidian 모듈 스텁. 실제 앱 API는 테스트가 직접 스텁 객체로 주입하므로,
 * 여기서는 "번들이 깨지지 않을 최소한의 값"만 제공한다.
 */
export class TFile {
  path = "";
  extension = "md";
}
export class TAbstractFile {}
export class Notice {
  constructor(_msg: string, _timeout?: number) {}
}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export const Platform = { isDesktopApp: true, isMobile: false };
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
export async function requestUrl(_opts: unknown): Promise<never> {
  throw new Error("requestUrl은 테스트에서 호출되면 안 됩니다 (스텁을 주입하세요).");
}
