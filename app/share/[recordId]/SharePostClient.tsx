"use client";

import { useEffect, useState } from 'react';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import Image from 'next/image';
import Link from 'next/link';
import { ShareButton } from '@/components/ShareButton';

type Post = {
  id: string;
  title: string;
  description?: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: Timestamp | null;
  userId?: string;
};

type Props = {
  recordId: string;
  version?: string;
};

export default function SharePostClient({ recordId }: Props) {
  const [post, setPost] = useState<Post | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) return;

    const fetchPost = async () => {
      setIsLoading(true);
      try {
        const docRef = doc(db, 'posts', recordId);
        const postSnap = await getDoc(docRef);
        if (!postSnap.exists()) {
          setError('Record not found');
          return;
        }
        const data = postSnap.data();
        setPost({
          id: recordId,
          ...(data as Omit<Post, 'id'>),
        });
        setError(null);
      } catch (err) {
        console.error('投稿取得エラー:', err);
        setError('投稿を取得できませんでした');
      } finally {
        setIsLoading(false);
                if (!snap.exists()) {
                  console.error("not found");
                  return;
                }
                setPost(snap.data() as Post);
              } finally {
                setIsLoading(false);
              }
            };

            fetchPost();
          }, [recordId]);

          if (isLoading) {
            return <p className="text-gray-600">読み込み中...</p>;
          }
          if (!post) {
            return <p>投稿がありません</p>;
          }

          return (
            <div>
              <h1>{post.title}</h1>
              {/* ここに表示内容 */}
            </div>
          );
        }
            <span className="text-2xl">🎨</span>
            <h1 className="text-2xl font-bold text-gray-800">えがけん</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-8 space-y-6">
        <div className="rounded-lg bg-white p-6 shadow-md">
          <p className="mb-6 text-sm text-gray-500">{formatDate(post.createdAt || null)}</p>

          {post.imageUrl && (
            <div className="relative mb-6 aspect-square w-full overflow-hidden rounded-lg bg-gray-100 border border-gray-200">
              <Image
                src={post.imageUrl}
                alt="投稿画像"
                fill
                className="object-cover"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 600px"
                priority
              />
            </div>
          )}

          {post.comment && (
            <div className="mb-6">
              <h3 className="mb-2 font-semibold text-gray-800">コメント</h3>
              <p className="whitespace-pre-wrap text-gray-700">{post.comment}</p>
            </div>
          )}

          {post.minutes && post.minutes > 0 && (
            <div className="mb-6 rounded-lg bg-orange-50 px-4 py-3">
              <div className="flex items-center gap-2">
                <span>⏱️</span>
                <span className="font-semibold text-orange-700">{post.minutes}分</span>
              </div>
            </div>
          )}

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

          <div className="mt-8 rounded-lg bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 p-4 text-center">
            <p className="text-sm text-gray-700 mb-3">
              このような記録を毎日続けることで、着実に成長できます
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-6 py-2 font-semibold text-white transition hover:bg-orange-600"
            >
              🎨 えがけんをはじめる
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
