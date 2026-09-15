import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { closeSessionSchema, launchSchema, leaseSchema, profileIdSchema, saveSessionSchema } from "./server-validation";
import { callServerRpc, requireProfile } from "./server-db";
import { parseCookieImport } from "./server-cookies";
import { classifyTerminalClose, prepareSessionLaunch, requireLeaseToken } from "./server-session";

export const launchProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(launchSchema)
  .handler(async ({ data, context }) => {
    const { decryptSecret } = await import("./crypto.server");
    return prepareSessionLaunch(context, data, decryptSecret);
  });

export const saveProfileSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(saveSessionSchema)
  .handler(async ({ data, context }) => {
    const lockToken = requireLeaseToken(data.lockToken);
    const cookies = parseCookieImport(data.cookies);
    const { encryptSecret } = await import("./crypto.server");
    const result = await callServerRpc(context.supabase, "mutate_profile_lease", {
      _profile_id: data.profileId, _lock_token: lockToken, _operation: "save",
      _cookies_enc: encryptSecret(JSON.stringify(cookies)), _device_id: data.deviceId ?? null,
    });
    return { ok: true, cookiesUpdatedAt: result.cookiesUpdatedAt };
  });

export const heartbeatProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(leaseSchema)
  .handler(async ({ data, context }) => {
    const result = await callServerRpc(context.supabase, "mutate_profile_lease", {
      _profile_id: data.profileId, _lock_token: requireLeaseToken(data.lockToken), _operation: "heartbeat",
      _cookies_enc: null, _device_id: data.deviceId ?? null,
    });
    return { expiresAt: result.expiresAt };
  });

export const closeProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(closeSessionSchema)
  .handler(async ({ data, context }) => {
    const lockToken = requireLeaseToken(data.lockToken);
    let encrypted: string | null = null;
    if (data.cookies !== undefined) {
      const cookies = parseCookieImport(data.cookies);
      const { encryptSecret } = await import("./crypto.server");
      encrypted = encryptSecret(JSON.stringify(cookies));
    }
    try {
      const result = await callServerRpc(context.supabase, "mutate_profile_lease", {
        _profile_id: data.profileId, _lock_token: lockToken, _operation: "close", _cookies_enc: encrypted, _device_id: data.deviceId ?? null,
      });
      return { ok: true as const, cookiesUpdatedAt: result.cookiesUpdatedAt };
    } catch (error) {
      const terminal = classifyTerminalClose(error);
      if (!terminal) throw error;
      return { ok: false as const, terminal, cookiesUpdatedAt: null };
    }
  });

export const forceUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(profileIdSchema)
  .handler(async ({ data, context }) => {
    await requireProfile(context, data.profileId, true);
    await callServerRpc(context.supabase, "force_profile_unlock", { _profile_id: data.profileId });
    return { ok: true };
  });
