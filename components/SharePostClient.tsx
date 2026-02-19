// SharePostClient: 画像URLをencodeURIComponentで共有URLに埋め込むだけ
'use client';

function createShareUrl(recordId: string, imageUrl: string) {
  const encodedImg = encodeURIComponent(imageUrl);
  const ts = Date.now(); // キャッシュ回避
  return `/share/${recordId}?img=${encodedImg}&v=${ts}`;
}

interface Props {
  recordId: string;
  imageUrl: string;
}

export default function SharePostClient({ recordId, imageUrl }: Props) {
  return (
    <button
      onClick={() => {
        const shareUrl = createShareUrl(recordId, imageUrl);
        const intent = `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}`;
        window.open(intent, '_blank');
      }}
    >
      Xで共有
    </button>
  );
}
