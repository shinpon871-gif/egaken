type Props = { params: { recordId: string }; searchParams?: { v?: string } };

export function generateMetadata({ params }: Props): Metadata {
  const recordId = params.recordId;
  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url: `https://egaken.vercel.app/share/${recordId}`,
      type: 'website',
      images: [{ url: '/ogp.png', width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: ['/ogp.png'],
    },
  };
}

export default function Page({ params, searchParams }: Props) {
  const { recordId } = params;
  const { v } = searchParams || {};

  if (!recordId) return <div>Record ID が指定されていません</div>;

  // client component に props で recordId と query を渡す
  return <SharePostClient recordId={recordId} version={v} />;
}
