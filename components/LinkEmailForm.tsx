import { useState } from "react";
import { getAuth, EmailAuthProvider, linkWithCredential } from "firebase/auth";

const LinkEmailForm = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const auth = getAuth();
  const user = auth.currentUser;

  if (!user || user.providerData.some(p => p.providerId === "password")) return null;

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const credential = EmailAuthProvider.credential(email, password);
      await linkWithCredential(user, credential);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <form onSubmit={handleLink} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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

export default LinkEmailForm;
