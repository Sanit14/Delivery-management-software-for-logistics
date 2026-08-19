import { createContext } from 'react';

export const PageLockContext = createContext<{ relock: () => void }>({ relock: () => {} });
