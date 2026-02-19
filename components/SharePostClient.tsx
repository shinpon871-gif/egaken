// SharePostClient: 画像URLを短縮し共有ボタンに渡す
'use client';
import { useMemo } from 'react';
import { ShareButton } from './ShareButton';

// 簡易ハッシュ関数（依存なし）
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// グローバルMapに画像URLを登録
function registerImageUrl(imageUrl: string): string {
  const hash = simpleHash(imageUrl);
  if (typeof window !== 'undefined') {
    // クライアント側でwindow経由でAPIに登録（本来はAPI推奨だが依存禁止のため）
    fetch(`/i/${hash}?set=${encodeURIComponent(imageUrl)}`);
  }
  return hash;
}

interface Props {
  recordId: string;
  imageUrl: string;
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
}

export default function SharePostClient(props: Props) {
  // 画像URLを短縮し、ShareButtonに渡す
  const hash = useMemo(() => registerImageUrl(props.imageUrl), [props.imageUrl]);
  const shortUrl = `/i/${hash}`;
  return (
    <ShareButton
      recordId={props.recordId}
      comment={props.comment}
      practiceMinutes={props.practiceMinutes}
      aiComment={props.aiComment}
      imageUrl={shortUrl}
    />
  );
}
