import type { KeyTransferRequest } from "./key-transfer.server";

// Owner-approved short migration window. Public recipient metadata only.
// Fresh password + online superadmin authorization and exact source-origin
// checks remain mandatory. Expiry is absolute; disable after sealed export.
// Never put the APP key, recipient private key or authentication tokens here.
export const keyTransferConfig: { enabled: boolean; request: KeyTransferRequest | null } = {
  enabled: true,
  request: {
    format: "umbra-key-transfer-request-v1",
    transferId: "6d3875a0-a3cf-4468-9ba2-5bbea658c44c",
    keyId: "4511fdc639da078864e4ef0affaeb4af13010a07fb74d681865cb700576a4a47",
    sourceOrigin: "https://proxy-pals-hub.lovable.app",
    targetOrigin: "https://umbra.mafiatrafa.com",
    createdAt: "2026-10-16T19:26:46.258Z",
    expiresAt: "2026-10-16T19:56:46.258Z",
    publicKeySpki: "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAwfr/cEknjbGY//i9k7u5SsBxTVZPPnNwX1OAIkkLfPQI2A21ZSlsLpaRyWjPKNhHy9o89iAwbzk6xp+WHKsdEWgIAhDe6+ROHxP5JkrtayT4p9rVd4lSuwff4A3qjQuOXrM3SoL6U/wXGxqmsa316qqWfhUCgBtz7jpuiMl692nMgJy4omixTjLT6GarYGlaSlvxeeQ6BMJL/89KA02BdDFnZsfjxy1X/2LwH2gsi/I4ftRGus5Rm9o2cXLINQhEAFPQgFCxZMk2kI6Lq34Q0u3V8ELC/UcXBrnlZ5IESBqGJP+iySPnvq2wG8M4hB1sd6VtMWtDgoOqmHEjam3wDcxwppqQrPIgPGb0NmvXSecXsInRNW0q+xVjeZ3NbBwhQlwm0EeP1Q7AwdqZqyv/j/eUhajOF+UOHDCBBs1Qsf1+7wWS37oHaBiNpr5zT7/ne2ZYWznwDrtD6+hS3xzUvv/UgDZELO/L/B2Yg+lgCf/VzwUipLWY+ppDUI7FamJtAgMBAAE=",
  },
};
