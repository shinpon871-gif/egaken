'use client';

import { useState, useMemo } from 'react';
// Xキャッシュ対策: 共有URLにtimestampを付与
function createShareUrl(recordId: string) {
  const base = `https://egaken.vercel.app/share/${recordId}`;
  const timestamp = Date.now();
  return `${base}?v=${timestamp}`;
}
import { generateTweetText } from '@/lib/twitter';

interface ShareButtonProps {
  recordId: string;
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
  imageUrl: string;
}

/**
 * iOSかどうかを判定
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export function ShareButton({ recordId, comment, practiceMinutes, aiComment, imageUrl }: ShareButtonProps) {
  const [isSharing, setIsSharing] = useState(false);


  // シェア用URLは常に1回だけtext末尾に含める。/share/[recordId]形式に統一。
  const shareUrl = `https://egaken.vercel.app/share/${recordId}`;
  const tweetResult = useMemo(() => generateTweetText(practiceMinutes, comment, shareUrl), [practiceMinutes, comment, recordId]);

  const handleShare = async () => {
    if (tweetResult.isOverLimit) {
      alert('140文字以内に収めてください');
      return;
    }
    setIsSharing(true);
    const shareText = tweetResult.text;
    const iosDevice = isIOS();
    const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    try {
      if (iosDevice) {
        // iOSは_blankを付けない方が安定
        const newWindow = window.open(intentUrl);
        if (!newWindow) {
          console.warn('window.open がブロックされました');
          alert(`下記リンクをタップしてTwitterで投稿してください：\n\n${intentUrl}`);
        }
      } else {
        window.open(intentUrl, '_blank');
      }
    } catch (error) {
      console.error('シェアエラー:', error);
      alert('共有に失敗しました');
    } finally {
      setIsSharing(false);
    }
  };

  const isButtonDisabled = tweetResult.isOverLimit || isSharing;

  return (
    <div className="space-y-3">
      {/* Twitter投稿プレビュー */}

      <div className="rounded-lg border border-gray-300 bg-gray-50 p-4 overflow-hidden w-full">
        <p className="mb-2 text-xs font-semibold text-gray-600">投稿プレビュー</p>
        <div className="mb-3 whitespace-pre-wrap rounded bg-white p-3 text-sm text-gray-800 break-all overflow-hidden max-w-full min-w-0">
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
        title={tweetResult.isOverLimit ? '文字数が超過しています' : 'この記録をTwitterで共有'}
      >
        <span className="text-base">𝕏</span>
        <span>{isSharing ? '準備中...' : 'Twitter（X）で共有'}</span>
      </button>
    </div>
  );
}
