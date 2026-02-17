'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getGrowthData, GrowthData } from '@/lib/growth';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

export default function GrowthPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [growthData, setGrowthData] = useState<GrowthData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // ユーザーが未認証の場合はリダイレクト
    if (!loading && !user) {
      router.push('/auth/login');
      return;
    }

    if (!user) return;

    const fetchGrowthData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        console.log('ユーザーID:', user.uid);
        const data = await getGrowthData(user.uid);
        if (data) {
          console.log('成長データ取得成功:', data);
          setGrowthData(data);
        } else {
          console.log('成長データが null');
          setError('比較できるデータがまだ足りません。2つ以上の投稿が必要です。');
        }
      } catch (err) {
        console.error('成長データ取得エラー:', err);
        const errorMsg = (err as any)?.message || '不明なエラー';
        setError(`データ取得に失敗しました。${errorMsg}`);
      } finally {
        setIsLoading(false);
      }
    };

    fetchGrowthData();
  }, [user, loading, router]);

  if (loading || isLoading) {
    return (
      <div className="flex justify-center py-12">
        <p className="text-gray-600">読み込み中...</p>
      </div>
    );
  }

  if (error || !growthData) {
    return (
      <div className="rounded-lg bg-white p-8 shadow-md text-center">
        <div className="mb-4 text-5xl">📊</div>
        <h2 className="mb-2 text-2xl font-bold text-gray-800">成長の記録</h2>
        <p className="text-gray-600 mb-6">
          {error || 'まだ比較できる記録がありません'}
        </p>
        <p className="text-sm text-gray-500 mb-6">
          初回投稿から2回目の投稿をすると、成長を確認できるようになります。
        </p>
        <button
          onClick={() => router.push('/home')}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600"
        >
          <span>←</span>
          ホームに戻る
        </button>
      </div>
    );
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  return (
    <div className="space-y-6 py-4">
      {/* ページタイトル */}
      <div className="rounded-lg bg-white p-6 shadow-md">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">成長の記録</h1>
        <p className="text-gray-600">
          初回投稿から今日までの、あなたの成長を見守ります。
        </p>
      </div>

      {/* 成長比較エリア */}
      <div className="rounded-lg bg-white p-6 shadow-md">
        {/* 画像の横並び表示 */}
        <div className="flex items-start gap-4 mb-6 flex-wrap sm:flex-nowrap">
          {/* 初回の画像 */}
          <div className="flex-1 min-w-[45%]">
            <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gray-100 border-2 border-blue-300">
              <Image
                src={growthData.firstImageUrl}
                alt="初回投稿"
                fill
                className="object-cover"
                sizes="(max-width: 640px) 45vw, (max-width: 1024px) 40vw, 300px"
              />
            </div>
            <p className="mt-2 text-center text-sm font-semibold text-gray-700">初回</p>
            <p className="text-center text-xs text-gray-500">
              {formatDate(growthData.firstDate)}
            </p>
          </div>

          {/* 矢印アイコン */}
          <div className="flex items-center justify-center py-4">
            <div className="text-3xl">→</div>
          </div>

          {/* 最新の画像 */}
          <div className="flex-1 min-w-[45%]">
            <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gray-100 border-2 border-green-300">
              <Image
                src={growthData.latestImageUrl}
                alt="最新投稿"
                fill
                className="object-cover"
                sizes="(max-width: 640px) 45vw, (max-width: 1024px) 40vw, 300px"
              />
            </div>
            <p className="mt-2 text-center text-sm font-semibold text-gray-700">最新</p>
            <p className="text-center text-xs text-gray-500">
              {formatDate(growthData.latestDate)}
            </p>
          </div>
        </div>

        {/* 成長情報テキスト */}
        <div className="space-y-3 rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 p-4">
          <div className="flex items-center justify-between">
            <span className="text-gray-600">初回投稿</span>
            <span className="font-semibold text-gray-800">{formatDate(growthData.firstDate)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-600">最新投稿</span>
            <span className="font-semibold text-gray-800">{formatDate(growthData.latestDate)}</span>
          </div>
          <div className="border-t border-blue-200 pt-3 flex items-center justify-between">
            <span className="text-gray-600 font-semibold">継続日数</span>
            <span className="text-2xl font-bold text-orange-500">{growthData.totalDays}日</span>
          </div>
        </div>

        {/* メッセージ */}
        <div className="mt-6 rounded-lg bg-orange-50 border border-orange-200 p-4 text-center">
          <p className="text-orange-800 font-semibold">
            🎉 {growthData.totalDays}日間の継続、お疲れ様です！
          </p>
          <p className="text-sm text-orange-700 mt-2">
            毎日練習を続けることで、確実に成長しています。
          </p>
        </div>
      </div>

      {/* アクション */}
      <div className="flex gap-3">
        <button
          onClick={() => router.push('/home')}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition hover:bg-gray-50"
        >
          ← ホームに戻る
        </button>
      </div>
    </div>
  );
}
