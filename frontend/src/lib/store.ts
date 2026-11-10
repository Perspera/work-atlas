import { create } from "zustand";

import type { Me } from "./types";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "err" | "warn";
}

interface AppState {
  me: Me | null;
  date: string;
  online: boolean;
  lastUpdate: string;
  toasts: Toast[];
  setMe: (me: Me | null) => void;
  setDate: (date: string) => void;
  setOnline: (online: boolean) => void;
  touch: (time: string) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set) => ({
  me: null,
  date: "",
  online: true,
  lastUpdate: "",
  toasts: [],
  setMe: (me) => set({ me }),
  setDate: (date) => set({ date }),
  setOnline: (online) => set({ online }),
  touch: (time) => set({ lastUpdate: time }),
  toast: (text, kind = "ok") => {
    const id = ++toastSeq;
    set((state) => ({ toasts: [...state.toasts, { id, text, kind }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, 3200);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

/** 当前账号是否具备某权限（写法与原前端 has() 一致）。 */
export function hasPerm(me: Me | null, code: string): boolean {
  return Boolean(me?.permissions?.includes(code));
}
