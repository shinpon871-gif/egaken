'use client';

import { createContext, useContext, ReactNode, useEffect, useState } from 'react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '@/lib/firebase';
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
  const [isClient, setIsClient] = useState(false);
  const [user, loading, error] = useAuthState(auth || undefined);

  useEffect(() => {
    setIsClient(true);
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
