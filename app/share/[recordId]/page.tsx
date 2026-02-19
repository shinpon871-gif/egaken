export const dynamic = 'force-static';

export async function generateMetadata({ params }) {
  const url = `https://egaken.vercel.app/share/${params.recordId}`;

  return {
    title: 'えがけん',
    description: 'お絵描き記録',
    openGraph: {
      title: 'えがけん',
      description: 'お絵描き記録',
      url,
      images: ['https://egaken.vercel.app/ogp.png'],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん',
      description: 'お絵描き記録',
      images: ['https://egaken.vercel.app/ogp.png'],
    },
  };
}

import SharePostClient from './SharePostClient';

export default function Page({ params }) {
  const url = `https://egaken.vercel.app/share/${params.recordId}`;
  const imageUrl = `https://egaken.vercel.app/ogp.png`;

  return (
    <>
      <SharePostClient recordId={params.recordId} />
    </>
  );
}
