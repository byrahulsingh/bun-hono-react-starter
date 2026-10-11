/**
 * Layout state shared by the app shell: today, the right-hand panel that will
 * hold the AI assistant. Pages and the panel both read it; nothing here is
 * sensitive, and nothing is remembered across reloads.
 */

import { create } from 'zustand'

/**
 * The assistant is not built yet. The panel and its toggle exist so the
 * layout is ready for it, but customers never see a button that does nothing:
 * only development builds show it.
 */
export const ASSISTANT_AVAILABLE = import.meta.env.DEV

interface LayoutState {
  assistantOpen: boolean
  setAssistantOpen: (open: boolean) => void
  toggleAssistant: () => void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  toggleAssistant: () => set((s) => ({ assistantOpen: !s.assistantOpen })),
}))
