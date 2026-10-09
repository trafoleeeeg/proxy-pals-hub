import "./mock-api";
import { primaryClient } from "./mock-auth";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PanelConnection } from "../../src/components/panel-connection";
import { ConnectionUnavailableError, setConnectionUnavailable } from "../../src/lib/panel-connectivity";
import "../../src/styles.css";

const initialError = new ConnectionUnavailableError();
// A concurrent healthy check cleared the shared flag before this boundary mounted.
setConnectionUnavailable(false);
const recoveryFixture = { attempts: 0, verifications: 0, clearOffline: () => setConnectionUnavailable(false) };
const verifyUser = primaryClient.auth.getUser;
primaryClient.auth.getUser = async () => { recoveryFixture.verifications++; return verifyUser(); };
declare global { interface Window { recoveryFixture: typeof recoveryFixture } }
window.recoveryFixture = recoveryFixture;

function RecoveryBoundary() {
  const [recovered, setRecovered] = useState(false);
  return <main>
    <PanelConnection fullPage={!recovered} initialError={initialError} recovered={async () => {
      if (++recoveryFixture.attempts === 1) throw new ConnectionUnavailableError();
      setRecovered(true);
    }} />
    {recovered && <h1>Панель восстановлена</h1>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<RecoveryBoundary />);
