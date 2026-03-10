"use client";

type Props = {
  ids: string;
};

export default function NineClient({ ids }: Props) {
  if (!ids) {
    return <div style={{ padding: 40 }}>ids が指定されていません</div>;
  }

  const gridUrl = `/api/grid?ids=${ids}`;

  const tweetUrl =
    "https://twitter.com/intent/tweet" +
    "?text=" +
    encodeURIComponent("#えがけん最近描いた絵9選") +
    "&url=" +
    encodeURIComponent(
      `https://egaken.vercel.app/nine?ids=${ids}`
    );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "20px",
        padding: "40px",
      }}
    >
      <h1>#えがけん最近描いた絵9選</h1>

      <img
        src={gridUrl}
        width={600}
        alt="9 grid"
        style={{
          border: "1px solid #ddd",
        }}
      />

      <a
        href={tweetUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          background: "#1DA1F2",
          color: "#fff",
          padding: "12px 24px",
          borderRadius: "8px",
          textDecoration: "none",
          fontWeight: "bold",
        }}
      >
        Xに投稿する
      </a>
    </div>
  );
}