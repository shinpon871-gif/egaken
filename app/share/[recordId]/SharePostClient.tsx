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

  useEffect(() => {
    if (!recordId) return;

    const fetchPost = async () => {
      setIsLoading(true);
      try {
        const ref = doc(db, "posts", recordId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          console.error("not found");
          return;
        }
        setPost({ id: recordId, ...(snap.data() as Omit<Post, "id">) });
      } finally {
        setIsLoading(false);
      }
    };

    fetchPost();
  }, [recordId]);

  if (isLoading) return <p className="text-gray-600">読み込み中...</p>;
  if (!post) return <p>投稿がありません</p>;

  return <div>{post.title}</div>;
}
