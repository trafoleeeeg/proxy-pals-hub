import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { touchPresence } from "@/lib/presence.functions";

const HEARTBEAT_MS = 45_000;

// Отмечает, что сотрудник в сети и в каком профиле он сейчас работает.
export function usePresenceHeartbeat(teamId: string | undefined, running: { profileId: string }[]) {
  const touch = useServerFn(touchPresence);
  const activeRef = useRef<string | null>(null);
  activeRef.current = running[0]?.profileId ?? null;

  useEffect(() => {
    if (!teamId) return;
    let stopped = false;
    const send = () => {
      if (stopped) return;
      const profileId = activeRef.current;
      void touch({ data: { teamId, ...(profileId ? { profileId } : {}) } }).catch(() => {
        /* активность не критична: молча пропускаем */
      });
    };
    send();
    const timer = window.setInterval(send, HEARTBEAT_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [teamId, touch, running.map((item) => item.profileId).join(",")]);
}
