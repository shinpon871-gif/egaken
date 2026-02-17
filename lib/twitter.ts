/**
 * Twitter投稿文字数チェックと投稿テキスト生成関数
 */

interface GenerateTweetTextResult {
  text: string;
  length: number;
  isWarning: boolean;
  isOverLimit: boolean;
}

const MAX_CHAR_LIMIT = 140;
const WARNING_THRESHOLD = 120;

/**
 * Twitter投稿テキストを生成し、文字数情報を返す
 * @param minutes - 練習時間（分）
 * @param userComment - ユーザーのコメント
 * @param imageUrl - 画像URL（オプション）
 * @returns 投稿テキスト、文字数、警告フラグ、超過フラグ
 */
export function generateTweetText(
  minutes: number,
  userComment: string,
  imageUrl?: string
): GenerateTweetTextResult {
  // 投稿テンプレートを構築
  let text = '#えがけん記録\n';
  text += `練習時間: ${minutes}分\n`;
  text += `${userComment}\n`;
  text += '\n#えがけん';

  // 画像URLがあれば末尾に追加
  if (imageUrl) {
    text += `\n${imageUrl}`;
  }

  // 文字数をカウント（改行も1文字）
  const length = text.length;

  // 警告フラグと超過フラグを判定
  const isWarning = length >= WARNING_THRESHOLD && length <= MAX_CHAR_LIMIT;
  const isOverLimit = length > MAX_CHAR_LIMIT;

  return {
    text,
    length,
    isWarning,
    isOverLimit,
  };
}

/**
 * AIコメントを含まない投稿テキストのみを生成
 * @param minutes - 練習時間（分）
 * @param userComment - ユーザーのコメント
 * @returns 投稿テキスト
 */
export function generateTweetTextOnly(minutes: number, userComment: string): string {
  let text = '#えがけん記録\n';
  text += `練習時間: ${minutes}分\n`;
  text += `${userComment}\n`;
  text += '\n#えがけん';
  return text;
}

/**
 * テキストの文字数をカウント
 * @param text - カウント対象のテキスト
 * @returns 文字数
 */
export function countCharacters(text: string): number {
  return text.length;
}

/**
 * Twitter投稿可能か判定
 * @param text - 投稿テキスト
 * @returns 投稿可能ならtrue
 */
export function isPostable(text: string): boolean {
  return text.length <= MAX_CHAR_LIMIT;
}

/**
 * 文字数警告が必要か判定
 * @param text - 投稿テキスト
 * @returns 警告が必要ならtrue
 */
export function needsWarning(text: string): boolean {
  const length = text.length;
  return length >= WARNING_THRESHOLD && length <= MAX_CHAR_LIMIT;
}
