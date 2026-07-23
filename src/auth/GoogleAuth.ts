import { Platform, requestUrl } from "obsidian";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export interface Creds {
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
}

/**
 * Google OAuth.
 * - 데스크탑: 루프백(127.0.0.1) redirect로 1회 인증 → refresh token 획득.
 * - 모바일: 인증 UI 없음. Obsidian Sync로 전파된 refresh token으로 access token만 silent 발급.
 * HTTP 호출은 모두 Obsidian requestUrl(CORS 우회). 루프백 서버만 데스크탑 node http 사용.
 */
export class GoogleAuth {
  private accessToken: string | null = null;
  private accessExpiry = 0;

  constructor(
    private getCreds: () => Creds,
    private saveRefreshToken: (token: string) => Promise<void>
  ) {}

  isAuthenticated(): boolean {
    return !!this.getCreds().refreshToken;
  }

  async getAccessToken(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.getCreds();
    if (!refreshToken) {
      throw new Error(
        "Google 인증이 필요합니다. 설정에서 'Google 인증'을 실행하세요(데스크탑)."
      );
    }
    if (this.accessToken && Date.now() < this.accessExpiry - 60_000) {
      return this.accessToken;
    }
    const resp = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      throw: false,
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (resp.status !== 200) {
      throw new Error(`토큰 갱신 실패 (${resp.status}): ${resp.text}`);
    }
    this.accessToken = resp.json.access_token;
    this.accessExpiry = Date.now() + resp.json.expires_in * 1000;
    return this.accessToken!;
  }

  /** 데스크탑 전용 대화형 인증. */
  async authenticateInteractive(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error(
        "모바일에서는 인증할 수 없습니다. 데스크탑에서 인증 후 Obsidian Sync로 토큰이 전파됩니다."
      );
    }
    const { clientId, clientSecret } = this.getCreds();
    if (!clientId || !clientSecret) {
      throw new Error("먼저 Client ID와 Client Secret을 입력하세요.");
    }

    const verifier = randomString(64);
    const challenge = await sha256base64url(verifier);
    const loopback = await startLoopbackServer();
    const redirectUri = `http://127.0.0.1:${loopback.port}`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    try {
      const authUrl = `${AUTH_URL}?${params.toString()}`;
      console.log("[tasks-gcal-sync] redirect_uri =", redirectUri);
      console.log("[tasks-gcal-sync] auth URL =", authUrl);
      openExternal(authUrl);
      const code = await Promise.race([
        loopback.waitForCode,
        new Promise<string>((_, rej) =>
          window.setTimeout(
            () =>
              rej(
                new Error(
                  "인증 시간 초과(3분). 브라우저에서 로그인·허용을 끝냈는지, '확인되지 않은 앱' 경고에서 '고급 → 이동'을 눌렀는지 확인하세요."
                )
              ),
            180_000
          )
        ),
      ]);
      console.log("[tasks-gcal-sync] authorization code 수신됨");
      const resp = await requestUrl({
        url: TOKEN_URL,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        throw: false,
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      if (resp.status !== 200) {
        throw new Error(`토큰 교환 실패 (${resp.status}): ${resp.text}`);
      }
      const refresh = resp.json.refresh_token;
      if (!refresh) {
        throw new Error(
          "refresh_token을 받지 못했습니다. Google 계정 권한을 해제 후 다시 시도하세요."
        );
      }
      this.accessToken = resp.json.access_token;
      this.accessExpiry = Date.now() + resp.json.expires_in * 1000;
      await this.saveRefreshToken(refresh);
    } finally {
      loopback.close();
    }
  }
}

// ---- helpers ----

interface Loopback {
  port: number;
  waitForCode: Promise<string>;
  close: () => void;
}

function startLoopbackServer(): Promise<Loopback> {
  // Electron 렌더러에서 노출되는 window.require로 node http 접근 (데스크탑 전용 경로)
  const http = (window as any).require("http");
  return new Promise((resolve, reject) => {
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    const waitForCode = new Promise<string>((rc, rj) => {
      resolveCode = rc;
      rejectCode = rj;
    });
    const server = http.createServer((req: any, res: any) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body style='font-family:sans-serif;padding:2rem'>" +
            (code
              ? "✅ 인증 완료. 이 창을 닫고 Obsidian으로 돌아가세요."
              : "❌ 인증 실패: " + (err ?? "unknown")) +
            "</body></html>"
        );
        if (code) resolveCode(code);
        else rejectCode(new Error(err ?? "no authorization code"));
      } catch (e) {
        rejectCode(e as Error);
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ port, waitForCode, close: () => server.close() });
    });
  });
}

function openExternal(url: string): void {
  try {
    const { shell } = (window as any).require("electron");
    shell.openExternal(url);
  } catch {
    window.open(url, "_blank");
  }
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len: number): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a).slice(0, len);
}

async function sha256base64url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return base64url(new Uint8Array(digest));
}
