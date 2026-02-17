/**
 * Twitter投稿文字数チェックと投稿テキスト生成関数
 */

interface GenerateTweetTextResult {
  text: string;
  length: number;
  isWarning: boolean;
  isOverLimit: boolean;
  shortUrl?: string;
}

const MAX_CHAR_LIMIT = 140;
const WARNING_THRESHOLD = 120;

/**
 * URLを短縮URLに置き換え（is.gd APIを使用）
 * @param url - 元のURL
 * @returns 短縮済みURL、または元のURL（失敗時）
 */
export async function shortenUrl(url: string): Promise<string> {
  if (!url) return url;
  
  try {
    // is.gd APIを使用してURLを短縮（CORS対応）
    const response = await fetch('https://is.gd/create.php?format=json&url=' + encodeURIComponent(url), {
      method: 'GET',
    });
    
    if (!response.ok) {
      console.warn('URL短縮失敗:', response.statusText);
      return url;
    }

    const data = await response.json();
    
    // 有効なURLが返されたか確認
    if (data.shorturl) {
      return data.shorturl;
    }
    
    console.warn('URL短縮エラー: 短縮URLが返されませんでした', data);
    return url;
  } catch (error) {
    console.warn('URL短縮エラー:', error);
    // フォールバック: 元のURLを使用
    return url;
  }
}

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
 * Twitter投稿テキストを生成（画像URLを短縮URLに置き換え）
 * @param minutes - 練習時間（分）
 * @param userComment - ユーザーのコメント
 * @param imageUrl - 画像URL（オプション）
 * @returns 投稿テキスト、文字数、警告フラグ、超過フラグ、短縮URL
 */
export async function generateTweetTextWithShortUrl(
  minutes: number,
  userComment: string,
  imageUrl?: string
): Promise<GenerateTweetTextResult> {
  // 投稿テンプレートを構築
  let text = '#えがけん記録\n';
  text += `練習時間: ${minutes}分\n`;
  text += `${userComment}\n`;
  text += '\n#えがけん';

  let shortUrl = '';

  // 画像URLがあれば短縮URLに置き換えて末尾に追加
  if (imageUrl) {
    shortUrl = await shortenUrl(imageUrl);
    text += `\n${shortUrl}`;
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
    shortUrl,
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
