import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  // APIキーの確認
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: 'OpenAI APIキーが設定されていません' },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const { comment, practiceMinutes } = body;

    // プロンプトの作成
    const prompt = `あなたはお絵描きを応援する優しいトレーナーです。
以下の情報をもとに、評価や点数は使わず、励ましと継続を促す短い日本語コメント（1〜2文）を作成してください。

情報：
- ユーザーコメント: ${comment || 'なし'}
- 練習時間: ${practiceMinutes ? practiceMinutes + '分' : '記録なし'}

条件：
- 上から目線にしない
- 批判しない
- 「昨日の自分より一歩前進」というニュアンス
- 40〜80文字程度

レスポンスは、コメントのみを返してください。それ以外の補足や説明は不要です。`;

    // OpenAI APIを呼び出し（GPT-4oを使用）
    const message = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // レスポンスからテキストを抽出
    const aiComment =
      message.choices[0].message.content || '';

    return NextResponse.json({ aiComment }, { status: 200 });
  } catch (error: any) {
    console.error('AIコメント生成エラー:', error);

    // APIエラー（クォータ不足など）時は定型文を返して動作を継続させる
    const fallbackComments = [
      "継続は力なり！今日も素晴らしい記録です。",
      "コツコツ積み重ねることが上達への近道です。ナイスファイト！",
      "その調子です！昨日の自分より確実に前進しています。",
      "描くことを楽しむのが一番の上達法です。お疲れ様でした！"
    ];
    const randomComment = fallbackComments[Math.floor(Math.random() * fallbackComments.length)];

    return NextResponse.json(
      { aiComment: randomComment },
      { status: 200 }
    );
  }
}
