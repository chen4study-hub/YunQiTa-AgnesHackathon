import { createContext, useContext, useSyncExternalStore, useMemo } from "react";
import {phasedSubscription} from './phasedSubscription';
import type { DashboardStore } from "./store";

export const StoreContext = createContext<DashboardStore | null>(null);
export function useDashboard(frames=0) {
  const store = useContext(StoreContext);
  if (!store) throw new Error("Dashboard store is missing");
  const phased=useMemo(()=>frames?phasedSubscription(store,frames):null,[store,frames]);
  const state = useSyncExternalStore(phased?.subscribe??store.subscribe, phased?.getSnapshot??store.getSnapshot);
  return { state, store };
}
