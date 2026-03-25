import { db } from './firebase';
import {
  collection,
  query,
  where,
  getDocs,
  Timestamp,
} from 'firebase/firestore';

/**
 * 成長データの構造
 */
export interface GrowthData {
  firstImageUrl: string;
  latestImageUrl: string;
  firstDate: Date;
  latestDate: Date;
  totalDays: number;
}

/**
 * ユーザーの成長データを取得
 * 初回投稿と最新投稿の情報を返す
 * @param userId - ユーザーID
 * @returns 成長データ、またはnull（データが2件未満の場合）
 */
export async function getGrowthData(userId: string): Promise<GrowthData | null> {
  try {
    console.log('成長データ取得開始:', userId);
    
    // ユーザーの投稿をすべて取得（複合インデックスなしで実装）
    const postsSnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId)
      )
    );

    console.log('投稿数:', postsSnapshot.size);

    if (postsSnapshot.size < 2) {
      console.log('投稿数が2件未満です');
      return null; // 投稿が2件未満の場合はnull
    }

    // クライアント側でソート（複合インデックス不要）
    const posts = postsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        imageUrl: data.imageUrl || '',
        createdAt: data.createdAt,
      };
    });

    // createdAt でソート
    posts.sort((a, b) => {
      const timeA = (a.createdAt instanceof Timestamp) 
        ? a.createdAt.toDate().getTime()
        : new Date(a.createdAt).getTime();
      const timeB = (b.createdAt instanceof Timestamp)
        ? b.createdAt.toDate().getTime()
        : new Date(b.createdAt).getTime();
      return timeA - timeB;
    });

    const firstData = posts[0];
    console.log('初回投稿:', firstData);

    const latestData = posts[posts.length - 1];
    console.log('最新投稿:', latestData);

    // タイムスタンプをDateに変換
    const firstDate = firstData.createdAt instanceof Timestamp 
      ? firstData.createdAt.toDate()
      : new Date(firstData.createdAt);
    
    const latestDate = latestData.createdAt instanceof Timestamp
      ? latestData.createdAt.toDate()
      : new Date(latestData.createdAt);

    // 継続日数を計算（日付のみで時間は無視）
    const firstDateOnly = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
    const latestDateOnly = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate());
    const totalDays = Math.floor((latestDateOnly.getTime() - firstDateOnly.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    console.log('成長データ取得成功:', { totalDays });

    return {
      firstImageUrl: firstData.imageUrl || '',
      latestImageUrl: latestData.imageUrl || '',
      firstDate,
      latestDate,
      totalDays,
    };
  } catch (error) {
    console.error('成長データ取得エラー:', error);
    // Firestore インデックス エラーかどうかを確認
    const errorMessage = (error as unknown as Record<string, unknown>)?.message || '';
    if (String(errorMessage).includes('index')) {
      console.error('Firestore複合インデックスが必要です。Firebase コンソールでインデックスを作成してください。');
    }
    return null;
  }
}

/**
 * ユーザーの最新投稿を取得
 * @param userId - ユーザーID
 * @returns 最新投稿のデータ、またはnull
 */
export async function getLatestPost(userId: string) {
  try {
    const postsSnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId)
      )
    );

    if (postsSnapshot.empty) {
      return null;
    }

    // クライアント側でソート
    const posts = postsSnapshot.docs.map(doc => ({
      ...doc.data(),
    }));

    posts.sort((a, b) => {
      const timeA = (a.createdAt instanceof Timestamp)
        ? a.createdAt.toDate().getTime()
        : new Date(a.createdAt).getTime();
      const timeB = (b.createdAt instanceof Timestamp)
        ? b.createdAt.toDate().getTime()
        : new Date(b.createdAt).getTime();
      return timeB - timeA; // 降順
    });

    return posts[0];
  } catch (error) {
    console.error('最新投稿取得エラー:', error);
    return null;
  }
}

/**
 * ユーザーの初回投稿を取得
 * @param userId - ユーザーID
 * @returns 初回投稿のデータ、またはnull
 */
export async function getFirstPost(userId: string) {
  try {
    const postsSnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId)
      )
    );

    if (postsSnapshot.empty) {
      return null;
    }

    // クライアント側でソート
    const posts = postsSnapshot.docs.map(doc => ({
      ...doc.data(),
    }));

    posts.sort((a, b) => {
      const timeA = (a.createdAt instanceof Timestamp)
        ? a.createdAt.toDate().getTime()
        : new Date(a.createdAt).getTime();
      const timeB = (b.createdAt instanceof Timestamp)
        ? b.createdAt.toDate().getTime()
        : new Date(b.createdAt).getTime();
      return timeA - timeB; // 昇順
    });

    return posts[0];
  } catch (error) {
    console.error('初回投稿取得エラー:', error);
    return null;
  }
}
