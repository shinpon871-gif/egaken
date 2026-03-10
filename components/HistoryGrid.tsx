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
import { useRouter } from 'next/navigation';

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
  const router = useRouter();

  const [posts, setPosts] = useState<HistoryPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
          const data = doc.data() as Omit<HistoryPost, 'id'>;
          postsData.push({
            id: doc.id,
            ...data,
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

  const getProxyImageUrl = (imageUrl: string) => {
    return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  };

  const handleImageError = (postId: string) => {
    setImageErrors((prev) => new Set([...prev, postId]));
  };

  const toggleSelect = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((v) => v !== id));
    } else {
      if (selectedIds.length < 9) {
        setSelectedIds([...selectedIds, id]);
      }
    }
  };

  const createNine = () => {
    if (selectedIds.length !== 9) {
      alert('9枚選択してください');
      return;
    }

    const ids = selectedIds.join(',');

    router.push(`/nine?ids=${ids}`);
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
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* 操作バー */}
      <div className="flex items-center gap-3">

        <button
          onClick={() => {
            setSelectMode(!selectMode);
            setSelectedIds([]);
          }}
          className="px-4 py-2 rounded bg-gray-800 text-white text-sm"
        >
          {selectMode ? '選択終了' : '9選を作る'}
        </button>

        {selectMode && (
          <>
            <span className="text-sm text-gray-500">
              {selectedIds.length} / 9 選択
            </span>

            <button
              onClick={createNine}
              disabled={selectedIds.length !== 9}
              className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
            >
              9選画像を作成
            </button>
          </>
        )}

      </div>

      {/* グリッド */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {posts.map((post) => {

          const hasError = imageErrors.has(post.id);
          const selected = selectedIds.includes(post.id);

          return (
            <div
              key={post.id}
              onClick={() => {
                if (selectMode) {
                  toggleSelect(post.id);
                } else {
                  router.push(`/record/${post.id}`);
                }
              }}
              className={`group relative overflow-hidden rounded-lg cursor-pointer
              ${selected ? 'ring-4 ring-blue-500' : ''}
              `}
            >

              <div className="relative w-full bg-white" style={{ paddingBottom: '100%' }}>
                <div className="absolute inset-0 bg-gray-100">

                  {hasError || !post.imageUrl ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-2xl">⚠️</span>
                    </div>
                  ) : (
                    <img
                      src={getProxyImageUrl(post.imageUrl)}
                      alt={post.comment || 'drawing'}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      onError={() => handleImageError(post.id)}
                    />
                  )}

                </div>

                {/* 選択マーク */}
                {selectMode && selected && (
                  <div className="absolute top-2 right-2 bg-blue-600 text-white text-xs px-2 py-1 rounded">
                    ✓
                  </div>
                )}

                {/* ホバー情報 */}
                <div className="absolute inset-0 flex flex-col justify-end p-3 bg-[rgba(0,0,0,0)] group-hover:bg-[rgba(0,0,0,0.6)] transition">
                  <div className="opacity-0 group-hover:opacity-100 text-white text-xs">
                    <p>{formatDate(post.createdAt)}</p>
                    {post.minutes > 0 && <p>⏱️ {post.minutes}分</p>}
                  </div>
                </div>

              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}