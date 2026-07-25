/**
 * Connection store — the one field W7's offline banner + queued composer read.
 * Fed by `connectStores` from a facade exposing the optional ConnectionControl
 * capability (MockFacade.setConnected); facades without it stay `connected`.
 */
import { create } from 'zustand';

export interface ConnectionState {
  connected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  connected: true,
  setConnected: (connected) => set({ connected }),
}));

export const selectConnected = (s: ConnectionState): boolean => s.connected;
