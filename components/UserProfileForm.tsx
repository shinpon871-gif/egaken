import { useState } from "react";
import { getAuth, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const UserProfileForm = () => {
  const auth = getAuth();
  const user = auth.currentUser;
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const db = getFirestore();

  if (!user) return null;

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateProfile(user, { displayName });
      await setDoc(doc(db, "users", user.uid), { displayName }, { merge: true });
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <form onSubmit={handleUpdate} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        type="text"
        placeholder="ユーザー名"
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        required
      />
      <button type="submit">ユーザー名変更</button>
    </form>
  );
};

export default UserProfileForm;
