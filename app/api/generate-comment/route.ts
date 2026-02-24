import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// --- CHARACTER_CONFIG: データのみ、処理コード混入禁止 ---
const CHARACTER_CONFIG = {
  strategist: {
    prompt: `知的で優しい参謀タイプ。
落ち着いた丁寧語で分析しながら褒める。
成長を見守る姿勢。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "着実に積み重ねていますね。この調子で続けていきましょう。",
  },
  genki: {
    prompt: `元気いっぱいのスポーツ少女。
テンション高めで努力を全力で褒める。
最後は「次も一緒にがんばろう！」で締める。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "すごいよ！今日もよく頑張ったね！次も一緒にがんばろう！",
  },
  cool: {
    prompt: `クールで無口。
短文。
そっけないが核心を突く。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "……悪くない。",
  },
  oneesan: {
    prompt: `包容力のあるお姉さん。
やさしい語尾。
「あなたのペースで大丈夫よ」を含める。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "大丈夫、あなたのペースでいいのよ。ちゃんと前に進んでるわ。",
  },
  chuunibyou: {
    prompt: `中二病キャラクター。
大げさな比喩表現。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "その筆致…覚醒の兆し…！",
  },
  mascot: {
    prompt: `ゆるふわマスコット。
赤ちゃん言葉。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "がんばったね〜えらいよ〜！",
  },
  sensei: {
    prompt: `優しい美術講師。
教育的で丁寧。
改善点も軽く触れる。
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度
`,
    fallback: "よく描けていますね。次は形のバランスも意識してみましょう。",
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(request: NextRequest) {
  // ---- bodyを安全に1回だけ取得 ----
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }


  const imageUrl = body.imageUrl || "";
  const practiceMinutes = body.practiceMinutes || 0;

  type CharacterType = keyof typeof CHARACTER_CONFIG;
  const rawType = body.characterType;
  const characterType: CharacterType =
    typeof rawType === "string" && rawType in CHARACTER_CONFIG
      ? (rawType as CharacterType)
      : "strategist";

  const config = CHARACTER_CONFIG[characterType];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        {
          role: "system",
          content: config.prompt,
        },
        {
          role: "user",
          content: `お絵描き練習をしました。
練習時間: ${practiceMinutes}分

努力を前向きに褒めてください。
コメントは2〜4文程度。`,
        },
      ],
    });

    const comment =
      completion.choices[0]?.message?.content || config.fallback;

    return NextResponse.json({ comment });
  } catch (error) {
    console.error("AI生成エラー:", error);
    return NextResponse.json({
      comment: config.fallback,
    });
  }
}