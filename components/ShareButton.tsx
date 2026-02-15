'use client';

import { useState } from 'react';

interface ShareButtonProps {
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
  imageUrl: string;
}

export function ShareButton({ comment, practiceMinutes, aiComment, imageUrl }: ShareButtonProps) {
  const [isSharing, setIsSharing] = useState(false);

  const handleShare = async () => {
    setIsSharing(true);

    // テキストテンプレートを生成
    let shareText = 'えがけん記録\n';

    // 練習時間を追加
    if (practiceMinutes > 0) {
      shareText += `練習時間: ${practiceMinutes}分\n`;
    }

    // コメントを追加
    if (comment) {
      shareText += `コメント: ${comment}\n`;
    }

    // AIコメントを追加
    if (aiComment) {
      shareText += `\n【えがけんコメント】\n${aiComment}\n`;
    }

    shareText += '\n';
    shareText += '#えがけん #えがけんイラスト練習';

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
          return; // 成功したらここで終了（Web Intentは開かない）
        }
      } catch (error) {
        console.warn('Web Share APIでの画像共有に失敗しました（Web Intentへフォールバックします）:', error);
        // 失敗した場合は、以下のWeb Intent処理へ進む
      }
    }

    // --- Web Intent (PCや非対応ブラウザ用) ---

    // URLエンコード
    const encodedText = encodeURIComponent(shareText);

    // Twitter共有URL
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodedText}`;

    // 新しいタブで開く
    window.open(twitterUrl, '_blank', 'noreferrer');
    setIsSharing(false);
  };

  return (
    <button
      onClick={handleShare}
      disabled={isSharing}
      className="flex items-center justify-center gap-2 rounded-lg bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-100 active:bg-blue-200 disabled:opacity-50 disabled:cursor-wait"
      title="この記録をXで共有"
    >
      <span className="text-base">𝕏</span>
      <span>{isSharing ? '準備中...' : 'Xで共有'}</span>
    </button>
  );
}
