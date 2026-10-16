import type { KeyTransferRequest } from "./key-transfer.server";

// Deliberately OFF. Activation requires a reviewed public recipient manifest,
// an absolute <=24h window and the owner's approval immediately before deploy.
// Never put the APP key, recipient private key or authentication tokens here.
export const keyTransferConfig: { enabled: boolean; request: KeyTransferRequest | null } = {
  enabled: false,
  request: null,
};
