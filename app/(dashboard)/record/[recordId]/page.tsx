'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';

interface RecordPost {
  id: string;
  userId: string;
  imageUrl: string;
  comment?: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
}

export default function RecordDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const recordId = params?.recordId as string;

  const [post, setPost] = useState<RecordPost | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId || !user) return;

    const fetchPost = async () => {
      try {
        const docRef = doc(db, 'posts', recordId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
          setError('投稿が見つかりません');
          setIsLoading(false);
          return;
        }

        const data = docSnap.data() as Omit<RecordPost, 'id'>;

        // 権限チェック：自分の投稿のみ表示
        if (data.userId !== user.uid) {
          setError('この投稿を表示する権限がありません');
          setIsLoading(false);
          return;
        }

        setPost({
          id: docSnap.id,
          ...data,
        });
      } catch (err) {
        console.error('投稿取得エラー:', err);
        setError('投稿の取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPost();
  }, [recordId, user]);

  const formatDate = (timestamp: Timestamp | null) => {
    if (!timestamp) return '';
    const date = timestamp.toDate();
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
  };

  const getProxyImageUrl = (imageUrl: string) => {
    return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="rounded-lg bg-red-50 p-6 text-center">
        <p className="text-red-700 font-semibold">{error || '投稿が見つかりません'}</p>
        <button
          onClick={() => router.back()}
          className="mt-4 rounded-lg bg-red-500 px-6 py-2 text-white transition hover:bg-red-600"
        >
          戻る
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-800">投稿詳細</h1>
        <button
          onClick={() => router.back()}
          className="text-gray-500 transition hover:text-gray-700 text-2xl"
          title="戻る"
        >
          ✕
        </button>
      </div>

      {/* カードコンテナ */}
      <div className="rounded-lg bg-white shadow-md overflow-hidden">
        {/* 画像 */}
        <div className="relative w-full bg-gray-100" style={{ paddingBottom: '100%' }}>
          <img
            src={getProxyImageUrl(post.imageUrl)}
            alt={post.comment || 'drawing'}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              console.error('[RecordDetail] img onError 発火:', post.imageUrl);
            }}
            onLoad={() => {
              console.log('[RecordDetail] img 読み込み完了:', post.imageUrl);
            }}
          />
        </div>

        {/* 情報セクション */}
        <div className="p-6 space-y-4">
          {/* 日付 */}
          <div>
            <p className="text-sm text-gray-500">投稿日</p>
            <p className="text-lg font-semibold text-gray-800">
              {formatDate(post.createdAt)}
            </p>
          </div>

          {/* 練習時間 */}
          {post.minutes > 0 && (
            <div>
              <p className="text-sm text-gray-500">練習時間</p>
              <p className="text-lg font-semibold text-gray-800">
                ⏱️ {post.minutes}分
              </p>
            </div>
          )}

          {/* ユーザーコメント */}
          {post.comment && (
            <div>
              <p className="text-sm text-gray-500">コメント</p>
              <p className="text-gray-700 whitespace-pre-wrap">
                {post.comment}
              </p>
            </div>
          )}

          {/* AIコメント */}
          {post.aiComment && (
            <div className="rounded-lg bg-blue-50 p-4">
              <p className="text-sm text-blue-700 font-semibold mb-2">🤖 AIからのコメント</p>
              <p className="text-blue-900 whitespace-pre-wrap text-sm">
                {post.aiComment}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 戻るボタン */}
      <button
        onClick={() => router.push('/history')}
        className="w-full rounded-lg bg-cyan-500 px-6 py-3 font-semibold text-white transition hover:bg-cyan-600"
      >
        ← ヒストリーに戻る
      </button>
    </div>
  );
}
