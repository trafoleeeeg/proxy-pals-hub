export type UpdateStatus =
  | { state: "none" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number; version?: string }
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
  checkProxy?: (payload: {
    id: string;
    protocol: string;
    host: string;
    port: number;
    username: string | null;
    password: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    result?: {
      ok: boolean;
      ip?: string;
      country?: string;
      city?: string;
      latency?: number;
      error?: string;
    };
  }>;
  appVersion: () => Promise<string>;
  checkUpdate: () => Promise<{ ok: boolean; version?: string | null; current?: string; error?: string }>;
  updateState: () => Promise<UpdateStatus>;
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
