import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
// @ts-expect-error: 型定義がないため
import { ImageResponse } from '@vercel/og';
import type { NextRequest } from 'next/server';

export async function GET(
	_req: NextRequest,
	context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
) {
	let recordId: string;
	if ('then' in context.params && typeof context.params.then === 'function') {
		// params is Promise<{ recordId: string }>
		const resolved = await context.params;
		recordId = resolved.recordId;
	} else {
		// params is { recordId: string }
		recordId = (context.params as { recordId: string }).recordId;
	}
	const docRef = doc(db, 'posts', recordId);
	const snap = await getDoc(docRef);
	if (!snap.exists()) {
		return new Response('Not found', { status: 404 });
	}
	const record = snap.data();

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
				{/* 投稿画像を中央に表示 */}
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
				{/* Weekly Themeバッジ */}
				{record.weeklyThemeId && (
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
}
