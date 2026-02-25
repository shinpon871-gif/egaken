"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuth, EmailAuthProvider, linkWithCredential, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { useState } from "react";

const LinkEmailForm = ({ user }: { user: any }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [toast, setToast] = useState<string | null>(null); // 成功/失敗トースト用
  // 修正理由: ボタンUI明確化・モバイル対応・文言変更・トースト追加（影響範囲：UIのみ）
  const handleLink = async (e: React.FormEvent | React.MouseEvent | React.TouchEvent) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    try {
      const credential = EmailAuthProvider.credential(email, password);
      await linkWithCredential(user, credential);
      await user.reload();
      setToast("ログインメールアドレス追加に成功しました");
    } catch (err: any) {
      if (err.code === "auth/provider-already-linked") {
        await user.reload();
        setToast("すでにメールアドレスが追加されています");
      } else {
        setToast("メール追加に失敗しました: " + (err.message || "不明なエラー"));
        console.error(err);
      }
    }
    setTimeout(() => setToast(null), 3000);
  };
  return (
    <form style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
      <input
        type="email"
        placeholder="ログインメールアドレス追加"
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
        style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc', fontSize: 16 }}
      />
      <input
        type="password"
        placeholder="パスワード"
        value={password}
        onChange={e => setPassword(e.target.value)}
        required
        style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc', fontSize: 16 }}
      />
      <button
        type="button"
        style={{ background: '#2563eb', color: '#fff', borderRadius: 8, padding: '18px 0', fontWeight: 'bold', fontSize: 20, marginTop: 8, cursor: 'pointer', border: 'none' }}
        onClick={handleLink}
        onTouchStart={handleLink}
      >ログインメールアドレス追加</button>
      {toast && (
        <div style={{ background: '#333', color: '#fff', borderRadius: 6, padding: '8px', marginTop: 12, textAlign: 'center', fontSize: 16, fontWeight: 'bold', boxShadow: '0 2px 8px #0002' }}>
          {toast}
        </div>
      )}
    </form>
  );
};

const UserProfileForm = ({ user }: { user: any }) => {
  const [displayName, setDisplayName] = useState(user.displayName || "");
  const db = getFirestore();
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null); // 成功/失敗トースト用
  // 修正理由: ボタンUI明確化・モバイル対応・トースト追加（影響範囲：UIのみ）
  const handleUpdate = async (e: React.FormEvent | React.MouseEvent | React.TouchEvent) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    try {
      await updateProfile(user, { displayName });
      await setDoc(doc(db, "users", user.uid), { displayName }, { merge: true });
      setToast("ユーザー名変更に成功しました");
    } catch (err) {
      // 修正理由: TypeScript型エラー回避（errをany型にキャスト）
      const e = err as any;
      setToast("ユーザー名変更に失敗しました: " + (e?.message || "不明なエラー"));
      console.error(err);
    }
    setTimeout(() => setToast(null), 3000);
  };
  return (
    <form style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
      <input
        type="text"
        placeholder="ユーザー名"
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        required
        style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc', fontSize: 16 }}
      />
      <button
        type="button"
        style={{ background: '#10b981', color: '#fff', borderRadius: 8, padding: '18px 0', fontWeight: 'bold', fontSize: 20, marginTop: 8, cursor: 'pointer', border: 'none' }}
        onClick={handleUpdate}
        onTouchStart={handleUpdate}
      >ユーザー名変更</button>
      {toast && (
        <div style={{ background: '#333', color: '#fff', borderRadius: 6, padding: '8px', marginTop: 12, textAlign: 'center', fontSize: 16, fontWeight: 'bold', boxShadow: '0 2px 8px #0002' }}>
          {toast}
        </div>
      )}
    </form>
  );
};
// 戻るボタン
const BackButton = () => {
  const router = useRouter();
  return (
    <div className="flex gap-3 mt-8">
      <button
        onClick={() => router.push('/home')}
        className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition hover:bg-gray-50"
      >
        ← ホームに戻る
      </button>
    </div>
  );
};

export default function ProfilePage() {
  const auth = getAuth();
  const router = useRouter();
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(u => {
      if (!u) {
        router.replace("/login");
      } else {
        setUser(u);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [auth, router]);

  const hasPasswordProvider = user?.providerData?.some((p: any) => p.providerId === "password");

  if (loading) return null;
  if (!user) return null;

  const providers = user.providerData.map((p: any) => p.providerId);

  return (
    <div style={{ maxWidth: 400, margin: "40px auto", padding: 24, border: "1px solid #eee", borderRadius: 8, minHeight: '80vh', position: 'relative' }}>
      <h2>アカウント設定</h2>
      <div style={{ marginTop: 16 }}>
        <div><b>ユーザー名:</b> {user.displayName || "(未設定)"}</div>
        <div><b>メール:</b> {user.email || "(未設定)"}</div>
        <div><b>プロバイダ:</b> {providers.join(", ")}</div>
      </div>
      <UserProfileForm user={user} />
      {/* 表示条件を緩和。メールアドレス追加UIを常に表示（修正理由：state/権限分岐で非表示になる問題回避、影響範囲：UIのみ） */}
      <LinkEmailForm user={user} />
      <BackButton />
    </div>
  );
}
