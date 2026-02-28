import SharePostClient from '@/components/SharePostClient';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

// Firestoreのドキュメントの型
type PostData = {
  userId: string;
  imageUrl: string;
  comment: string;
  minutes: number;
  aiComment?: string;
  createdAt: any; // Timestamp
  weeklyThemeId?: string | null;
};

type Props = {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// メタデータ生成 (OGP対応)
export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  const { recordId } = params;
  if (!recordId) return {};

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);

    if (!snap.exists()) {
      return { title: '記録が見つかりません' };
    }

    const post = snap.data() as PostData;
    const title = 'お絵描きの記録';
    const description = post.comment || '投稿されたお絵描きの記録です。';

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        images: post.imageUrl ? [post.imageUrl] : [],
        type: 'article',
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: post.imageUrl ? [post.imageUrl] : [],
      },
    };
  } catch (error) {
    console.error('Metadata generation error:', error);
    return {
      title: 'エラー',
      description: '記録の読み込み中にエラーが発生しました。',
    };
  }
}

// ページコンポーネント
export default async function RecordPage(props: Props) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const { recordId } = params;
  const v = typeof searchParams.v === 'string' ? searchParams.v : undefined;

  const docRef = doc(db, 'posts', recordId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) {
    notFound();
  }

  const postData = snap.data() as PostData;

  // クライアントコンポーネントに渡すためにシリアライズ可能な形式に変換
  const initialData = {
    id: snap.id,
    comment: postData.comment,
    minutes: postData.minutes,
    aiComment: postData.aiComment,
    imageUrl: postData.imageUrl,
    createdAt: postData.createdAt?.toDate?.().toISOString() || new Date().toISOString(),
    title: 'お絵描きの記録',
    weeklyThemeId: postData.weeklyThemeId ?? undefined,
  };

  return (
    <div>
      <div className="flex items-center">
        <span className="text-xl font-bold">{initialData.title}</span>
        {initialData.weeklyThemeId && (
          <span className="text-xs text-blue-600 ml-2">
            Weekly Theme Joined
          </span>
        )}
      </div>
      <SharePostClient recordId={recordId} initialData={initialData} v={v} />
    </div>
  );
}