'use client';

import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return; // loading中は何もしない
    if (!user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  const handleLogout = async () => {
    try {
      if (auth) {
        await signOut(auth);
      }
      router.push('/login');
    } catch (error) {
      console.error('ログアウトエラー:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p>読み込み中...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto max-w-2xl px-4 py-4">
          <div className="flex items-center justify-between">
            <Link href="/home" className="flex items-center gap-2 hover:opacity-80 transition">
              <span className="text-2xl">🎨</span>
              <h1 className="text-2xl font-bold text-gray-800">えがけん</h1>
            </Link>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{user.displayName}</span>
              <button
                onClick={handleLogout}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600"
              >
                ログアウト
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-2xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
