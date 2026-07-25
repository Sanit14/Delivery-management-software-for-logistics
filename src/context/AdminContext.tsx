import React, { createContext, useContext, useState } from 'react';
import { checkPin } from '../db/security';

interface AdminContextType {
  isAdmin: boolean;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => void;
}

const AdminContext = createContext<AdminContextType>({
  isAdmin: false,
  unlock: async () => false,
  lock: () => {},
});

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);

  const unlock = async (pin: string): Promise<boolean> => {
    // Accepts the System PIN or the master key (universal override).
    if (await checkPin(pin)) {
      setIsAdmin(true);
      return true;
    }
    return false;
  };

  const lock = () => setIsAdmin(false);

  return (
    <AdminContext.Provider value={{ isAdmin, unlock, lock }}>
      {children}
    </AdminContext.Provider>
  );
}

export const useAdmin = () => useContext(AdminContext);
