"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuth, EmailAuthProvider, linkWithCredential, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { useState } from "react";

const LinkEmailForm = ({ user }: { user: any }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const credential = EmailAuthProvider.credential(email, password);
      await linkWithCredential(user, credential);
      await user.reload();
    } catch (err: any) {
      if (err.code === "auth/provider-already-linked") {
        await user.reload();
      } else {
        console.error(err);
      }
    }
  };
  return (
    <form onSubmit={handleLink} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
      <input
        type="email"
        placeholder="メールアドレス追加"
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="パスワード"
        value={password}
        onChange={e => setPassword(e.target.value)}
        required
      />
      <button type="submit">メール追加</button>
    </form>
  );
};

const UserProfileForm = ({ user }: { user: any }) => {
  const [displayName, setDisplayName] = useState(user.displayName || "");
  const db = getFirestore();
  const router = useRouter();
  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateProfile(user, { displayName });
      await setDoc(doc(db, "users", user.uid), { displayName }, { merge: true });
      router.push("/home");
    } catch (err) {
      console.error(err);
    }
  };
  return (
    <form onSubmit={handleUpdate} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
      <input
        type="text"
        placeholder="ユーザー名"
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        required
        style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc', fontSize: 16 }}
      />
      <button
        type="submit"
        style={{
          background: '#ff9800',
          color: '#fff',
          fontWeight: 'bold',
          border: 'none',
          borderRadius: 4,
          padding: '12px 0',
          fontSize: 18,
          cursor: 'pointer',
          transition: 'background 0.2s',
        }}
      >
        ユーザー名変更
      </button>
    </form>
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
    <div style={{ maxWidth: 400, margin: "40px auto", padding: 24, border: "1px solid #eee", borderRadius: 8 }}>
      <h2>アカウント設定</h2>
      <div style={{ marginTop: 16 }}>
        <div><b>ユーザー名:</b> {user.displayName || "(未設定)"}</div>
        <div><b>メール:</b> {user.email || "(未設定)"}</div>
        <div><b>プロバイダ:</b> {providers.join(", ")}</div>
      </div>
      <UserProfileForm user={user} />
      {!hasPasswordProvider && <LinkEmailForm user={user} />}
    </div>
  );
}
