'use client';

import { useEffect, useState } from 'react';

export default function DebugThemePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDebugData = async () => {
      try {
        const response = await fetch('/api/debug-theme');
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const result = await response.json();
        setData(result);
        
        // コンソールにも出力
        console.log('[DebugThemePage] 取得データ:', result);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    fetchDebugData();
  }, []);

  if (loading) return <div className="p-6">読み込み中...</div>;
  if (error) return <div className="p-6 text-red-600">エラー: {error}</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">お題デバッグ情報</h1>
      
      <div className="mb-6 p-4 bg-gray-100 rounded">
        <p className="font-semibold">現在時刻（サーバー）:</p>
        <p className="font-mono">{data?.currentTime}</p>
      </div>

      <div className="space-y-6">
        {data?.themes?.map((theme: any) => (
          <div key={theme.id} className="p-4 border rounded">
            <h2 className="text-lg font-bold mb-2">{theme.title}</h2>
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-semibold text-gray-700">開始時刻 (startAt):</p>
                <p className="font-mono text-xs break-all">{theme.startAt.iso || 'null'}</p>
                <p className="text-gray-600 text-xs">ms: {theme.startAt.milliseconds}</p>
              </div>

              <div>
                <p className="font-semibold text-gray-700">終了時刻 (endAt):</p>
                <p className="font-mono text-xs break-all">{theme.endAt.iso || 'null'}</p>
                <p className="text-gray-600 text-xs">ms: {theme.endAt.milliseconds}</p>
              </div>
            </div>

            <div className="mt-4 p-3 bg-blue-50 rounded text-sm">
              <p>
                {data?.currentTime && theme.startAt.iso && theme.endAt.iso ? (
                  <>
                    <span>開始は現在より前？ </span>
                    <span className={new Date(theme.startAt.iso) <= new Date(data.currentTime) ? 'text-green-600' : 'text-red-600'}>
                      {new Date(theme.startAt.iso) <= new Date(data.currentTime) ? '✓ Yes' : '✗ No'}
                    </span>
                    <br />
                    <span>終了は現在より後？ </span>
                    <span className={new Date(data.currentTime) <= new Date(theme.endAt.iso) ? 'text-green-600' : 'text-red-600'}>
                      {new Date(data.currentTime) <= new Date(theme.endAt.iso) ? '✓ Yes' : '✗ No'}
                    </span>
                  </>
                ) : (
                  '日時データなし'
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 p-4 bg-yellow-50 border border-yellow-200 rounded">
        <p className="font-semibold mb-2">デバッグ手順:</p>
        <ol className="list-decimal list-inside space-y-1 text-sm">
          <li>ブラウザのコンソールを開く（F12）</li>
          <li>このページを表示して、上記の値を確認</li>
          <li>ホームページを開いて、コンソールの「[getCurrentWeeklyTheme]」ログを確認</li>
          <li>時刻が正しく比較されているか確認</li>
        </ol>
      </div>
    </div>
  );
}
