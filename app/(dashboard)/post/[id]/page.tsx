'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { useRouter, useParams } from 'next/navigation';
import Image from 'next/image';

interface PostData {
  id: string;
  userId: string;
  imageUrl: string;
  comment: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
}

export default function PostDetailPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const postId = params.id as string;

  const [post, setPost] = useState<PostData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/login');
      return;
    }

    if (!postId || !user) return;

    const fetchPost = async () => {
      try {
        const postRef = doc(db, 'posts', postId);
        const postSnap = await getDoc(postRef);

        if (!postSnap.exists()) {
          setError('投稿が見つかりません');
          setIsLoading(false);
          return;
        }

        const data = postSnap.data();

        // ユーザー認証確認（自分の投稿のみ表示）
        if (data.userId !== user.uid) {
          setError('このページを表示する権限がありません');
          setIsLoading(false);
          return;
        }

        setPost({
          id: postId,
          ...data,
        } as PostData);
        setError(null);
      } catch (err) {
        console.error('投稿取得エラー:', err);
        setError('投稿を取得できませんでした');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPost();
  }, [user, postId, authLoading, router]);

  const formatDate = (timestamp: Timestamp | null) => {
    if (!timestamp) return '';
    const date = timestamp.toDate();
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex justify-center py-12">
        <p className="text-gray-600">読み込み中...</p>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="rounded-lg bg-white p-8 shadow-md text-center">
        <p className="text-gray-600 mb-6">{error || '投稿が見つかりません'}</p>
        <button
          onClick={() => router.push('/home')}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600"
        >
          ← ホームに戻る
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-white p-6 shadow-md">
        {/* 戻るボタン */}
        <button
          onClick={() => router.push('/home')}
          className="mb-4 text-gray-600 hover:text-gray-800"
        >
          ← ホームに戻る
        </button>

        {/* 投稿日時 */}
        <p className="mb-4 text-sm text-gray-500">{formatDate(post.createdAt)}</p>

        {/* 画像 */}
        <div className="relative mb-6 aspect-square w-full overflow-hidden rounded-lg bg-gray-100 border border-gray-200">
          <Image
            src={post.imageUrl}
            alt="投稿画像"
            fill
            className="object-cover"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 600px"
          />
        </div>

        {/* ユーザーコメント */}
        {post.comment && (
          <div className="mb-6">
            <h3 className="mb-2 font-semibold text-gray-800">コメント</h3>
            <p className="whitespace-pre-wrap text-gray-700">{post.comment}</p>
          </div>
        )}

        {/* 練習時間 */}
        {post.minutes > 0 && (
          <div className="mb-6 rounded-lg bg-orange-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <span>⏱️</span>
              <span className="font-semibold text-orange-700">{post.minutes}分</span>
            </div>
          </div>
        )}

        {/* AIコメント */}
        {post.aiComment && (
          <div className="rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-100 px-4 py-3">
            <div className="flex items-start gap-2">
              <span className="text-lg flex-shrink-0">🤖</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-blue-600 mb-1">えがけん応援コメント</p>
                <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                  {post.aiComment}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
