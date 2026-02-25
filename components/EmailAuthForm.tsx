import { useState } from "react";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";

const EmailAuthForm = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const auth = getAuth();

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || "エラーが発生しました");
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
