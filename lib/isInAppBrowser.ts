/**
 * Xアプリ内ブラウザの判定ロジック
 * userAgent を検査して、X（旧Twitter）アプリ内ブラウザからのアクセスを検知する
 */

// 標準ブラウザのキーワード（これらが含まれていれば通常ブラウザ）
const STANDARD_BROWSER_KEYWORDS = ['Safari', 'Chrome', 'Firefox', 'Edge'];

// X（Twitter）アプリ内ブラウザの判定に使うキーワード
const X_APP_BROWSER_KEYWORDS = ['Twitter', 'X'];

/**
 * 現在のブラウザがXアプリ内ブラウザかどうかを判定
 * @returns true の場合、Xアプリ内ブラウザ
 */
export function isInXAppBrowser(): boolean {
  // サーバーサイド環境では実行しない
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = window.navigator.userAgent;

  // 標準ブラウザが含まれている場合は通常ブラウザと判定
  if (STANDARD_BROWSER_KEYWORDS.some((keyword) => userAgent.includes(keyword))) {
    return false;
  }

  // Xアプリ内ブラウザのキーワードが含まれている場合はアプリ内ブラウザ
  return X_APP_BROWSER_KEYWORDS.some((keyword) =>
    userAgent.includes(keyword)
  );
}

/**
 * サーバーサイドでuserAgentからXアプリ内ブラウザをチェック
 * @param userAgent userAgent文字列
 * @returns true の場合、Xアプリ内ブラウザ
 */
export function isXAppBrowserFromUserAgent(userAgent: string): boolean {
  // 標準ブラウザが含まれている場合は通常ブラウザと判定
  if (STANDARD_BROWSER_KEYWORDS.some((keyword) => userAgent.includes(keyword))) {
    return false;
  }

  // Xアプリ内ブラウザのキーワードが含まれている場合はアプリ内ブラウザ
  return X_APP_BROWSER_KEYWORDS.some((keyword) =>
    userAgent.includes(keyword)
  );
}
