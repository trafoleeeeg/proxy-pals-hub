import { arrayMove } from "@dnd-kit/sortable";

type OrderedProfile = { id: string; folder: string; sort_order: number };

// Preserve other folders' cache entries while moving a profile in its own folder.
export function reorderProfileRows<T extends OrderedProfile>(rows: T[], sourceId: string, targetId: string) {
  const source = rows.find((row) => row.id === sourceId);
  const target = rows.find((row) => row.id === targetId);
  if (!source || !target || sourceId === targetId || source.folder !== target.folder) return null;
  const folderRows = rows.filter((row) => row.folder === source.folder);
  const from = folderRows.findIndex((row) => row.id === sourceId);
  const to = folderRows.findIndex((row) => row.id === targetId);
  if (from < 0 || to < 0) return null;
  const ordered = arrayMove(folderRows, from, to).map((row, index) => ({ ...row, sort_order: index + 1 }));
  let next = 0;
  return {
    folder: source.folder,
    ids: ordered.map((row) => row.id),
    rows: rows.map((row) => row.folder === source.folder ? ordered[next++]! : row),
  };
}

