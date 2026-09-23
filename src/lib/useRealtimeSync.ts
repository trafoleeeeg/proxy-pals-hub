import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const TABLES = ["browser_profiles", "profile_access", "folder_access", "member_permissions", "profile_browser_settings"] as const;
const KEYS = ["profiles", "team", "folder-access", "folders", "permissions", "member-permissions", "workspace"];
const DEBOUNCE_MS = 400;

/**
 * Живое обновление панели. Подписка создаётся один раз и никогда не блокирует
 * загрузку: любая ошибка канала просто оставляет обычное обновление по таймеру.
 */
export function useRealtimeSync(teamId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!teamId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const refresh = () => {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        for (const key of KEYS) void qc.invalidateQueries({ queryKey: [key] });
      }, DEBOUNCE_MS);
    };
    const channel = supabase.channel(`umbra-sync-${teamId}`);
    for (const table of TABLES) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
    }
    try { channel.subscribe(); } catch { /* обновление по таймеру продолжит работать */ }
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [qc, teamId]);
}
