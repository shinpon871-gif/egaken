import { Timestamp, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';

/**
 * Firestoreのタイムスタンプを日本語形式の日時文字列に変換
 */
export function formatTimestamp(timestamp: Timestamp | null): string {
  if (!timestamp) return '';
  
  const date = timestamp.toDate();
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * ユーザーの通算日数を計算（日本時間）
 * 初回投稿日からの経過日数を返す（1日目、2日目...）
 * @param userId - ユーザーID
 * @returns 通算日数、またはエラー時は0
 */
export async function calculateTrainingDays(userId: string): Promise<number> {
  try {
    const postsRef = collection(db, 'posts');
    const q = query(postsRef, where('userId', '==', userId));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return 0;
    }

    // すべての投稿から最も古い createdAt を探す
    let firstCreatedAt: Date | null = null;

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.createdAt) {
        const createdDate = data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt);
        if (!firstCreatedAt || createdDate < firstCreatedAt) {
          firstCreatedAt = createdDate;
        }
      }
    });

    if (!firstCreatedAt) {
      return 0;
    }

    // 日本時間で現在の日付と最初の投稿日の差分を計算
    const tokyoFormatter = new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Tokyo',
    });

    const nowTokyoStr = tokyoFormatter.format(new Date());
    const [nowYear, nowMonth, nowDay] = nowTokyoStr.split('/').map(Number);
    const nowTokyoDate = new Date(nowYear, nowMonth - 1, nowDay);

    const firstTokyoStr = tokyoFormatter.format(firstCreatedAt);
    const [firstYear, firstMonth, firstDay] = firstTokyoStr.split('/').map(Number);
    const firstTokyoDate = new Date(firstYear, firstMonth - 1, firstDay);

    const diffMs = nowTokyoDate.getTime() - firstTokyoDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    // 1日目以上を返す
    return Math.max(1, diffDays + 1);
  } catch (error) {
    console.error('calculateTrainingDays error:', error);
    return 0;
  }
}

/**
 * タイムスタンプを「2日前」のような相対時間表現に変換
 */
export function formatRelativeTime(timestamp: Timestamp | null): string {
  if (!timestamp) return '';

  const date = timestamp.toDate();
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return '今';
  if (diffMins < 60) return `${diffMins}分前`;
  if (diffHours < 24) return `${diffHours}時間前`;
  if (diffDays < 30) return `${diffDays}日前`;

  return formatTimestamp(timestamp);
}

/**
 * ファイルサイズをMB/KB表記に変換
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
