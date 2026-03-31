import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { isXAppBrowserFromUserAgent } from "@/lib/isInAppBrowser";

// --- CHARACTER_CONFIG: データのみ、処理コード混入禁止 ---
const CHARACTER_CONFIG = {
  strategist: {
    prompt: `知的で優しい参謀タイプ。
落ち着いた丁寧語で分析しながら褒める。
成長を見守る姿勢。
    - 批判しない
    - 「昨日の自分より一歩前進」というニュアンス
    - 40〜80文字程度
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
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
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
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
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
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
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
`,
    fallback: "大丈夫、あなたのペースでいいのよ。ちゃんと前に進んでるわ。",
  },
  chuunibyou: {
    prompt: `中二病キャラクター。
大げさな比喩表現。
    - 批判しない
    - 「昨日の自分より一歩前進」というニュアンス
    - 40〜80文字程度
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
`,
    fallback: "その筆致…覚醒の兆し…！",
  },
  mascot: {
    prompt: `ゆるふわマスコット。
赤ちゃん言葉。
    - 批判しない
    - 「昨日の自分より一歩前進」というニュアンス
    - 40〜80文字程度
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
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
    ・ユーザーの「工夫した点」を必ず具体的に褒める
    ・抽象的な一般論は禁止
`,
    fallback: "よく描けていますね。次は形のバランスも意識してみましょう。",
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(request: NextRequest) {
  // ---- Xアプリ内ブラウザからのリクエストをブロック ----
  const userAgent = request.headers.get("user-agent") || "";
  if (isXAppBrowserFromUserAgent(userAgent)) {
    return NextResponse.json(
      {
        error: "Xアプリ内ブラウザからの投稿はできません",
        message: "SafariやChromeなどの通常のブラウザでお試しください",
      },
      { status: 403 }
    );
  }

  // ---- bodyを安全に1回だけ取得 ----
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const practiceMinutes = body.practiceMinutes || 0;
  const comment = body.comment || "";

  type CharacterType = keyof typeof CHARACTER_CONFIG;
  const rawType = body.characterType;
  const characterType: CharacterType =
    typeof rawType === "string" && rawType in CHARACTER_CONFIG
      ? (rawType as CharacterType)
      : "strategist";

  const config = CHARACTER_CONFIG[characterType];

  try {
    // コメント内容を必ず参照するプロンプトに統一
    const userMessage = `\nユーザーはお絵描き練習をしました。\n\n練習時間: ${practiceMinutes}分\nコメント・工夫した点:\n${comment || "（特に記載なし）"}\n\n【絶対条件】\n・「コメント・工夫した点」の内容に必ず具体的に触れる\n・可能なら一部を引用する\n・抽象的な褒めは禁止\n・努力と挑戦を認める\n・上から目線禁止\n・2〜4文\n`;
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
          content: userMessage,
        },
      ],
    });

    const aiComment =
      completion.choices[0]?.message?.content || config.fallback;

    return NextResponse.json({ aiComment });
  } catch (error) {
    console.error("AI生成エラー:", error);
    return NextResponse.json({
      aiComment: config.fallback,
    });
  }
}