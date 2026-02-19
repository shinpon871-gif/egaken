"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Post = {
  id: string;
  title: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: any;
};

type Props = {
  recordId: string;
  version?: string;
};

export default function SharePostClient({ recordId, version }: Props) {
  const [post, setPost] = useState<Post | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) {
      setError("Record ID が指定されていません");
      setIsLoading(false);
      return;
    }

    const fetchPost = async () => {
      setIsLoading(true);
      setError(null);
      try {
        console.log("Fetching record:", recordId);

        const ref = doc(db, "posts", recordId);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          console.error("Firestore record not found:", recordId);
          setError("投稿が見つかりません");
          setPost(null);
          return;
        }

        const data = snap.data();
        console.log("Firestore data:", data);

        setPost({ id: recordId, ...(data as Omit<Post, "id">) });
      } catch (err) {
        console.error("Firestore fetch error:", err);
        setError("投稿を取得できませんでした");
        setPost(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPost();
  }, [recordId]);

  if (isLoading) return <p className="text-gray-600">読み込み中...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!post) return <p>投稿がありません</p>;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-2">{post.title}</h1>
      {post.imageUrl && (
        <img src={post.imageUrl} alt={post.title} className="w-full max-w-md mb-4 rounded" />
      )}
      {post.comment && <p className="mb-2">{post.comment}</p>}
      {post.minutes !== undefined && <p>練習時間: {post.minutes}分</p>}
      {post.aiComment && <p className="italic text-gray-600">AIコメント: {post.aiComment}</p>}
    </div>
  );
}
