// Component-only fixture: no production auth, database or user profiles.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProfileFingerprint } from "../../src/components/profile-fingerprint";
import { generateFingerprint } from "../../src/lib/fingerprint";
import type { UmbraBridge } from "../../src/lib/desktop";
import "../../src/styles.css";

if (new URLSearchParams(location.search).has("supported")) {
  window.umbra = { runtimeCapabilities: async () => ({ fontIsolation: true }) } as UmbraBridge;
}
function Editor() {
  const [value, onChange] = useState(generateFingerprint());
  return <main className="mx-auto max-w-2xl p-4">
    <ProfileFingerprint value={value} onChange={onChange} />
    <output data-testid="font-setting">{String(value.fontIsolation)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Editor /></StrictMode>);
