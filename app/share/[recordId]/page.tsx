
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId?: string };
  searchParams?: { v?: string };
};

export default function SharePage({ params, searchParams }: Props) {
  const recordId = params?.recordId;
  const version = searchParams?.v;

  // recordIdが未定義の場合はSharePostClient側でエラー表示
  return <SharePostClient recordId={recordId} version={version} />;
}
