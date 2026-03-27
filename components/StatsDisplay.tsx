'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { calculateStats, StatsData, Post } from '@/lib/stats';

export function StatsDisplay() {
  const { user } = useAuth();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setIsLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        const q = query(collection(db, 'posts'), where('userId', '==', user.uid));
        const snapshot = await getDocs(q);
        
        const posts: Post[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          posts.push({
            id: doc.id,
            userId: data.userId,
            imageUrl: data.imageUrl,
            comment: data.comment,
            minutes: data.minutes || 0,
            aiComment: data.aiComment,
            createdAt: data.createdAt || null,
          });
        });

        const statsData = calculateStats(posts);
        setStats(statsData);
      } catch (error) {
        console.error('統計情報取得エラー:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, [user]);

  if (isLoading || !stats) {
    return null;
  }

  return (
    <div className="rounded-lg bg-gradient-to-br from-orange-50 to-purple-50 p-6 shadow-md border border-orange-100">
      <h2 className="mb-4 text-lg font-bold text-gray-800">🚀 あなたの成長</h2>
      
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {/* ストリーク */}
        <div className="rounded-lg bg-white p-4 text-center shadow-sm">
          <p className="text-2xl font-bold text-orange-500">
            {stats.streak}日
          </p>
          <p className="text-xs text-gray-600 mt-1">🔥 継続中</p>
        </div>

        {/* 月間分数 */}
        <div className="rounded-lg bg-white p-4 text-center shadow-sm">
          <p className="text-2xl font-bold text-purple-500">
            {stats.monthlyMinutes}分
          </p>
          <p className="text-xs text-gray-600 mt-1">今月の練習時間</p>
        </div>

        {/* 累計投稿数 */}
        <div className="rounded-lg bg-white p-4 text-center shadow-sm">
          <p className="text-2xl font-bold text-blue-500">
            {stats.totalPostCount}
          </p>
          <p className="text-xs text-gray-600 mt-1">累計投稿数</p>
        </div>

        {/* バッジ */}
        <div className="rounded-lg bg-white p-4 text-center shadow-sm">
          <p className="text-2xl">
            {stats.badge.icon}
          </p>
          <p className="text-xs font-semibold text-gray-700 mt-1">
            {stats.badge.name}
          </p>
        </div>
      </div>
    </div>
  );
}
