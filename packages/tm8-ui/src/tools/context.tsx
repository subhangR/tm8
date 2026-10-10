import { createContext, useContext, type ReactNode } from 'react';

const LaunchContext = createContext<((id: string) => void) | undefined>(undefined);
export const useToolSessionOpen = () => useContext(LaunchContext);
export function ToolLaunchProvider({ open, children }: { open(id: string): void; children: ReactNode }) {
  return <LaunchContext.Provider value={open}>{children}</LaunchContext.Provider>;
}
