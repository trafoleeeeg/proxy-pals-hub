import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { closeSessionSchema, launchSchema, heartbeatSchema, profileIdSchema, saveSessionSchema } from "./server-validation";
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
    if (data.saveId) {
      const { createHash } = await import("node:crypto");
      const { synchronizedCookies } = await import("../../desktop/runtime/cookie-identity.cjs");
      // Compute identity from validated data here; never trust a client hash.
      return callServerRpc(context.supabase, "save_profile_cookie_checkpoint", {
        _profile_id: data.profileId, _lock_token: lockToken, _device_id: data.deviceId ?? null,
        _save_id: data.saveId, _base_revision: data.baseRevision ? new Date(data.baseRevision).toISOString() : null,
        _cookie_hash: createHash("sha256").update(synchronizedCookies(cookies)).digest("hex"),
        _cookies_enc: encryptSecret(JSON.stringify(cookies)),
      });
    }
    const result = await callServerRpc(context.supabase, "mutate_profile_lease", {
      _profile_id: data.profileId, _lock_token: lockToken, _operation: "save",
      _cookies_enc: encryptSecret(JSON.stringify(cookies)), _device_id: data.deviceId ?? null,
    });
    return { ok: true, cookiesUpdatedAt: result.cookiesUpdatedAt };
  });

export const heartbeatProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(heartbeatSchema)
  .handler(async ({ data, context }) => {
    const result = await callServerRpc(context.supabase, "mutate_profile_lease", {
      _profile_id: data.profileId, _lock_token: requireLeaseToken(data.lockToken), _operation: "heartbeat",
      _cookies_enc: null, _device_id: data.deviceId ?? null,
    });
    const proof = data.cookieSaveProtocol === 1 ? await callServerRpc(context.supabase, "get_profile_cookie_save_proof", {
      _profile_id: data.profileId, _lock_token: requireLeaseToken(data.lockToken), _device_id: data.deviceId ?? "",
    }) : null;
    return { expiresAt: result.expiresAt, ...(proof ? { cookieSaveProof: proof.proof } : {}) };
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
