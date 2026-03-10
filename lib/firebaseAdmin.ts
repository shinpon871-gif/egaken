import admin from 'firebase-admin'
import path from 'path'
import fs from 'fs' // 追加

let adminDb: admin.firestore.Firestore | null = null

try {
  let serviceAccount: any = null

  try {
    // 環境変数から読み込む場合（本番用）
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
    if (key) {
      serviceAccount = JSON.parse(key)
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key
          .replace(/^["']|["']$/g, '') // 前後の引用符削除
          .replace(/\\n/g, '\n')      // 改行コード置換
      }
      console.log('[FIREBASE_ADMIN] 環境変数から読み込み成功')
    } else {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY が未設定')
    }
  } catch (envErr) {
    // ローカル JSON ファイルから読み込む
    try {
      const jsonPath = path.join(process.cwd(), 'egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json')
      const fileContent = fs.readFileSync(jsonPath, 'utf8')
      serviceAccount = JSON.parse(fileContent)
      console.log('[FIREBASE_ADMIN] ローカル JSON 読み込み成功')
    } catch (jsonErr) {
      console.error('[FIREBASE_ADMIN] JSON ファイル読み込み失敗', jsonErr)
      throw envErr
    }
  }

  // Admin SDK 初期化（既に初期化済みであれば再初期化しない）
  if (!admin.apps.length && serviceAccount) {
    const storageBucket =
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
      `${serviceAccount.project_id}.appspot.com`

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
      storageBucket,
    })

    console.log('[FIREBASE_ADMIN] Firebase Admin SDK 初期化完了')
  }

  // Firestore インスタンス取得
  adminDb = admin.firestore()
  // gRPCエラー回避: REST経由でFirestoreを動かす
  adminDb.settings({ experimentalForceLongPolling: true, useFetchStreams: true })
} catch (err) {
  console.error('[FIREBASE_ADMIN] Firebase Admin SDK 初期化エラー:', err)
  adminDb = null
}

export { adminDb, admin }