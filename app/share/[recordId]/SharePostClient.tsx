"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { ShareButton } from "@/components/ShareButton";
import Image from "next/image";
import Link from "next/link";

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
  recordId: string; // 必須に変更
  initialData: Post | null;
  v?: string;       // キャッシュバスター用パラメータ
};

export default function SharePostClient({ recordId, initialData, v }: Props) {
  const [post, setPost] = useState<Post | null>(initialData);
  const [isLoading, setIsLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // サーバーからの初期データがあれば、クライアント側での再取得はスキップ
    if (initialData) {
      setPost(initialData);
      setIsLoading(false);
      return;
    }

    const fetchPost = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const docRef = doc(db, "posts", recordId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data() as Post;
          setPost({ ...data, id: recordId });
        } else {
          setPost(null);
          setError("投稿が存在しません");
        }
      } catch (e) {
        setError("データ取得中にエラーが発生しました");
        setPost(null);
      } finally {
        setIsLoading(false);
      }
    };

    if (recordId) {
      fetchPost();
    }
  }, [recordId, initialData]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-600">読み込み中…</p>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white p-6 rounded shadow text-center">
          <p className="text-red-600 font-semibold mb-2">{error || "投稿が見つかりませんでした"}</p>
          <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
            ホームへ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">{post.title}</h1>

      {post.imageUrl && (
        <div className="mb-4 w-full aspect-square relative rounded-lg overflow-hidden border bg-gray-100">
          <Image 
            src={post.imageUrl} 
            alt="投稿画像" 
            fill 
            className="object-cover" 
            priority // OGP画像と一致させるため優先読み込み
          />
        </div>
      )}

      {post.comment && (
        <div className="mb-4">
          <h3 className="font-semibold text-gray-800">コメント</h3>
          <p className="text-gray-700 whitespace-pre-wrap">{post.comment}</p>
        </div>
      )}

      {post.minutes && post.minutes > 0 && (
        <div className="mb-4 p-3 bg-orange-50 rounded-lg">
          <span>⏱ 練習時間: {post.minutes}分</span>
        </div>
      )}

      {post.aiComment && (
        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
          <span className="font-semibold text-blue-600">AIコメント</span>
          <p className="text-gray-700 whitespace-pre-wrap">{post.aiComment}</p>
        </div>
      )}

      <div className="mb-4">
        {/* ShareButton 内のリンク生成ロジックでも 
          ?v=${v} が使われるように Props を渡せるようにしておくと完璧です
        */}
        <ShareButton
          recordId={post.id}
          comment={post.comment || ""}
          practiceMinutes={post.minutes || 0}
          aiComment={post.aiComment || ""}
          imageUrl={post.imageUrl || ""}
          v={v} // キャッシュバスターを継承
        />
      </div>

      <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
        ホームへ
      </Link>
    </div>
  );
}