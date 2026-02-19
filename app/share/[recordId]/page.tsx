
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId: string };
  searchParams?: { v?: string };
};

export default function SharePage({ params, searchParams }: Props) {
  return (
    <SharePostClient
      recordId={params.recordId}
      version={searchParams?.v}
    />
  );
}
