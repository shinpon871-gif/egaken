'use client';

import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, setPersistence, browserLocalPersistence } from 'firebase/auth';
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
  const [googleErrorMsg, setGoogleErrorMsg] = useState("");

  // ログイン済みの場合は/homeへ遷移
  useEffect(() => {
    if (!loading && user) {
      router.replace('/home');
    }
  }, [user, loading]);

  // iOS/Safariリダイレクト後のGoogleログイン状態を確認
  useEffect(() => {
    const checkRedirect = async () => {
      try {
        const result = await getRedirectResult(auth);
        if (result?.user) {
          router.replace('/home');
        }
      } catch (err: any) {
        setGoogleErrorMsg(err?.message || "Googleログインに失敗しました");
      }
    };
    checkRedirect();
  }, []);

  // Googleログインのリダイレクト処理は廃止（修正理由：iOS Safari含めsignInWithPopupに統一、影響範囲：認証フローのみ）

  const handleGoogleLogin = async () => {
    setIsSigningIn(true);
    setGoogleErrorMsg("");
    try {
      const provider = new GoogleAuthProvider();
      await setPersistence(auth, browserLocalPersistence);
      // iOS/SafariはsignInWithRedirect, それ以外はsignInWithPopup
      const isIOS = /iP(ad|hone|od)/.test(navigator.userAgent);
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      if (isIOS || isSafari) {
        await signInWithRedirect(auth, provider);
      } else {
        const result = await signInWithPopup(auth, provider);
        if (result.user) {
          router.replace('/home');
        }
      }
    } catch (error: any) {
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

        {googleErrorMsg && (
          <div className="w-full rounded-md bg-red-100 text-red-700 px-3 py-2 text-sm mb-2 text-center">
            {googleErrorMsg}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={isSigningIn}
          className="flex w-full items-center justify-center gap-3 rounded-lg bg-white px-6 py-3 font-semibold text-gray-800 transition-all hover:bg-gray-50 disabled:opacity-50 border border-gray-300 shadow-sm mb-6"
        >
          {/* 公式GoogleアイコンSVG */}
          <svg className="h-5 w-5" viewBox="0 0 48 48">
            <g>
              <path fill="#4285F4" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3-4.1 5-7.3 5-4.4 0-8-3.6-8-8s3.6-8 8-8c1.7 0 3.2.5 4.5 1.4l6.1-6.1C36.2 9.5 32.4 8 28 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c7.7 0 15-5.6 15-16 0-1.1-.1-2.1-.4-3.5z"/>
              <path fill="#34A853" d="M6.3 14.7l6.6 4.8C14.5 16.1 20.7 12 28 12c3.1 0 6 .8 8.4 2.3l6.3-6.3C38.5 4.5 33.6 2 28 2 18.7 2 10.4 7.6 6.3 14.7z"/>
              <path fill="#FBBC05" d="M28 46c5.4 0 10.3-1.8 14.1-4.9l-6.5-5.3C32.9 37.7 30.6 38 28 38c-7.2 0-13.4-4.1-15.7-10.1l-6.6 5.1C10.4 40.4 18.7 46 28 46z"/>
              <path fill="#EA4335" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3-4.1 5-7.3 5-4.4 0-8-3.6-8-8s3.6-8 8-8c1.7 0 3.2.5 4.5 1.4l6.1-6.1C36.2 9.5 32.4 8 28 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c7.7 0 15-5.6 15-16 0-1.1-.1-2.1-.4-3.5z"/>
            </g>
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