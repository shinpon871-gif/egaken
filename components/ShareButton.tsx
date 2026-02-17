'use client';

import { useState, useEffect } from 'react';
import { generateTweetText } from '@/lib/twitter';

interface ShareButtonProps {
  recordId: string;
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
  imageUrl: string;
}

export function ShareButton({ recordId, comment, practiceMinutes, aiComment, imageUrl }: ShareButtonProps) {
  const [isSharing, setIsSharing] = useState(false);
  const [isShorteningUrl, setIsShorteningUrl] = useState(true); // 初期状態を true に
  const [tweetResultShort, setTweetResultShort] = useState(() => {
    // 記録詳細ページのURLを生成
    const postUrl = typeof window !== 'undefined' 
      ? `${window.location.origin}/post/${recordId}`
      : `https://egaken.com/post/${recordId}`;
    return generateTweetText(practiceMinutes, comment, postUrl);
  });

  // コンポーネントマウント時に記録ページURLを投稿テキストに含める
  useEffect(() => {
    const generateShortTweet = async () => {
      setIsShorteningUrl(true);
      try {
        // 記録詳細ページのURLを生成
        const postUrl = typeof window !== 'undefined' 
          ? `${window.location.origin}/post/${recordId}`
          : `https://egaken.com/post/${recordId}`;
        
        console.log('投稿URL:', postUrl);
        const result = generateTweetText(practiceMinutes, comment, postUrl);
        console.log('投稿テキスト生成完了:', result);
        setTweetResultShort(result);
      } catch (error) {
        console.error('投稿テキスト生成エラー:', error);
        // 失敗時は元のテキストを使用
        const postUrl = typeof window !== 'undefined' 
          ? `${window.location.origin}/post/${recordId}`
          : `https://egaken.com/post/${recordId}`;
        const fallbackResult = generateTweetText(practiceMinutes, comment, postUrl);
        console.log('フォールバック使用:', fallbackResult);
        setTweetResultShort(fallbackResult);
      } finally {
        setIsShorteningUrl(false);
      }
    };

    generateShortTweet();
  }, [practiceMinutes, comment, recordId]);

  const handleShare = async () => {
    // 文字数制限をチェック
    if (tweetResultShort.isOverLimit) {
      alert('140文字以内に収めてください');
      return;
    }

    setIsSharing(true);

    const shareText = tweetResultShort.text;

    // Web Share API (モバイル等で画像付きシェア) を試行
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        // 画像を取得してFileオブジェクト化
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const file = new File([blob], 'image.png', { type: blob.type });

        // ファイル共有がサポートされているか確認
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            text: shareText,
            files: [file],
          });
          setIsSharing(false);
          return;
        }
      } catch (error) {
        console.warn('Web Share APIでの画像共有に失敗しました（Web Intentへフォールバックします）:', error);
      }
    }

    // --- Web Intent (PCや非対応ブラウザ用) ---
    const encodedText = encodeURIComponent(shareText);
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodedText}`;

    window.open(twitterUrl, '_blank', 'noreferrer');
    setIsSharing(false);
  };

  const isButtonDisabled = tweetResultShort.isOverLimit || isSharing || isShorteningUrl;

  return (
    <div className="space-y-3">
      {/* Twitter投稿プレビュー */}
      <div className="rounded-lg border border-gray-300 bg-gray-50 p-4 overflow-hidden w-full">
        <p className="mb-2 text-xs font-semibold text-gray-600">投稿プレビュー</p>
        <div className="mb-3 whitespace-pre-wrap rounded bg-white p-3 text-sm text-gray-800 break-all overflow-hidden max-w-full min-w-0">
          {isShorteningUrl ? (
            <span className="text-gray-500 italic">短縮URLを生成中...</span>
          ) : (
            tweetResultShort.text
          )}
        </div>
        
        {/* 文字数カウンター */}
        <div className="flex items-center justify-between">
          <span className={`text-sm font-semibold ${
            tweetResultShort.isOverLimit
              ? 'text-red-600'
              : tweetResultShort.isWarning
                ? 'text-orange-600'
                : 'text-green-600'
          }`}>
            {tweetResultShort.length} / {140}文字
          </span>
        </div>

        {/* 警告メッセージ */}
        {tweetResultShort.isWarning && (
          <p className="mt-2 text-xs text-orange-600">
            ⚠️ 投稿が長いため、Twitterで文章が途切れる可能性があります
          </p>
        )}

        {tweetResultShort.isOverLimit && (
          <p className="mt-2 text-xs text-red-600">
            ❌ 140文字以内に収めてください
          </p>
        )}

        {/* 短縮URL情報 */}
        {isShorteningUrl && (
          <p className="mt-2 text-xs text-blue-600">
            🔗 URLを短縮中...
          </p>
        )}
      </div>

      {/* 共有ボタン */}
      <button
        onClick={handleShare}
        disabled={isButtonDisabled}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-100 active:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
        title={tweetResultShort.isOverLimit ? '文字数が超過しています' : 'この記録をXで共有'}
      >
        <span className="text-base">𝕏</span>
        <span>{isSharing ? '準備中...' : isShorteningUrl ? '準備中...' : 'Xで共有'}</span>
      </button>
    </div>
  );
}
