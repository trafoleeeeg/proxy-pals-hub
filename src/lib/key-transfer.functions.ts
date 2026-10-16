import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { keyTransferConfig } from "./key-transfer-config.server";
import { KEY_TRANSFER_UNAVAILABLE, sealKeyTransfer, validateKeyTransferConfig, validateKeyTransferHttp, validateRecentPassword } from "./key-transfer.server";
import type { ServerContext } from "./server-db";

const noStore = createMiddleware({ type: "function" }).server(async ({ next }) => {
  setResponseHeader("Cache-Control", "no-store, private, max-age=0");
  setResponseHeader("Pragma", "no-cache");
  setResponseHeader("X-Content-Type-Options", "nosniff");
  return next();
});
const emptyInput = (input: unknown) => {
  if (!z.object({}).strict().safeParse(input).success) throw new Error(KEY_TRANSFER_UNAVAILABLE);
  return {};
};

async function authorize(context: ServerContext & { claims: Record<string, unknown> }, now: number) {
  validateRecentPassword(context.claims, now);
  // Revalidate with Auth, not merely with a locally cached JWT signature.
  const user = await context.supabase.auth.getUser();
  if (user.error || !user.data.user || user.data.user.id !== context.userId || user.data.user.is_anonymous) throw new Error(KEY_TRANSFER_UNAVAILABLE);
  // Explicitly check both fields: an RPC error must not grant access even if a
  // malformed/mock response happens to include data:true. Team owner is NOT enough.
  const role = await context.supabase.rpc("is_superadmin");
  if (role.error || role.data !== true) throw new Error(KEY_TRANSFER_UNAVAILABLE);
}

export const getKeyTransferStatus = createServerFn({ method: "POST" })
  .middleware([noStore, requireSupabaseAuth]).inputValidator(emptyInput)
  .handler(async ({ context }) => {
    try {
      await authorize(context, Date.now());
      if (!keyTransferConfig.enabled) return { enabled: false as const };
      const request = validateKeyTransferConfig(keyTransferConfig, Date.now());
      validateKeyTransferHttp(getRequest(), request);
      return { enabled: true as const, transferId: request.transferId, keyId: request.keyId, sourceOrigin: request.sourceOrigin, targetOrigin: request.targetOrigin, expiresAt: request.expiresAt };
    } catch { throw new Error(KEY_TRANSFER_UNAVAILABLE); }
  });

export const exportEncryptedMigrationKey = createServerFn({ method: "POST" })
  .middleware([noStore, requireSupabaseAuth]).inputValidator(emptyInput)
  .handler(async ({ context }) => {
    try {
      const request = validateKeyTransferConfig(keyTransferConfig, Date.now());
      validateKeyTransferHttp(getRequest(), request);
      await authorize(context, Date.now());
      validateKeyTransferConfig({ enabled: keyTransferConfig.enabled, request }, Date.now());
      validateRecentPassword(context.claims, Date.now());
      // No environment value is accessed before the complete authorization and
      // recipient/time/origin checks. No supplied env name or recipient is accepted.
      const rawKey = process.env["APP_ENCRYPTION_KEY"];
      if (!rawKey) throw new Error(KEY_TRANSFER_UNAVAILABLE);
      const { randomBytes } = await import("node:crypto");
      const { encryptSecret } = await import("./crypto.server");
      const plain = randomBytes(32).toString("base64");
      const canary = { plain, encrypted: encryptSecret(plain) };
      return sealKeyTransfer(rawKey, canary, request, Date.now());
    } catch {
      // Do not forward nested exceptions, request bodies, crypto inputs or causes
      // into TanStack's error transport / global error capture.
      throw new Error(KEY_TRANSFER_UNAVAILABLE);
    }
  });
