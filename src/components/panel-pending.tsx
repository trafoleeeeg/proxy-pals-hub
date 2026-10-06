import { useEffect, useState } from "react";
import { PanelLeft, LayoutGrid, Globe2, Users, Folder, Monitor } from "lucide-react";
import { notifyPanelPainted } from "@/lib/panel-paint";

// Public chrome only: no persisted user, folders, permissions or profile data.
// Protected routes remain unmounted until the server accepts the session.
export function PanelPending() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => notifyPanelPainted(window.umbra), []);
  return (
    <div className="flex h-screen overflow-hidden bg-sidebar text-foreground">
      <aside className={`${collapsed ? "w-16" : "w-16 sm:w-60"} shrink-0 p-3 transition-[width] duration-150`}>
        <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Раскрыть боковую панель" : "Скрыть боковую панель"} className="flex h-12 w-full items-center gap-3 rounded-lg px-2 hover:bg-sidebar-accent">
          <PanelLeft className="size-5 shrink-0" />{!collapsed && <span className="hidden font-semibold sm:block">Umbra</span>}
        </button>
        <nav aria-label="Загрузка разделов" aria-busy="true" className="mt-5 space-y-1 text-muted-foreground">
          {[[LayoutGrid, "Профили"], [Globe2, "Прокси"], [Users, "Команда"], [Folder, "Папки"], [Monitor, "Приложение"]].map(([Icon, label]) => {
            const ItemIcon = Icon as typeof LayoutGrid;
            return <div key={String(label)} className="flex h-10 items-center gap-3 px-2"><ItemIcon className="size-5 shrink-0" />{!collapsed && <span className="hidden sm:block">{String(label)}</span>}</div>;
          })}
        </nav>
      </aside>
      <main className="m-2 ml-0 min-w-0 flex-1 rounded-2xl border border-border bg-background p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Профили</h1>
        <p role="status" className="mt-4 text-sm text-muted-foreground">Проверяем сессию и права доступа…</p>
      </main>
    </div>
  );
}
