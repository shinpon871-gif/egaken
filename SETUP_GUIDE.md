# 最新セットアップガイド（2026年2月版）

## 重要: OGP・SNS・画像表示の注意点

- OGP画像URLはFirebase Storageの生URLをそのまま使用し、v等のクエリは付与しない。
- ページURL（og:url, canonical）にのみキャッシュバスター（?v=...）を付与。
- 画像アップロード時は `uploadBytes(..., { contentType: file.type })` でMIMEタイプを必ず指定。
- Next.jsのImageタグには `unoptimized` を付与し、Storage画像の互換性を担保。
- CORS設定はGoogle Cloud Shellで明示的に許可（例: `gcloud storage buckets update ... --cors-file=cors.json`）。

## 最新ディレクトリ構成

```Bash
egaken/
├── app/
│   ├── (auth)/login/
│   ├── (dashboard)/home/
│   ├── share/[recordId]/page.tsx
│   ├── ...
│   └── layout.tsx
├── components/
│   ├── CreateRecordForm.tsx
│   ├── SharePostClient.tsx
│   ├── ShareButton.tsx
│   └── ...
├── contexts/
│   └── AuthContext.tsx
├── lib/
│   ├── firebase.ts
│   └── utils.ts
├── public/
│   └── ogp.png
├── OGP_FIX_REPORT.md
├── ...
```

## Firebase初期化（lib/firebase.ts）

```typescript
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
```

## 画像アップロード時の注意

```typescript
await uploadBytes(storageRef, file, { contentType: file.type });
```

## CORS設定（Google Cloud Shell例）

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<your-bucket> --cors-file=cors.json
```

## OGP/SNSキャッシュ対策

- 画像URLはそのまま。ページURLにのみ?v=...を付与。
- 例: `https://egaken.vercel.app/share/ID?v=1234567890`
- `SharePostClient.tsx`のImageタグは`unoptimized`必須。

## Twitter(X)シェア・AIコメント

- シェアボタンは常に最新の?v=...付きURLを生成。
- AIコメントはOpenAI APIで非同期生成、失敗時は定型文返却。

## その他

- 詳細な運用・障害対応・OGP/SNSトラブルシュートはOGP_FIX_REPORT.md参照。

---

Happy drawing! 🎨
