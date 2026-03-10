import NineClient from "./NineClient";

type Props = {
  searchParams: Promise<{
    ids?: string;
  }>;
};

export default async function Page({ searchParams }: Props) {
  const params = await searchParams;
  const ids = params?.ids ?? "";

  return <NineClient ids={ids} />;
}