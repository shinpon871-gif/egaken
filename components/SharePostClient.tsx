"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { calculateTrainingDays } from "@/lib/utils";
import { ShareButton } from "@/components/ShareButton";
import Image from "next/image";
import Link from "next/link";

type Post = {
  id: string;
  userId?: string;
  title?: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: unknown;
  weeklyThemeId?: string;
  weeklyThemeTitle?: string;
  showOgp?: boolean;
  ogpCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type Props = {
  recordId?: string;
  version?: string;
  initialData: (Post | Record<string, unknown>) | null;
  v?: string;
};

export default function SharePostClient({ recordId, version, initialData, v }: Props) {
  const [post, setPost] = useState<Post | Record<string, unknown> | null>(initialData as Post | Record<string, unknown> | null);
  const [isLoading, setIsLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(recordId ? null : "Record ID が指定されていません");
  const [trainingDays, setTrainingDays] = useState<number>(0);

  useEffect(() => {
    if (!recordId) {
      return;
    }

    // リアルタイムリスナーで投稿データの変更を監視
    // これにより、AIコメント生成完了時に自動的に反映される
    const unsubscribe = onSnapshot(
      doc(db, "posts", recordId),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Post;
          const currentPost = { ...data, id: recordId };

          // お題タイトルが欠けている場合のフォールバック取得
          if (currentPost.weeklyThemeId && !currentPost.weeklyThemeTitle) {
            getDoc(doc(db, "weeklyThemes", currentPost.weeklyThemeId)).then(
              (themeSnap) => {
                if (themeSnap.exists()) {
                  const themeData = themeSnap.data();
                  setPost((prevPost) => {
                    if (!prevPost) return currentPost;
                    return {
                      ...(prevPost as Post),
                      weeklyThemeTitle:
                        themeData.title || "今週のお題",
                    };
                  });
                }
              }
            );
          }

          setPost(currentPost);
          setIsLoading(false);
        } else {
          setError("投稿が存在しません");
          setIsLoading(false);
        }
      },
      (error) => {
        console.error("リアルタイム監視エラー:", error);
        setError("データ取得中にエラーが発生しました");
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [recordId]);

  // 通算日数を計算
  useEffect(() => {
    const userId = (post as Post)?.userId as string | undefined;
    if (userId && typeof userId === 'string') {
      calculateTrainingDays(userId).then(setTrainingDays).catch((e) => {
        console.error('calculateTrainingDays failed:', e);
        setTrainingDays(0);
      });
    }
  }, [post]);

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
      <h1 className="text-2xl font-bold mb-4 text-gray-800">{(post as Post | null)?.title || 'お絵描きの記録'}</h1>

      {(post as Post | null)?.imageUrl && (
        <div className="mb-4 w-full aspect-square relative rounded-lg overflow-hidden border bg-gray-100">
          <Image src={(post as Post).imageUrl as string} alt="投稿画像" fill className="object-cover" unoptimized />
        </div>
      )}

      {(post as Post | null)?.comment && (
        <div className="mb-4">
          <h3 className="font-semibold text-gray-800">コメント</h3>
          <p className="text-gray-700 whitespace-pre-wrap">{(post as Post).comment as string}</p>
        </div>
      )}

      {(post as Post | null)?.minutes && (post as Post).minutes! > 0 && (
        <div className="mb-4 p-3 bg-orange-50 rounded-lg text-gray-800">
          <span>⏱️ 練習時間: {(post as Post).minutes!}分</span>
          {trainingDays > 0 && (
            <div className="mt-2">
              <span>📅 通算: {trainingDays}日目</span>
            </div>
          )}
        </div>
      )}

      {(post as Post | null)?.aiComment && (
        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
          <span className="font-semibold text-blue-600">えがけん応援コメント</span>
          <p className="text-gray-700 whitespace-pre-wrap">{(post as Post).aiComment as string}</p>
        </div>
      )}

      <div className="mb-4">
        <ShareButton
          recordId={(post as Post).id as string}
          comment={(post as Post).comment || ""}
          practiceMinutes={(post as Post).minutes || 0}
          themeId={(post as Post).weeklyThemeId as string | undefined}
          themeTitle={(post as Post).weeklyThemeTitle as string | undefined}
          userId={(post as Post).userId as string | undefined}
          trainingDays={trainingDays}
          showOgp={(post as Post).showOgp !== false}
        />
      </div>

      <Link href="/" className="inline-block mt-4 px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600">
        ホームへ
      </Link>
    </div>
  );
}
