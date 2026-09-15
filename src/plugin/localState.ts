import { PluginSettings } from "../settings/Settings";
import { PersistedState } from "../sync/StateStore";

/** localStorage 키. App.saveLocalStorage가 볼트 단위로 네임스페이스를 붙인다. */
export const STATE_LS_KEY = "tasks-gcal-sync:state";

/**
 * 기기-로컬 state 구조. 항목마다 성격이 다르다:
 *  - **자격증명** = 진실원천. 기기 고유이고 동기화되면 안 된다(v0.3.1의 존재 이유).
 *  - **records / syncTokens** = 캐시. 매핑도 스냅샷도 이미 GCal 이벤트의
 *    extendedProperties(tgsTaskId/tgsDue/tgsStart/tgsDone/tgsTitle)에 심겨 있어
 *    캘린더 스캔 한 번으로 복원된다(CalendarPuller.rebuildRecords). 잃어도 된다.
 *
 * v0.3.8부터 저장 위치가 플러그인 폴더의 state.json → **localStorage**다.
 * state.json은 `.obsidian/plugins/...` 안이라 "설치된 커뮤니티 플러그인" 동기화가
 * 켜진 기기에서는 결국 동기화된다 — 기기-로컬이라는 전제가 거기서 깨져,
 * 자격증명이 Sync를 타고 기기끼리 파일 단위로 덮어써졌다. localStorage는 동기화되지 않는다.
 *
 * main.ts 에서 옮겼다(0.12.8).
 */
export interface StateFile {
  records: PersistedState["records"];
  syncTokens: PersistedState["syncTokens"];
  lastFullScanAt?: PersistedState["lastFullScanAt"];
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string | null;
  /**
   * 동기화 로그 파일에 붙는 이 기기의 이름.
   *
   * **자격증명과 같은 이유로 여기(localStorage)에 있다** — data.json에 두면 기기끼리
   * 동기화돼 서로의 태그를 덮어쓰고, 그러면 두 기기가 결국 같은 파일에 쓰게 되어
   * 분리한 의미가 없어진다. 한 번 정해지면 바뀌지 않는다(사용자가 설정에서 바꾸기 전까지).
   */
  logDeviceTag?: string;
}

/** localStorage 에서 읽은 값(문자열 또는 객체)을 StateFile 로. 비었으면 null, 깨졌으면 던진다. */
export function parseLocalState(raw: unknown): StateFile | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as StateFile;
}

/** 저장할 모양. **키 순서가 곧 localStorage 에 적히는 JSON 순서**다. */
export function toStateFile(state: PersistedState, settings: PluginSettings): StateFile {
  return {
    records: state.records,
    syncTokens: state.syncTokens,
    lastFullScanAt: state.lastFullScanAt,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    logDeviceTag: state.logDeviceTag,
  };
}

/**
 * 자격증명 우선순위: **localStorage > 구 state.json > data.json**.
 * data.json 쪽 값은 가장 낮은 우선순위 — Sync를 타는 곳이라 롤백된 옛 secret일 수 있다.
 *
 * clientId·clientSecret 은 빈 문자열을 건너뛰고, refreshToken 은 **undefined 만** 건너뛴다
 * (localStorage 의 null 이 뒤의 실제 토큰을 이긴다 — 현재 동작, 백로그 B15).
 */
export function pickCredentials(
  local: StateFile | null,
  legacy: StateFile | null,
  settings: Pick<PluginSettings, "clientId" | "clientSecret" | "refreshToken">
): Pick<PluginSettings, "clientId" | "clientSecret" | "refreshToken"> {
  const firstStr = (...v: (string | undefined)[]) => v.find((s) => !!s);
  const firstDef = <T>(...v: (T | undefined)[]) => v.find((x) => x !== undefined);
  return {
    clientId: firstStr(local?.clientId, legacy?.clientId, settings.clientId) ?? "",
    clientSecret:
      firstStr(local?.clientSecret, legacy?.clientSecret, settings.clientSecret) ?? "",
    refreshToken:
      firstDef(local?.refreshToken, legacy?.refreshToken, settings.refreshToken) ?? null,
  };
}
