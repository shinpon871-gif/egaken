# Firebase 詳細セットアップ

「えがけん」でのFirebase初期化とセキュリティ設定の詳細です。

## 📦 Firebase 初期化方法

### /lib/firebase.ts（既存）

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication
export const auth = getAuth(app);

// Initialize Cloud Firestore
export const db = getFirestore(app);

// Initialize Cloud Storage
export const storage = getStorage(app);

export default app;
```

**ポイント：**
- `NEXT_PUBLIC_*` プレフィックスは、クライアント側で安全に使用可能な環境変数
- API Key は公開されても安全（Firebase 側で IP/リファラ制限が可能）
- Firestore と Storage のセキュリティルールでアクセスを制限

## 🔐 Firestore セキュリティルール

### ルール構造

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // records コレクション
    match /records/{document=**} {
      // 読み取り：認証済みユーザーまたは新規作成時
      allow read: if request.auth != null;
      
      // 作成：認証済みかつ userId がログインユーザー
      allow create: if request.auth != null && 
        request.resource.data.userId == request.auth.uid;
      
      // 削除：自分のレコードのみ
      allow delete: if request.auth != null && 
        resource.data.userId == request.auth.uid;
      
      // 更新：禁止（不要なため）
      allow update: if false;
    }
  }
}
```

### ルール詳細説明

| 操作 | 許可条件 | 理由 |
|-----|--------|------|
| read | ログイン済み | 自ユーザーデータのみ表示 |
| list | ログイン済み | 記録一覧表示 |
| create | 認証済み + userId が自分 | 自分の記録のみ作成可能 |
| delete | 認証済み + userId が自分 | 自分の記録のみ削除可能 |
| update | なし | MVP では不要 |

## 🗄️ Cloud Storage セキュリティルール

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // records フォルダ以下
    match /records/{userId}/{filename} {
      // 読み取り：ログイン済みユーザー
      allow read: if request.auth != null;
      
      // アップロード：
      // - ログイン済み
      // - userId が自分
      // - ファイルサイズ < 10MB
      // - 画像ファイルのみ
      allow create: if request.auth != null && 
        request.auth.uid == userId && 
        request.resource.size < 10 * 1024 * 1024 &&
        request.resource.contentType.matches('image/.*');
      
      // 削除：自分のファイルのみ
      allow delete: if request.auth != null && 
        request.auth.uid == userId;
    }
  }
}
```

### ルール詳細説明

| 操作 | 許可条件 | チェック |
|-----|--------|---------|
| read | ログイン済み | - |
| create | ログイン済み + userId 一致 + サイズ < 10MB + image/* | ファイルサイズ制限、型制限 |
| delete | ログイン済み + userId 一致 | - |

## 🔄 Google 認証フロー

### 実装例（/app/(auth)/login/page.tsx）

```typescript
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '@/lib/firebase';

const handleGoogleLogin = async () => {
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    
    if (result.user) {
      // ホーム画面へリダイレクト
      router.push('/dashboard/home');
    }
  } catch (error) {
    console.error('ログインエラー:', error);
  }
};
```

**取得情報：**
- `result.user.uid` - ユーザーID（ユニーク）
- `result.user.email` - メールアドレス
- `result.user.displayName` - 表示名
- `result.user.photoURL` - プロフィール画像

## 📝 Firestore 記録の保存

### 実装例（/components/CreateRecordForm.tsx）

```typescript
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

// レコード作成
await addDoc(collection(db, 'records'), {
  userId: user.uid,                        // ユーザーID
  imageUrl: downloadURL,                   // Storage URL
  comment: comment.trim() || '',           // コメント
  practiceMinutes: parseInt(minutes) || 0, // 練習時間
  createdAt: serverTimestamp(),            // サーバー時刻
});
```

**serverTimestamp() の利点：**
- クライアント側の時刻差に影響されない
- 複数デバイス間で一貫性を確保
- サーバー時刻が基準になるため信頼性が高い

## 📤 Cloud Storage への画像保存

```typescript
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

// ファイルパス：records/{userId}/{timestamp}_{filename}
const fileName = `${user.uid}/${Date.now()}_${selectedFile.name}`;
const storageRef = ref(storage, `records/${fileName}`);

// アップロード
const uploadResult = await uploadBytes(storageRef, selectedFile);

// ダウンロードURL取得
const imageUrl = await getDownloadURL(uploadResult.ref);

// Firestore に URL を保存
await addDoc(collection(db, 'records'), {
  imageUrl: imageUrl,
  // ... その他のフィールド
});
```

## 🔍 リアルタイムリスナー

### 実装例（/components/RecordList.tsx）

```typescript
import { query, where, orderBy, onSnapshot } from 'firebase/firestore';

const q = query(
  collection(db, 'records'),
  where('userId', '==', user.uid),     // 自ユーザーのみ
  orderBy('createdAt', 'desc')          // 新しい順
);

// リアルタイムリスナー
const unsubscribe = onSnapshot(q, (snapshot) => {
  const records = [];
  snapshot.forEach((doc) => {
    records.push({ id: doc.id, ...doc.data() });
  });
  setRecords(records);
});

// クリーンアップ
return () => unsubscribe();
```

## 🔧 開発時の Tips

### Firebase Emulator の使用（オプション）

ローカル開発時、エミュレータを使用すると素早くテスト可能：

```bash
firebase emulators:start
```

### Firestore Console でデータ確認

1. Firebase Console > Firestore Database
2. 「records」コレクション をクリック
3. ドキュメント一覧で保存内容を確認

### セキュリティルールの テスト

```javascript
# コレクション/ドキュメントごとにテスト実行可能
# ルール編集画面の右上「ルールの検証」を使用
```

## ⚠️ よくある問題

### 1. CORS エラーが表示される
**原因：** Storage ルールが厳しすぎる  
**解決：** ルールで読み取りアクセスを許可

### 2. 404 で 画像が表示されない
**原因：** Storage ルールまたはファイルが存在しない  
**解決：**
- ルールを確認
- Firebase Console > Storage でファイル確認

### 3. quota exceeded エラー
**原因：** 無料枠を超過  
**解決：** 課金設定を確認、または不要なデータ削除

## 📊 無料枠（Spark プラン）

| リソース | 制限 |
|---------|------|
| Firestore | 読み取り 50K/日, 書き込み 20K/日, 削除 20K/日 |
| Storage | 5GB |
| Authentication | 無制限 |
| Functions | 125K 呼び出し/月 |

**MVP での推定使用量：**
- ユーザー 1 人，1 日 3-5 記録投稿 → 容易に無料枠内で運用可能

---

質問や問題があれば、Firebase 公式ドキュメントを参照してください。

## 🔎 複合インデックスが必要な場合

Firestore で「The query requires an index.」というエラーが出た場合、複合インデックスを作成する必要があります。

- 手順（Firebase CLI を使用する場合）:

```bash
# 1) Firebase CLI にログイン
firebase login

# 2) プロジェクトを選択（必要に応じて）
firebase use --add

# 3) インデックス情報をデプロイ
firebase deploy --only firestore:indexes
```

- 本リポジトリには `firestore.indexes.json` を追加済みです。Firebase コンソールの表示されるリンクを使って直接作成することもできます。

作成後、クエリは正常に動作します。
