# Firebase 詳細セットアップ

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

---

詳細は [OGP_FIX_REPORT.md](./OGP_FIX_REPORT.md) も参照。
