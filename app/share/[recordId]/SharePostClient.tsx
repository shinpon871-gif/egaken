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
