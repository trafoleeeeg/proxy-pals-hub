import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { notifyPanelPainted } from "@/lib/panel-paint";

export function PanelPainted() {
  const loading = useRouterState({ select: (state) => state.isLoading || state.status === "pending" });
  useEffect(() => {
    if (loading) return undefined;
    return notifyPanelPainted(window.umbra);
  }, [loading]);
  return null;
}
