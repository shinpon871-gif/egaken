import { collection, getDocs, query, where, Timestamp } from "firebase/firestore";
import { db } from "./firebase";

export async function getCurrentWeeklyTheme() {
  try {
    const now = Timestamp.now();
    const q = query(
      collection(db, "weeklyThemes"),
      where("startAt", "<=", now),
      where("endAt", ">=", now)
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (e) {
    return null;
  }
}
