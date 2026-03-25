'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';

/**
 * Firebase Storage 画像URL デバッグページ
 * アップロードされた画像のURLを確認し、直接アクセステストができます
 */
export default function DebugStoragePage() {
  const { user } = useAuth();
  const [posts, setPosts] = useState<Record<string, unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [testUrls, setTestUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!user) {
      setIsLoading(false);
      return;
    }

    const fetchPosts = async () => {
      try {
        const q = query(
          collection(db, 'posts'),
          where('userId', '==', user.uid),
          orderBy('createdAt', 'desc'),
          limit(5)
        );

        const snapshot = await getDocs(q);
        const postsData: Record<string, unknown>[] = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          console.log(`[DEBUG] 投稿: ${doc.id}`, {
            imageUrl: data.imageUrl,
            comment: data.comment,
            createdAt: data.createdAt,
          });
          postsData.push({
            id: doc.id,
            ...data,
          });
        });

        setPosts(postsData);
      } catch (error) {
        console.error('[DEBUG] Firestore取得エラー:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPosts();
  }, [user]);

  const testImageUrl = async (postId: string, imageUrl: string) => {
    console.log(`[DEBUG] URL テスト開始 (proxy): ${imageUrl}`);

    try {
      const encoded = encodeURIComponent(imageUrl);
      const proxyUrl = `/api/image-proxy?url=${encoded}`;

      // まずプロキシに HEAD 相当で問い合わせ（fetch の HEAD は一部環境で制限されるため GET を使用して小さく取得）
      const response = await fetch(proxyUrl, {
        method: 'GET',
      });

      console.log('[DEBUG] proxy response:', { status: response.status, ok: response.ok, url: proxyUrl });

      if (!response.ok) {
        setTestUrls((prev) => new Map(prev).set(postId, `❌ proxy ${response.status}`));
        return;
      }

      const contentType = response.headers.get('content-type') || 'unknown';
      const blob = await response.blob();
      console.log('[DEBUG] proxy headers:', { contentType, size: blob.size });

      // ブラウザでプレビュー表示できるように一時URLを作成
      const objectUrl = URL.createObjectURL(blob);
      setTestUrls((prev) => new Map(prev).set(postId, `✅ OK (${response.status}) ${contentType} / ${blob.size} bytes`));

      // 簡易プレイヤー表示（デバッグ用）: open in new tab
      window.open(objectUrl, '_blank');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[DEBUG] proxy URL テストエラー:`, errorMsg);
      setTestUrls((prev) => new Map(prev).set(postId, `❌ ${errorMsg}`));
    }
  };

  if (isLoading) {
    return <div className="p-4">読み込み中...</div>;
  }

  if (!user) {
    return <div className="p-4">ログインしてください</div>;
  }

  if (posts.length === 0) {
    return <div className="p-4">投稿がありません</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">🔧 Firebase Storage デバッグ</h1>

      <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
        <p className="text-sm text-blue-800">
          <strong>指示：</strong> 下記の各URLを確認して、「テスト」ボタンをクリックしてください。
          ブラウザのコンソール（F12）で詳細なログが表示されます。
        </p>
      </div>

      <div className="space-y-4">
        {posts.map((post) => {
          const postId = post.id as string;
          const postImageUrl = post.imageUrl as string;
          const postComment = post.comment as string;
          return (
            <div key={postId} className="border rounded-lg p-4 space-y-2">
              <p className="font-bold text-gray-800">投稿 ID: {postId}</p>

              {/* imageUrl */}
              <div>
                <label className="text-sm font-semibold text-gray-700">画像 URL:</label>
                <textarea
                  value={postImageUrl}
                  readOnly
                  className="w-full bg-gray-50 border border-gray-300 rounded p-2 text-xs font-mono mt-1"
                  rows={3}
                />
              </div>

              {/* テストボタン */}
              <button
                onClick={() => testImageUrl(postId, postImageUrl)}
                className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded text-sm font-semibold"
              >
                💾 このURLをテスト
              </button>

              {testUrls.has(postId) ? (
                <div className="bg-gray-100 p-2 rounded text-sm font-mono">
                  {(testUrls.get(postId) ?? '') as string}
                </div>
              ) : null}

              {/* 画像プレビュー（読み込みテスト） */}
              <details className="cursor-pointer">
                <summary className="text-sm font-semibold text-gray-700">
                  画像プレビュー（クリックして展開）
                </summary>
                <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                  <img
                    src={postImageUrl}
                    alt={postComment}
                    className="max-w-full max-h-64 border border-gray-300 rounded"
                    onLoad={() => console.log(`✅ 画像読み込み成功: ${postId}`)}
                    onError={() => console.error(`❌ 画像読み込み失敗: ${postId}`)}
                    crossOrigin="anonymous"
                  />
                </div>
              </details>

              {/* コメント */}
              {postComment && (
                <div className="text-sm text-gray-600">
                  <strong>コメント:</strong> {postComment}
                </div>
              )}

              <hr className="my-2" />
            </div>
          );
        })}
      </div>

      {/* Firebase Security Rules ドキュメント */}
      <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-200">
        <h2 className="font-bold text-yellow-900 mb-2">📋 Firebase Security Rules 設定確認</h2>
        <p className="text-sm text-yellow-800 mb-3">
          画像が読み込めない場合は、Firebase コンソールで以下のルールが設定されているか確認してください：
        </p>
        <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto">
{`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /records/{userId}/{filename} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && 
        request.auth.uid == userId;
      allow delete: if request.auth != null && 
        request.auth.uid == userId;
    }
  }
}`}
        </pre>
        <a
          href="https://console.firebase.google.com/project/_/storage/rules"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-yellow-700 underline mt-2 inline-block"
        >
          🔗 Firebase コンソールで Security Rules を編集
        </a>
      </div>
    </div>
  );
}
