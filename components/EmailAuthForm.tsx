import { useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from '@/lib/firebase'; // authインスタンスを統一（修正理由：認証不具合防止、影響範囲：認証処理のみ）
import { useRouter } from 'next/navigation';

const EmailAuthForm = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErrorMsg("");
    // authインスタンスの単一性を検証（修正理由：多重初期化・不具合防止、影響範囲：開発時ログのみ）
    console.log('[EmailAuthForm] auth.app.name:', auth.app.name);
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
        router.push('/home');
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        router.push('/home');
      }
    } catch (err: any) {
      console.error(err);
      // メールログイン用のエラー判定を限定（修正理由：ユーザー向け明確化、影響範囲：UIのみ）
      if (err.code === "auth/user-not-found" || err.code === "auth/wrong-password") {
        setErrorMsg("メールアドレスまたはパスワードが正しくありません。");
      } else if (err.code === "auth/invalid-email") {
        setErrorMsg("メールアドレスの形式が正しくありません。");
      } else {
        setErrorMsg(err.message || "エラーが発生しました");
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        type="email"
        placeholder="メールアドレス"
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
      />
      <input
        type="password"
        placeholder="パスワード"
        value={password}
        onChange={e => setPassword(e.target.value)}
        required
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
      />
      {errorMsg && (
        <div className="w-full rounded-md bg-red-100 text-red-700 px-3 py-2 text-sm mb-2 text-center">
          {errorMsg}
        </div>
      )}
      <button
        type="submit"
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
      >
        {isRegister ? "新規登録" : "メールログイン"}
      </button>
      <button
        type="button"
        onClick={() => setIsRegister(!isRegister)}
        style={{ marginTop: 8 }}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-black"
      >
        {isRegister ? "ログイン画面へ" : "新規登録へ"}
      </button>
    </form>
  );
};

export default EmailAuthForm;