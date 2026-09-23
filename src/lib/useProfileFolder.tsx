import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export const MAIN_FOLDER = "Основная";

type FolderContext = { folder: string; setFolder: (value: string) => void };

const Context = createContext<FolderContext | null>(null);

export function ProfileFolderProvider({ children }: { children: ReactNode }) {
  const [folder, setFolder] = useState(MAIN_FOLDER);
  const value = useMemo(() => ({ folder, setFolder }), [folder]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProfileFolder() {
  const value = useContext(Context);
  if (!value) throw new Error("ProfileFolderProvider отсутствует");
  return value;
}
