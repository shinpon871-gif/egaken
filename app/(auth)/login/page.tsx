'use client';

import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { performPasswordReset, printDiagnosticChecklist } from '@/lib/passwordReset';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  User,
} from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';

// --- アプリ内ブラウザ検出ユーティリティ ---
function isInAppBrowser() {
  if (typeof navigator === "undefined") return false;
  return /Twitter|Line|FBAN|FBAV|Instagram/.test(navigator.userAgent);
}

export default function LoginPage() {
  const router = useRouter();
  // Hooksは必ずコンポーネントの最上部で宣言
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [googleErrorMsg, setGoogleErrorMsg] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [emailErrorMsg, setEmailErrorMsg] = useState('');
  const [showExternalMessage, setShowExternalMessage] = useState(false);

  // --- auth初期化 ---
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // --- ログイン済みなら /home へ遷移 ---
  useEffect(() => {
    if (!loading && user) {
      router.replace('/home');
    }
  }, [user, loading, router]);

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

  // --- パスワードリセット ---
  const handlePasswordReset = async () => {
    setEmailErrorMsg('');

    if (!email.trim()) {
      setEmailErrorMsg('メールアドレスを入力してください');
      return;
    }

    // 診断ログ出力（開発時用）
    console.log('[🔐 PASSWORD RESET] Initiating diagnostic reset...');
    console.log('[🔐 PASSWORD RESET] email input:', email);
    console.log('[🔐 PASSWORD RESET] auth initialized:', !!auth);

    try {
      // continueUrl を動的に生成（現在のドメイン）
      const continueUrl = typeof window !== 'undefined' 
        ? `${window.location.origin}/login`
        : undefined;
      
      console.log('[🔐 PASSWORD RESET] continueUrl:', continueUrl);

      // performPasswordReset は詳細なログを出力しながら実行
      const result = await performPasswordReset(auth, email, continueUrl);

      // ユーザー向けメッセージを表示
      if (result.success) {
        setEmailErrorMsg(result.userMessage);
      } else {
        setEmailErrorMsg(result.userMessage);
      }

      // 内部ログ（開発者用）
      console.log('[🔐 PASSWORD RESET] Result:', {
        success: result.success,
        errorCode: result.errorCode,
        internalMessage: result.internalMessage,
      });
    } catch (err: unknown) {
      console.error('[🔐 PASSWORD RESET] Unexpected error:', err);
      setEmailErrorMsg('予期しないエラーが発生しました');
    }
  };

  // ❌ 真ん中の useEffect 完全削除

  // --- Googleログイン ---
  // isInAppBrowserの再定義は削除
  const handleGoogleLogin = async () => {
    if (!auth) return;

    const provider = new GoogleAuthProvider();

    if (isInAppBrowser()) {
      setShowExternalMessage(true);
      return;
    }

    setIsSigningIn(true);
    setGoogleErrorMsg('');

    try {
      // Safari対応: popupは必ずボタン直後に同期で呼ぶ
      await signInWithPopup(auth, provider);
      // setPersistenceはlib/firebase.tsで一度だけ実行
    } catch (err: unknown) {
      const error = err as { message?: string };
      setGoogleErrorMsg(error.message || 'Googleログインに失敗しました');
    } finally {
      setIsSigningIn(false);
    }
  };

  // --- メールログイン ---
  const handleEmailSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setEmailErrorMsg('');
    setIsSigningIn(true);

    // 前後の全角/半角スペース除去・不可視文字除去
    const normalize = (str: string) => str.replace(/[\s\u3000]+/g, '');
    const cleanedEmail = normalize(email);
    const cleanedPassword = normalize(password);

    // メール形式チェック
    const emailRegex = /^[\w!#$%&'*+/=?`{|}~^.-]+@[\w.-]+\.[a-zA-Z]{2,}$/;
    if (!cleanedEmail || !cleanedPassword) {
      setEmailErrorMsg('メールアドレスとパスワードを入力してください。');
      setIsSigningIn(false);
      return;
    }
    if (!emailRegex.test(cleanedEmail)) {
      setEmailErrorMsg('メールアドレスの形式が正しくありません。');
      setIsSigningIn(false);
      return;
    }

    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, cleanedEmail, cleanedPassword);
      } else {
        await signInWithEmailAndPassword(auth, cleanedEmail, cleanedPassword);
      }
      router.replace('/home');
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      switch (error.code) {
        case 'auth/invalid-email':
          setEmailErrorMsg('メールアドレスの形式が正しくありません。');
          break;
        case 'auth/user-not-found':
          setEmailErrorMsg('メールアドレスが見つかりません。新規登録してください。');
          break;
        case 'auth/wrong-password':
          setEmailErrorMsg('パスワードが正しくありません。');
          break;
        case 'auth/email-already-in-use':
          setEmailErrorMsg('このメールアドレスは既に登録されています。ログインしてください。');
          break;
        case 'auth/too-many-requests':
          setEmailErrorMsg('ログイン試行が多すぎます。しばらく待ってから再度お試しください。');
          break;
        case 'auth/operation-not-allowed':
          setEmailErrorMsg('この認証方法は現在利用できません。管理者にお問い合わせください。');
          break;
        case 'auth/internal-error':
          setEmailErrorMsg('サーバーエラーが発生しました。時間をおいて再度お試しください。');
          break;
        case 'auth/invalid-credential':
          setEmailErrorMsg('ログインできません。再度お試しください。');
          break;
        default:
          setEmailErrorMsg(error.message || 'エラーが発生しました');
          break;
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  // ❌ 下側の if(loading) return 完全削除

  // ❌ 一番下の useEffect 完全削除

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#FFF9F0] to-[#FFE8D6] px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg">
        {/* タイトル・サブコピー */}
        <h1 className="text-2xl font-bold text-center mb-2">
          {isRegister ? 'はじめまして。' : 'おかえりなさい。'}
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          {isRegister ? 'あなたの毎日を、記録しよう。' : '今日も描きましょう。'}
        </p>
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
        {showExternalMessage && (
          <div className="w-full rounded-md bg-yellow-100 text-yellow-800 px-3 py-2 text-sm mb-2 text-center">
            Googleログインはアプリ内ブラウザではご利用いただけません。<br />
            SafariやChromeなど外部ブラウザで再度お試しください。
          </div>
        )}
        {/* Safariで開くボタン・外部ブラウザ遷移UIは完全削除 */}

        <div className="my-6 border-t border-gray-200" />

        <form onSubmit={handleEmailSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="email"
            placeholder="メールアドレス"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="パスワード"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
            autoComplete="current-password"
          />
          {emailErrorMsg && (
            <div className="w-full rounded-md bg-red-100 text-red-700 px-3 py-2 text-sm mb-2 text-center">
              {emailErrorMsg}
            </div>
          )}
          <button
            type="submit"
            disabled={isSigningIn}
            className={`w-full rounded-md px-3 py-2 font-semibold ${isRegister ? 'bg-purple-500 text-white' : 'bg-blue-500 text-white'}`}
          >
            {isRegister
              ? "えがけんを始める"
              : isSigningIn
                ? "ログイン中..."
                : "ログインして続ける"}
          </button>
          <button
            type="button"
            onClick={() => setIsRegister(!isRegister)}
            style={{ marginTop: 8 }}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
          >
            {isRegister ? "ログイン画面へ" : "新規登録へ"}
          </button>
            <button
              type="button"
              onClick={handlePasswordReset}
              style={{ marginTop: 8 }}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
            >
              パスワードを忘れた場合
            </button>
            
            {/* Gmail特有ガイド */}
            <div className="mt-4 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
              <p className="font-semibold mb-1">📧 Gmail をお使いの方へ</p>
              <p className="mb-2">
                パスワードリセットメールが届かない場合、以下をご確認ください：
              </p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>迷惑メール フォルダを確認</li>
                <li>Gmail 設定 → セキュリティレベルを「標準」に変更</li>
                <li>noreply@firebase.com をメール連絡先に追加</li>
              </ul>
            </div>
        </form>

        <p className="mt-6 text-xs text-gray-500 text-center">
          Googleまたはメールアドレスでログインして、<br />
          毎日のお絵描きを記録しましょう
        </p>
      </div>
    </div>
  );
}