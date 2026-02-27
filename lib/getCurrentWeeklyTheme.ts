import { collection, getDocs, query, where, Timestamp } from "firebase/firestore";
import { db } from "./firebase";

export async function getCurrentWeeklyTheme() {
  try {
    const snap = await getDocs(collection(db, "weeklyThemes"));
    if (snap.empty) return null;

    const now = new Date();

    for (const doc of snap.docs) {
      const data = doc.data();
      const start = data.startAt?.toDate();
      const end = data.endAt?.toDate();

      if (start && end && start <= now && now <= end) {
        return { id: doc.id, ...data };
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}
