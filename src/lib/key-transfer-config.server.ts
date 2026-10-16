import type { KeyTransferRequest } from "./key-transfer.server";

// Owner-approved replacement window for guarded export diagnostics.
// Public recipient metadata only; expiry is absolute, no automatic extension.
// Never put the APP key, recipient private key or authentication tokens here.
export const keyTransferConfig: { enabled: boolean; request: KeyTransferRequest | null } = {
  enabled: true,
  request: {
      "format": "umbra-key-transfer-request-v1",
      "transferId": "b44f50f3-f79a-47c9-ba0f-cfabb7ca92bb",
      "keyId": "e6750e281ca21ac245b67ffe1c7426747b9fb54ad196546325f99280f37da29a",
      "sourceOrigin": "https://proxy-pals-hub.lovable.app",
      "targetOrigin": "https://umbra.mafiatrafa.com",
      "createdAt": "2026-10-16T19:53:18.730Z",
      "expiresAt": "2026-10-16T20:23:18.730Z",
      "publicKeySpki": "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAxBEdN+a7dE0uwk0cFdZDMu6gY+eDeybtDl1M6gSKw9TEOB19H7MQ18vcZkW9JsAx3TagATA3pmGZVCEVPP4Yc6PNr1hrISt0FeMDXl+4RatKWNUBErzFDtsas/T036icM9EzfqutOgK6K8qnyw1J6XajIB+bscWr1pPpYx3jsWF7xABiPwc+kJZelhFJrS0SD2IF49C5rkOXx/nr2pC7OMVseyTqeuhcBJe74SZObsuHDb4R2x3W93n6QoJBL7jHWYQdfnO2sjyB/UD4gCHEg5WoMoZ/jgpGpk8rb3uJ85MKYBMHsdYONxTpoqItABSar+IirdeN9HaA7/ekysRPypgL8WaONvj0eG+Q8z4twos7OUZTePEB6D/Qk/NFhB7ibN3g8wojUIauLeMz93RbzvD5Qj/i6S68wSlL41dnQUqbH3aIRZ0Hj3pFwaaxLG85Bv41n8di+DZz3Cw7tC351iw1ocsVBBOsLNTMJk3+bcZzXiMlyAnR9geyPblmfURBAgMBAAE="
  },
};
