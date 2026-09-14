export type UpdateStatus =
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; error: string };

export type UmbraBridge = {
  isDesktop: true;
  version: string;
  platform: string;
  launchProfile: (payload: unknown) => Promise<{ ok: boolean; error?: string }>;
  closeProfile: (profileId: string) => Promise<{ ok: boolean }>;
  openAuth: () => Promise<{ ok: boolean }>;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
  onAuthTokens: (cb: (t: { access_token: string; refresh_token: string }) => void) => () => void;
  appVersion: () => Promise<string>;
  checkUpdate: () => Promise<{ ok: boolean; version?: string | null; current?: string; error?: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<{ ok: boolean }>;
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void;
};

declare global {
  interface Window {
    umbra?: UmbraBridge;
  }
}

export function desktop(): UmbraBridge | null {
  if (typeof window === "undefined") return null;
  return window.umbra ?? null;
}
