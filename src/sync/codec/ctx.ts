import { PluginSettings } from "../../settings/Settings";

/**
 * 코덱이 바깥에서 받는 것은 둘뿐이다 — 설정과 볼트 이름.
 *
 * - `settings` 는 **원본 객체를 그대로** 넘긴다. SettingsTab 이 값을 제자리에서 고치므로
 *   복사본을 들고 있으면 설정을 바꿔도 다음 run 까지(혹은 재시작까지) 옛 값으로 그린다.
 * - `vaultName()` 은 **부를 때마다 읽는다.** 캐시하면 볼트 이름을 바꾼 뒤에도 옛 이름을
 *   `tgsVault` 에 심어 isOurs 판정이 어긋난다.
 */
export interface CodecCtx {
  readonly settings: PluginSettings;
  vaultName(): string;
}
