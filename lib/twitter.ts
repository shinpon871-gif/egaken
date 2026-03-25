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
 * @param postUrl - 記録詳細ページのURL（オプション）
 * @param trainingDays - 通算日数（オプション）
 * @returns 投稿テキスト、文字数、警告フラグ、超過フラグ
 */
export function generateTweetText(
  minutes: number,
  userComment: string,
  postUrl?: string,
  trainingDays?: number
): GenerateTweetTextResult {
  // 投稿テンプレートを構築
  let text = '#えがけん記録\n';
  
  // 練習時間と通算日数を同じ行に表示
  let practiceInfo = `練習時間: ${minutes}分`;
  if (trainingDays && trainingDays > 0) {
    practiceInfo += ` / 通算 ${trainingDays}日目`;
  }
  text += practiceInfo + '\n';
  
  text += `${userComment}\n`;
  text += '\n#えがけん';

  // 記録詳細ページのURLがあれば末尾に追加
  if (postUrl) {
    text += `\n${postUrl}`;
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
