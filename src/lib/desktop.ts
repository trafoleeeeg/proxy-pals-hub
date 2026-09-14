export type UpdateStatus =
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; error: string };

export type LaunchPayload = {
  profileId: string;
  name: string;
  fingerprint: unknown;
  proxy: unknown;
  cookies: string;
};

export type UmbraBridge = {
  isDesktop: true;
  version: string;
  platform: string;
  launchProfile: (payload: LaunchPayload) => Promise<{ ok: boolean; error?: string }>;
  closeProfile: (profileId: string) => Promise<{ ok: boolean }>;
  profileCookies: (profileId: string) => Promise<{ ok: boolean; cookies: string | null }>;
  onProfileClosed: (cb: (p: { profileId: string; cookies: string | null }) => void) => () => void;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
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
