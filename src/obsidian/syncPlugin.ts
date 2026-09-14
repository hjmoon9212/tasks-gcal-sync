import { App } from "obsidian";

/**
 * Obsidian Sync 코어 플러그인의 인스턴스. **비공식 API** 라 없거나 모양이 바뀔 수 있다 —
 * 부르는 쪽은 항상 필드 존재를 확인하고, 모르면 기능을 끄는 쪽이 아니라 통과시키는 쪽으로
 * 실패해야 한다(fail-open).
 *
 * 쓰는 곳: VaultGuard.vaultBehind(상태 토큰·syncing·pause) · main.deviceTag(deviceName 라벨).
 */
export function getSyncInstance(app: App): any | undefined {
  return (app as any).internalPlugins?.plugins?.sync?.instance;
}
