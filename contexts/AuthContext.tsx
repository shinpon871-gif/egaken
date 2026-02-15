'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '@/lib/firebase'; // パスが正しいか確認
import { User } from 'firebase/auth';

interface AuthContextType {
  user: User | null | undefined;
  loading: boolean;
  error: Error | undefined;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  error: undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  // auth が null でないことを確認
  const [user, loading, error] = useAuthState(auth);

  return (
    <AuthContext.Provider value={{ user, loading, error }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
