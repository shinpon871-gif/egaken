'use client';

import { useState } from 'react';
import { generateTweetText } from '@/lib/twitter';

interface ShareButtonProps {
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
  imageUrl: string;
}

export function ShareButton({ comment, practiceMinutes, aiComment, imageUrl }: ShareButtonProps) {
  const [isSharing, setIsSharing] = useState(false);

  const handleShare = async () => {
    // Twitter投稿テキストを生成
    const tweetResult = generateTweetText(practiceMinutes, comment, imageUrl);

    // 文字数制限をチェック
    if (tweetResult.isOverLimit) {
      alert('140文字以内に収めてください');
      return;
    }

    setIsSharing(true);

    const shareText = tweetResult.text;

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

  // Twitter投稿テキストを生成して文字数をプレビュー
  const tweetResult = generateTweetText(practiceMinutes, comment, imageUrl);
  const isButtonDisabled = tweetResult.isOverLimit || isSharing;

  return (
    <div className="space-y-3">
      {/* Twitter投稿プレビュー */}
      <div className="rounded-lg border border-gray-300 bg-gray-50 p-4">
        <p className="mb-2 text-xs font-semibold text-gray-600">投稿プレビュー</p>
        <div className="mb-3 whitespace-pre-wrap rounded bg-white p-3 text-sm text-gray-800">
          {tweetResult.text}
        </div>
        
        {/* 文字数カウンター */}
        <div className="flex items-center justify-between">
          <span className={`text-sm font-semibold ${
            tweetResult.isOverLimit
              ? 'text-red-600'
              : tweetResult.isWarning
                ? 'text-orange-600'
                : 'text-green-600'
          }`}>
            {tweetResult.length} / {140}文字
          </span>
        </div>

        {/* 警告メッセージ */}
        {tweetResult.isWarning && (
          <p className="mt-2 text-xs text-orange-600">
            ⚠️ 投稿が長いため、Twitterで文章が途切れる可能性があります
          </p>
        )}

        {tweetResult.isOverLimit && (
          <p className="mt-2 text-xs text-red-600">
            ❌ 140文字以内に収めてください
          </p>
        )}
      </div>

      {/* 共有ボタン */}
      <button
        onClick={handleShare}
        disabled={isButtonDisabled}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-100 active:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
        title={tweetResult.isOverLimit ? '文字数が超過しています' : 'この記録をXで共有'}
      >
        <span className="text-base">𝕏</span>
        <span>{isSharing ? '準備中...' : 'Xで共有'}</span>
      </button>
    </div>
  );
}
