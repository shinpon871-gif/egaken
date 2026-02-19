// SharePostClient: 画像URLをencodeURIComponentで共有URLに埋め込むだけ
'use client';

interface Props {
  recordId: string;
  imageUrl: string;
  comment: string;
  practiceMinutes: number;
  aiComment?: string;
}

function createShareUrl(recordId: string, imageUrl: string) {
  // 軽量化のためBase64やハッシュ化は行わず、URLをそのままクエリに
  const encodedImg = encodeURIComponent(imageUrl);
  const ts = Date.now(); // キャッシュ回避
  return `/share/${recordId}?img=${encodedImg}&v=${ts}`;
}

export default function SharePostClient(props: Props) {
  const shareUrl = createShareUrl(props.recordId, props.imageUrl);
  // X投稿ボタン例
  return (
    <button
      onClick={() => {
        const intent = `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}`;
        window.open(intent, '_blank');
      }}
    >
      Xで共有
    </button>
  );
}
