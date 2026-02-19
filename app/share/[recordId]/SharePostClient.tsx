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
      "use client";

      import { useEffect, useState } from "react";
      import Image from "next/image";
      import Link from "next/link";
      import { doc, getDoc } from "firebase/firestore";
      import { db } from "@/lib/firebase";
      import ShareButton from "@/components/ShareButton";

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
      };

      export default function SharePostClient({ recordId }: Props) {
        const [post, setPost] = useState<Post | null>(null);
        const [isLoading, setIsLoading] = useState(true);

        useEffect(() => {
          if (!recordId) return;

          const fetchPost = async () => {
            setIsLoading(true);
            try {
              const ref = doc(db, "posts", recordId);
              const snap = await getDoc(ref);
              if (!snap.exists()) {
                console.error("投稿が存在しません");
                setPost(null);
              } else {
                setPost({ id: recordId, ...(snap.data() as Post) });
              }
            } catch (e) {
              console.error("取得エラー", e);
            } finally {
              setIsLoading(false);
            }
          };

          fetchPost();
        }, [recordId]);

        if (isLoading) return <p className="text-gray-600">読み込み中…</p>;
        if (!post) return <p>投稿がありません</p>;

        return (
          <div className="min-h-screen bg-gray-50 px-4 py-8 max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-4">{post.title}</h1>

            {post.imageUrl && (
              <div className="mb-4 w-full aspect-square relative rounded-lg overflow-hidden border bg-gray-100">
                <Image src={post.imageUrl} alt="投稿画像" fill className="object-cover" />
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
              <ShareButton
                recordId={post.id}
                comment={post.comment || ""}
                practiceMinutes={post.minutes || 0}
                aiComment={post.aiComment || ""}
                imageUrl={post.imageUrl || ""}
              />
            </div>

            <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
              ホームへ
            </Link>
          </div>
        );
      }
