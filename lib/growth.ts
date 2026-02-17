import { db } from './firebase';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
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
    // ユーザーの投稿をすべて取得（古い順）
    const firstQuerySnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId),
        orderBy('createdAt', 'asc')
      )
    );

    if (firstQuerySnapshot.size < 2) {
      return null; // 投稿が2件未満の場合はnull
    }

    // 初回投稿を取得
    const firstPost = firstQuerySnapshot.docs[0];
    const firstData = firstPost.data();

    // 最新投稿を取得
    const latestQuerySnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(1)
      )
    );

    const latestPost = latestQuerySnapshot.docs[0];
    const latestData = latestPost.data();

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

    return {
      firstImageUrl: firstData.imageUrl || '',
      latestImageUrl: latestData.imageUrl || '',
      firstDate,
      latestDate,
      totalDays,
    };
  } catch (error) {
    console.error('成長データ取得エラー:', error);
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
    const querySnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(1)
      )
    );

    if (querySnapshot.empty) {
      return null;
    }

    return querySnapshot.docs[0].data();
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
    const querySnapshot = await getDocs(
      query(
        collection(db, 'posts'),
        where('userId', '==', userId),
        orderBy('createdAt', 'asc'),
        limit(1)
      )
    );

    if (querySnapshot.empty) {
      return null;
    }

    return querySnapshot.docs[0].data();
  } catch (error) {
    console.error('初回投稿取得エラー:', error);
    return null;
  }
}
