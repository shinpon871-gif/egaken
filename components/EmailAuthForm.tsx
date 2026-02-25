import { useState } from "react";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { useRouter } from 'next/navigation'; // 画面遷移用（修正理由：認証後に遷移させるため）

const EmailAuthForm = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [errorMsg, setErrorMsg] = useState(""); // エラー表示用（修正理由：alert廃止・画面内表示）
  const auth = getAuth();
  const router = useRouter(); // 画面遷移用（修正理由：認証後に遷移させるため）

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErrorMsg("");
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
        // 新規登録後も自動ログインされるため、/homeへ遷移（影響範囲：認証後の遷移のみ）
        router.push('/home');
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        // ログイン成功時に/homeへ遷移（修正理由：認証後の画面遷移保証）
        router.push('/home');
      }
    } catch (err: any) {
      console.error(err);
      // Firebaseエラーコードごとに日本語で分かりやすく表示（影響範囲：UIのみ）
      if (err.code === "auth/invalid-credential" || err.code === "auth/user-not-found") {
        setErrorMsg("メールアドレスまたはパスワードが正しくありません。");
      } else if (err.code === "auth/wrong-password") {
        setErrorMsg("パスワードが間違っています。");
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
      {/* エラー表示（モバイルでも見やすいUI、修正理由：alert廃止） */}
      {errorMsg && (
        <div className="w-full rounded-md bg-red-100 text-red-700 px-3 py-2 text-sm mb-2 text-center">
          {errorMsg}
        </div>
      )}
      <button
        type="submit"
        onClick={handleSubmit}
        onTouchStart={handleSubmit} // スマホタップ対応（修正理由：モバイルで無反応回避）
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
