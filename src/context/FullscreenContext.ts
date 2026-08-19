import { createContext } from 'react';

/**
 * Fullscreen mode for data-entry pages: when on, the Layout hides the sidebar
 * and tightens padding so the page gets the whole window width. Only the
 * challan entry page uses this (it switches itself off when the page unmounts,
 * so every other page always shows the normal sidebar).
 */
export const FullscreenContext = createContext<{ fs: boolean; setFs: (v: boolean) => void }>({
  fs: false,
  setFs: () => {},
});
