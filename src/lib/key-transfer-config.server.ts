import type { KeyTransferRequest } from "./key-transfer.server";

// Temporary export disabled after protected local receipt was verified.
// Any new recipient or window requires fresh explicit owner approval.
// Never put the APP key, recipient private key or authentication tokens here.
export const keyTransferConfig: { enabled: boolean; request: KeyTransferRequest | null } = {
  enabled: false,
  request: null,
};
