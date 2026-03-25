import { collection, getDocs } from "firebase/firestore";
import { db } from "./firebase";

export async function getCurrentWeeklyTheme() {
  try {
    const snap = await getDocs(collection(db, "weeklyThemes"));
    if (snap.empty) return null;

    const now = new Date();
    console.log('[getCurrentWeeklyTheme] 現在時刻:', now, '(ISO:', now.toISOString(), ')');

    for (const doc of snap.docs) {
      const data = doc.data();
      const start = data.startAt?.toDate();
      const end = data.endAt?.toDate();

      console.log('[getCurrentWeeklyTheme] ドキュメント:', doc.id);
      console.log('  開始:', start?.toISOString());
      console.log('  終了:', end?.toISOString());
      console.log('  判定:', start && end ? `${start <= now} && ${now <= end}` : 'タイムスタンプなし');

      if (start && end && start <= now && now <= end) {
        console.log('[getCurrentWeeklyTheme] マッチ: ', doc.id);
        return { id: doc.id, ...data };
      }
    }

    console.log('[getCurrentWeeklyTheme] マッチなし');
    return null;
  } catch (e) {
    console.error('[getCurrentWeeklyTheme] エラー:', e);
    return null;
  }
}
