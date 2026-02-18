'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import Link from 'next/link';
import Image from 'next/image';

interface HistoryPost {
  id: string;
  userId: string;
  imageUrl: string;
  comment?: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
}

export function HistoryGrid() {
  const { user } = useAuth();
  const [posts, setPosts] = useState<HistoryPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'posts'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(100)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const postsData: HistoryPost[] = [];
        snapshot.forEach((doc) => {
          postsData.push({
            id: doc.id,
            ...(doc.data() as Omit<HistoryPost, 'id'>),
          });
        });
        setPosts(postsData);
        setIsLoading(false);
      },
      (error) => {
        console.error('ヒストリー取得エラー:', error);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user]);

  const formatDate = (timestamp: Timestamp | null) => {
    if (!timestamp) return '';
    const date = timestamp.toDate();
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-12">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col justify-center items-center py-12 text-center">
        <div className="text-5xl mb-4">📝</div>
        <p className="text-gray-500 text-lg">まだ記録がありません</p>
        <p className="text-gray-400 text-sm mt-2">お絵描きを記録して、成長を見てみましょう！</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {posts.map((post) => (
        <Link
          key={post.id}
          href={`/record/${post.id}`}
          className="group relative overflow-hidden rounded-lg bg-gray-100 aspect-square hover:shadow-lg transition-shadow"
        >
          {/* 画像 */}
          <div className="relative w-full h-full">
            <Image
              src={post.imageUrl}
              alt={post.comment || 'drawing'}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            />
          </div>

          {/* ホバー時の情報表示 */}
          <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-60 transition-all duration-200 flex flex-col justify-end p-3">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <p className="text-white text-xs font-semibold">
                {formatDate(post.createdAt)}
              </p>
              {post.minutes > 0 && (
                <p className="text-white text-xs">
                  ⏱️ {post.minutes}分
                </p>
              )}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
