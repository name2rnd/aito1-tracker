"use client";

import { create } from "zustand";

// Peek sidebar: clicking an issue in a list/board opens it in an overlay Sheet
// instead of navigating away, so you can click through a batch without losing
// your place. `openId` is an issue id OR identifier (e.g. AIT-42) — IssueDetail
// resolves both.
interface IssuePeekState {
  openId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useIssuePeekStore = create<IssuePeekState>()((set) => ({
  openId: null,
  open: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}));
