/**
 * 이 기기 로그 파일에 붙일 이름을 **처음 한 번** 정한다.
 *
 * Obsidian Sync의 기기 이름을 빌리되 **라벨로만 쓴다** — 비공식 API이고 Sync가
 * 꺼져 있거나 아직 준비되지 않았을 수 있다. 없으면 난수로 대체한다. 정한 값은 호출부가
 * localStorage 에 굳힌다(파일 이름이 도중에 바뀌면 기록이 두 파일로 갈린다).
 *
 * main.deviceTag 에서 옮겼다(0.12.8).
 */
export function chooseDeviceTag(syncInstance: any, random: () => number = Math.random): string {
  return typeof syncInstance?.deviceName === "string" && syncInstance.deviceName.trim()
    ? syncInstance.deviceName.trim()
    : `기기-${random().toString(36).slice(2, 6)}`;
}
