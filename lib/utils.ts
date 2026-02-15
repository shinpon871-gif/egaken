import { Timestamp } from 'firebase/firestore';

/**
 * Firestoreのタイムスタンプを日本語形式の日時文字列に変換
 */
export function formatTimestamp(timestamp: Timestamp | null): string {
  if (!timestamp) return '';
  
  const date = timestamp.toDate();
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * タイムスタンプを「2日前」のような相対時間表現に変換
 */
export function formatRelativeTime(timestamp: Timestamp | null): string {
  if (!timestamp) return '';

  const date = timestamp.toDate();
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return '今';
  if (diffMins < 60) return `${diffMins}分前`;
  if (diffHours < 24) return `${diffHours}時間前`;
  if (diffDays < 30) return `${diffDays}日前`;

  return formatTimestamp(timestamp);
}

/**
 * ファイルサイズをMB/KB表記に変換
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
