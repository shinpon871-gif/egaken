
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId: string };
};

export default function SharePage({ params }: Props) {
  const { recordId } = params;
  if (!recordId) return <p>Record ID が指定されていません</p>;

  return <SharePostClient recordId={recordId} />;
}
