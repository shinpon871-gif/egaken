'use client';

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Firebase Storage セキュリティルール診断用コンポーネント
 */
export function FirebaseSecurityDiagnostic() {
  const { user } = useAuth();
  const [imageUrl, setImageUrl] = useState<string>('');
  const [testResult, setTestResult] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  const testImageUrl = async () => {
    if (!imageUrl.trim()) {
      setTestResult('URLを入力してください');
      return;
    }

    setIsLoading(true);
    setTestResult('テスト中...');

    try {
      const response = await fetch(imageUrl, {
        method: 'HEAD',
        mode: 'no-cors', // CORSエラーを避けるため
      });

      setTestResult(`✅ URL acceible\nStatus: ${response.status}\nType: ${response.type}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setTestResult(`❌ エラー: ${errorMsg}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 bg-gray-900 text-white text-xs p-3 rounded max-w-xs z-50 max-h-96 overflow-auto">
      <p className="font-bold mb-2">🔧 Firebase Storage 診断</p>
      <p className="text-gray-300 mb-2">User: {user.uid?.substring(0, 8)}...</p>
      <textarea
        value={imageUrl}
        onChange={(e) => setImageUrl(e.target.value)}
        placeholder="Firebase Storage URL を貼り付け"
        className="w-full bg-gray-800 text-white text-xs p-2 rounded mb-2 border border-gray-600 h-16"
      />
      <button
        onClick={testImageUrl}
        disabled={isLoading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white text-xs py-1 rounded mb-2"
      >
        {isLoading ? 'テスト中...' : 'テスト'}
      </button>
      <pre className="bg-gray-800 p-2 rounded text-gray-300 text-xs whitespace-pre-wrap">
        {testResult}
      </pre>
    </div>
  );
}
