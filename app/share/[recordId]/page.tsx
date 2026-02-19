export const dynamic = 'force-static';

import SharePostClient from './SharePostClient';

export default function Page({ params }: { params: { recordId: string } }) {
  const url = `https://egaken.vercel.app/share/${params.recordId}`;
  const imageUrl = `https://egaken.vercel.app/ogp.png`;

  return (
    <>
      <head>
        <title>えがけん記録</title>

        <meta property="og:title" content="えがけん記録" />
        <meta property="og:description" content="今日のイラスト練習記録" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={imageUrl} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="えがけん記録" />
        <meta name="twitter:description" content="今日のイラスト練習記録" />
        <meta name="twitter:image" content={imageUrl} />
      </head>

      <SharePostClient recordId={params.recordId} />
    </>
  );
}
