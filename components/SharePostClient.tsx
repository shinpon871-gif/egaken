"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { ShareButton } from "@/components/ShareButton";
import Image from "next/image";
import Link from "next/link";

type Post = {
  id: string;
  title?: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: any;
  weeklyThemeId?: string;
  weeklyThemeTitle?: string;
};

type Props = {
  recordId?: string;
  version?: string;
  initialData: Post | null;
  v?: string;
};

export default function SharePostClient({ recordId, version, initialData, v }: Props) {
  const [post, setPost] = useState<Post | null>(initialData);
  const [isLoading, setIsLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) {
      setError("Record ID が指定されていません");
      setIsLoading(false);
      return;
    }

    const fetchPost = async () => {
      let currentPost = post;

      // 投稿データがない、またはIDが一致しない場合は取得
      if (!currentPost || currentPost.id !== recordId) {
        setIsLoading(true);
        setError(null);
        try {
          const docRef = doc(db, "posts", recordId);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const data = snap.data() as Post;
            currentPost = { ...data, id: recordId };
          } else {
            setError("投稿が存在しません");
            setIsLoading(false);
            return;
          }
        } catch (e) {
          setError("データ取得中にエラーが発生しました");
          setIsLoading(false);
          return;
        }
      }

      // 2. お題タイトルが欠けている場合のフォールバック取得
      if (currentPost && currentPost.weeklyThemeId && !currentPost.weeklyThemeTitle) {
        try {
          const themeSnap = await getDoc(doc(db, "weeklyThemes", currentPost.weeklyThemeId));
          if (themeSnap.exists()) {
            const themeData = themeSnap.data();
            currentPost = {
              ...currentPost,
              weeklyThemeTitle: themeData.title || "今週のお題",
            };
          }
        } catch (e) {
          console.error("お題情報の取得に失敗しました:", e);
        }
      }

      setPost(currentPost);
      setIsLoading(false);
    };
    fetchPost();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  if (isLoading) {
    return <p className="text-gray-600">読み込み中…</p>;
  }

  if (error) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-6 rounded shadow text-center">
        <p className="text-red-600 font-semibold mb-2">{error}</p>
        <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
          ホームへ
        </Link>
      </div>
    </div>;
  }

  if (!post) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-6 rounded shadow text-center">
        <p>投稿がありません</p>
        <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
          ホームへ
        </Link>
      </div>
    </div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 text-gray-800">{post.title || 'お絵描きの記録'}</h1>

      {post.imageUrl && (
        <div className="mb-4 w-full aspect-square relative rounded-lg overflow-hidden border bg-gray-100">
          <Image src={post.imageUrl} alt="投稿画像" fill className="object-cover" unoptimized />
        </div>
      )}

      {post.comment && (
        <div className="mb-4">
          <h3 className="font-semibold text-gray-800">コメント</h3>
          <p className="text-gray-700 whitespace-pre-wrap">{post.comment}</p>
        </div>
      )}

      {post.minutes && post.minutes > 0 && (
        <div className="mb-4 p-3 bg-orange-50 rounded-lg text-gray-800">
          <span>⏱️ 練習時間: {post.minutes}分</span>
        </div>
      )}

      {post.aiComment && (
        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
          <span className="font-semibold text-blue-600">えがけん応援コメント</span>
          <p className="text-gray-700 whitespace-pre-wrap">{post.aiComment}</p>
        </div>
      )}

      <div className="mb-4">
        <ShareButton
          recordId={post.id}
          comment={post.comment || ""}
          practiceMinutes={post.minutes || 0}
          aiComment={post.aiComment || ""}
          imageUrl={post.imageUrl || ""}
          themeId={post.weeklyThemeId}
          themeTitle={post.weeklyThemeTitle}
        />
      </div>

      <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
        ホームへ
      </Link>
    </div>
  );
}
