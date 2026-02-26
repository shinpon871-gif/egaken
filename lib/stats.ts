import { Timestamp } from 'firebase/firestore';
import { db } from './firebase';

/**
 * 投稿データの型
 */
export interface Post {
  id: string;
  userId: string;
  imageUrl: string;
  comment?: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
}

/**
 * ストリーク（連続投稿日数）を計算
 * @param posts - 投稿一覧（降順でソート済み想定）
 * @returns 現在のストリーク日数
 */
export function calculateStreak(posts: Post[]): number {
  if (posts.length === 0) return 0;

  // 投稿を新しい順でソート
  const sortedPosts = [...posts].sort((a, b) => {
    const timeA = a.createdAt instanceof Timestamp ? a.createdAt.toDate().getTime() : 0;
    const timeB = b.createdAt instanceof Timestamp ? b.createdAt.toDate().getTime() : 0;
    return timeB - timeA;
  });

  // 本日の日付を取得
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 最新投稿の日付を取得
  const latestPostDate = sortedPosts[0].createdAt instanceof Timestamp
    ? sortedPosts[0].createdAt.toDate()
    : new Date();
  latestPostDate.setHours(0, 0, 0, 0);

  // 最新投稿が本日か昨日でない場合、ストリークは0
  const daysDiff = Math.floor((today.getTime() - latestPostDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 1) return 0;

  // 日付ごとの投稿を集計
  const postsByDate = new Map<string, boolean>();
  sortedPosts.forEach((post) => {
    if (post.createdAt instanceof Timestamp) {
      const date = post.createdAt.toDate();
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      postsByDate.set(dateKey, true);
    }
  });

  // 連続投稿日数をカウント
  let streak = 0;
  let currentDate = new Date(latestPostDate);

  while (true) {
    const dateKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
    if (postsByDate.has(dateKey)) {
      streak++;
      currentDate.setDate(currentDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

/**
 * 当月の総練習時間を計算
 * @param posts - 投稿一覧
 * @returns 当月の練習時間（分）
 */
export function calculateMonthlyMinutes(posts: Post[]): number {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  return posts.reduce((total, post) => {
    if (post.createdAt instanceof Timestamp) {
      const postDate = post.createdAt.toDate();
      if (postDate.getFullYear() === currentYear && postDate.getMonth() === currentMonth) {
        return total + (post.minutes || 0);
      }
    }
    return total;
  }, 0);
}

/**
 * 累計投稿数を取得
 * @param posts - 投稿一覧
 * @returns 投稿数
 */
export function getTotalPostCount(posts: Post[]): number {
  return posts.length;
}

/**
 * バッジを取得
 * @param postCount - 投稿数
 * @returns バッジ情報 { name: string; icon: string; description: string }
 */
export interface Badge {
  name: string;
  icon: string;
  description: string;
}

export function getBadge(postCount: number): Badge {
  if (postCount >= 100) {
    return {
      name: '描き続ける人',
      icon: '🏆',
      description: '100投稿達成！',
    };
  }
  if (postCount >= 50) {
    return {
      name: '継続者',
      icon: '⭐',
      description: '50投稿達成！',
    };
  }
  if (postCount >= 10) {
    return {
      name: '習慣の芽',
      icon: '🌱',
      description: '10投稿達成！',
    };
  }
  if (postCount >= 1) {
    return {
      name: 'はじめの一歩',
      icon: '👣',
      description: '最初の一投稿！',
    };
  }
  return {
    name: 'これからスタート',
    icon: '🎨',
    description: '最初の投稿を待っています',
  };
}

/**
 * 全ての統計情報を一度に取得
 */
export interface StatsData {
  streak: number;
  monthlyMinutes: number;
  totalPostCount: number;
  badge: Badge;
}

export function calculateStats(posts: Post[]): StatsData {
  return {
    streak: calculateStreak(posts),
    monthlyMinutes: calculateMonthlyMinutes(posts),
    totalPostCount: getTotalPostCount(posts),
    badge: getBadge(getTotalPostCount(posts)),
  };
}
