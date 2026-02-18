'use client';

import { createContext, useContext, ReactNode, useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { User, onAuthStateChanged } from 'firebase/auth';

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
  const [isClient, setIsClient] = useState(false);
  const [user, setUser] = useState<User | null | undefined>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setIsClient(true);

    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(
      auth,
      (u) => {
        setUser(u);
        setLoading(false);
      },
      (e) => {
        console.error('onAuthStateChanged error:', e);
        setError(e as Error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  // クライアントサイドで初期化されるまで何も表示しない、またはローディング状態を表示
  if (!isClient) {
    return <AuthContext.Provider value={{ user: null, loading: true, error: undefined }}>{children}</AuthContext.Provider>;
  }

  return (
    <AuthContext.Provider value={{ user, loading, error }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
