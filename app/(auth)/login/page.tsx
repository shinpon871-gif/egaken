'use client';

import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const EmailAuthForm = dynamic(() => import('@/components/EmailAuthForm'), { ssr: false });
export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [googleErrorMsg, setGoogleErrorMsg] = useState(""); // Googleログイン用エラー（修正理由：alert廃止・画面内表示）

  // 既にログインしている場合やGoogleリダイレクト後は必ずホーム画面へ遷移（修正理由：認証状態反映の保証、影響範囲：ログイン画面のみ）
  useEffect(() => {
    if (!loading && user) {
      // 認証状態が変化したら必ず/homeへ遷移
      router.replace('/home');
    }
  }, [user, loading]); // router依存を外し、状態変化時のみ発火

  // Firebase AuthのauthDomainがカスタムドメインか確認してください。
  // デフォルトの[PROJECT_ID].firebaseapp.comのままだとSafariでITPの影響を受けやすくなります。
  // process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN をご確認ください。
  //
  // Firebase Console → Authentication → 設定
  // Authorized domains に以下を含める：
  // localhost
  // egaken.vercel.app

  const handleGoogleLogin = async () => {
    setIsSigningIn(true);
    setGoogleErrorMsg("");
    try {
      const provider = new GoogleAuthProvider();
      if (!auth) {
        throw new Error('Firebase Auth instance is not initialized.');
      }
      // 永続性を明示的に設定（ITP対策・セッション維持）
      await setPersistence(auth, browserLocalPersistence);

      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      if (isMobile) {
        await signInWithRedirect(auth, provider);
      } else {
        const result = await signInWithPopup(auth, provider);
        if (result.user) {
          router.push('/home');
        }
      }
    } catch (error: any) {
      // SafariのポップアップブロックやITPによるエラーもここで捕捉
      console.error('ログインエラー:', error);
      // エラー内容を日本語で画面内表示（影響範囲：UIのみ）
      if (error.code === "auth/popup-blocked") {
        setGoogleErrorMsg("ポップアップがブロックされました。ブラウザの設定をご確認ください。");
      } else if (error.code === "auth/network-request-failed") {
        setGoogleErrorMsg("ネットワークエラーが発生しました。通信環境をご確認ください。");
      } else if (error.code === "auth/cancelled-popup-request") {
        setGoogleErrorMsg("ログイン処理がキャンセルされました。再度お試しください。");
      } else {
        setGoogleErrorMsg(error?.message || "ログインに失敗しました");
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#FFF9F0] to-[#FFE8D6]">
        <div className="text-center">
          <div className="mb-4 text-4xl">🎨</div>
          <p className="text-gray-600">読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#FFF9F0] to-[#FFE8D6] px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg">
        <div className="text-center">
          <div className="mb-4 text-6xl">🎨</div>
          <h1 className="mb-2 text-3xl font-bold text-gray-800">えがけん</h1>
          <p className="mb-8 text-gray-600">お絵描きの記録を残そう</p>
        </div>
        {/* Googleログインエラー表示（モバイルでも見やすいUI、修正理由：alert廃止） */}
        {googleErrorMsg && (
          <div className="w-full rounded-md bg-red-100 text-red-700 px-3 py-2 text-sm mb-2 text-center">
            {googleErrorMsg}
          </div>
        )}
        <button
          onClick={handleGoogleLogin}
          onTouchStart={handleGoogleLogin} // スマホタップ対応（修正理由：モバイルで無反応回避）
          disabled={isSigningIn}
          className="flex w-full items-center justify-center gap-3 rounded-lg bg-white px-6 py-3 font-semibold text-gray-800 transition-all hover:bg-gray-50 disabled:opacity-50 border border-gray-300 shadow-sm mb-6"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path fill='#4285F4' d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'/>
            <path fill='#34A853' d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'/>
            <path fill='#FBBC05' d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'/>
            <path fill='#EA4335' d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'/>
          </svg>
          {isSigningIn ? 'ログイン中...' : 'Googleでログイン'}
        </button>
        <div className="my-6 border-t border-gray-200" />
        <EmailAuthForm />
        <p className="mt-6 text-xs text-gray-500 text-center">
          Googleまたはメールアドレスでログインして、<br />
          毎日のお絵描きを記録しましょう
        </p>
      </div>
    </div>
  );
}
