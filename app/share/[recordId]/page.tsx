import { Metadata, ResolvingMetadata } from 'next';
import { useEffect, useState } from 'react';
import { db } from '@/lib/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';

interface PostData {
  id: string;
  userId: string;
  imageUrl: string;
  comment: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
}

// 動的metadata生成
export async function generateMetadata(
  { params }: { params: { recordId: string } },
  parent: ResolvingMetadata
): Promise<Metadata> {
  const { recordId } = params;
  const ogImageUrl = `https://egaken.vercel.app/api/og/${recordId}`;
  const title = 'えがけん｜お絵描き記録';
  const description = 'お絵描きトレーニングの記録';
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [ogImageUrl],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
  };
}

export default function SharePostPage() {
  const params = useParams();
  const postId = params.recordId as string;

  const [post, setPost] = useState<PostData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!postId) return;

    const fetchPost = async () => {
      try {
        const postRef = doc(db, 'posts', postId);
        const postSnap = await getDoc(postRef);

        if (!postSnap.exists()) {
          setError('記録が見つかりません');
          setIsLoading(false);
          return;
        }

        const data = postSnap.data();

        setPost({
          id: postId,
          userId: data.userId,
          imageUrl: data.imageUrl,
          comment: data.comment || '',
          minutes: data.minutes || 0,
          aiComment: data.aiComment,
          createdAt: data.createdAt,
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
  import { ShareButton } from '@/components/ShareButton';
  }, [postId]);

  const formatDate = (timestamp: Timestamp | null) => {
    if (!timestamp) return '';
    const date = timestamp.toDate();
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <p className="text-gray-600">読み込み中...</p>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="rounded-lg bg-white p-8 shadow-md text-center max-w-md">
          <div className="mb-4 text-5xl">📝</div>
          <h2 className="mb-2 text-2xl font-bold text-gray-800">えがけん</h2>
              <div className="rounded-lg bg-white p-6 shadow-md text-center">
                <p className="text-sm text-gray-600">
                  このリンクを共有して、あなたの成長を友達に見せましょう！
                </p>
                {/* Twitter(X)で共有ボタン */}
                {post && (
                  <div className="mt-4">
                    <ShareButton
                      recordId={post.id}
                      comment={post.comment}
                      practiceMinutes={post.minutes}
                      aiComment={post.aiComment}
                      imageUrl={post.imageUrl}
                    />
                  </div>
                )}
              </div>
            ホームへ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto max-w-2xl px-4 py-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🎨</span>
            <h1 className="text-2xl font-bold text-gray-800">えがけん</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-2xl px-4 py-8">
        <div className="space-y-6">
          <div className="rounded-lg bg-white p-6 shadow-md">
            {/* 投稿日時 */}
            <p className="mb-6 text-sm text-gray-500">{formatDate(post.createdAt)}</p>

            {/* 画像 */}
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

            {/* ユーザーコメント */}
            {post.comment && (
              <div className="mb-6">
                <h3 className="mb-2 font-semibold text-gray-800">コメント</h3>
                <p className="whitespace-pre-wrap text-gray-700">{post.comment}</p>
              </div>
            )}

            {/* 練習時間 */}
            {post.minutes > 0 && (
              <div className="mb-6 rounded-lg bg-orange-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span>⏱️</span>
                  <span className="font-semibold text-orange-700">{post.minutes}分</span>
                </div>
              </div>
            )}

            {/* AIコメント */}
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

            {/* CTA */}
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

          {/* Share Info */}
          <div className="rounded-lg bg-white p-6 shadow-md text-center">
            <p className="text-sm text-gray-600">
              このリンクを共有して、あなたの成長を友達に見せましょう！
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
