import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
// @ts-expect-error: 型定義がないため
import { ImageResponse } from '@vercel/og';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function GET(
	_req: NextRequest,
	context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
) {
	try {
		// 1. recordId の取得
		let recordId: string;
		if ('then' in context.params && typeof context.params.then === 'function') {
			const resolved = await context.params;
			recordId = resolved.recordId;
		} else {
			recordId = (context.params as { recordId: string }).recordId;
		}
		console.log('[OGP_API] recordId:', recordId);

		// 2. Firestore からデータ取得
		const docRef = doc(db, 'posts', recordId);
		const snap = await getDoc(docRef);

		if (!snap.exists()) {
			console.error('[OGP_API] Record not found');
			return new Response('Not found', { status: 404 });
		}

		const record = snap.data();
		console.log('[OGP_API] record:', record);
		console.log('[OGP_API] weeklyThemeId:', record.weeklyThemeId);

		// 3. バッジ描画条件確認
		const hasWeeklyTheme = !!record.weeklyThemeId;
		if (!hasWeeklyTheme) {
			console.warn('[OGP_API] weeklyThemeId is missing, badge will not be rendered');
		}

		// 4. OGP 画像生成
		return new ImageResponse(
			(
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						position: 'relative',
						width: 1200,
						height: 630,
						background: '#fff',
					}}
				>
					{/* 投稿画像 */}
					{record.imageUrl && (
						<img
							src={record.imageUrl}
							width={540}
							height={540}
							style={{
								objectFit: 'cover',
								borderRadius: 24,
								boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
								background: '#eee',
							}}
							alt="投稿画像"
						/>
					)}

					{/* Weekly Theme バッジ */}
					{hasWeeklyTheme && (
						<div
							style={{
								position: 'absolute',
								top: 30,
								right: 30,
								width: 150,
								height: 150,
								borderRadius: '50%',
								background: 'rgba(255,255,255,0.9)',
								border: '6px solid #3B82F6',
								display: 'flex',
								flexDirection: 'column',
								justifyContent: 'center',
								alignItems: 'center',
								textAlign: 'center',
								color: '#1E3A8A',
								fontFamily: 'sans-serif',
							}}
						>
							<div style={{ fontSize: 12 }}>WEEKLY</div>
							<div style={{ fontSize: 28, fontWeight: 'bold' }}>THEME</div>
							<div style={{ fontSize: 12 }}>JOINED</div>
						</div>
					)}
				</div>
			),
			{ width: 1200, height: 630 }
		);
	} catch (error) {
		console.error('[OGP_API] Error generating image:', error);
		return new Response('Internal Server Error', { status: 500 });
	}
}
