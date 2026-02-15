# 🚀 クイックスタート

「えがけん」MVP を素早くセットアップして動作確認するための手順です。

## 📋 準備物

- Node.js 18 以上
- Google アカウント
- Firebase プロジェクト（無料）

## ⚡ 5分でスタート

### 1. Firebase プロジェクト作成（2分）

```
1. https://console.firebase.google.com にアクセス
2. 「プロジェクトを作成」
3. プロジェクト名: egaken
4. Google Analytics: オフでOK
5. 「プロジェクトを作成」をクリック
```

### 2. Firebase サービス有効化（1分）

**Authentication:**
- ビルド > Authentication
- 「Start」 > Google > 有効化

**Firestore Database:**
- ビルド > Firestore Database
- 「データベースを作成」
- ロケーション: asia-northeast1（東京）
- テスト モード で開始

**Cloud Storage:**
- ビルド > Storage
- 「始める」

> 注意: 一部の環境では `Storage を使用するには、プロジェクトの料金プランをアップグレードしてください` のようなメッセージが出ることがあります。以下を参照して回避してください。

### Storage の料金プラン表示が出るときの対処

- 原因の例:
  - Firebase Console ではなく GCP（Google Cloud Console）側でバケット作成を試みたため課金アカウントが必要になった。
  - 組織ポリシーやプロジェクト作成時の設定により、無料プラン（Spark）での Storage 作成が制限されている。

- 回避策（開発中・MVP 向け）:
  1. まず Firebase コンソールの `Build > Storage > Get started`（Firebase の「始める」フロー）から作成を試みる。通常は Spark（無料）でバケットが作成できます。
  2. それでも同じメッセージが出る場合は、ローカルで Firebase Emulator を使って開発を進める（本番デプロイ前は実際の Cloud Storage に切り替え）。
     - エミュレータを使う利点: 実際の課金を必要とせず Storage/Firestore/Auth をローカルで試せます。

#### Firebase Emulator を使った開発（推奨・無料）

1) `firebase-tools` をインストール（グローバル推奨）:

```bash
# グローバルインストール（必要な場合）
npm install -g firebase-tools
```

2) プロジェクトルートでエミュレータを初期化（まだ未実行なら）:

```bash
firebase init emulators
```

3) エミュレータを起動（Firestore, Storage, Auth のみ）:

```bash
firebase emulators:start --only firestore,storage,auth
```

4) 開発用に `lib/firebase.ts` の初期化を切り替える（条件でエミュレータに接続）か、端末で `FIREBASE_FIRESTORE_EMULATOR_HOST` 等の環境変数を設定して接続します。

- 回避策（本番準備が必要な場合）:
  - 本当にクラウド Storage を利用する場合は、プロジェクトに課金アカウント（Blaze）を紐づけます。Blaze は従量課金ですが、少量なら無料枠内での利用も可能です。課金を有効にする前に使用量とコストを確認してください。

---

### 3. 環境変数設定（1分）

Firebase Console > プロジェクト設定 > アプリから以下をコピー：

```bash
# .env.local を編集
cp .env.local.example .env.local
```

```
NEXT_PUBLIC_FIREBASE_API_KEY=〇〇
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=〇〇
NEXT_PUBLIC_FIREBASE_PROJECT_ID=〇〇
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=〇〇
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=〇〇
NEXT_PUBLIC_FIREBASE_APP_ID=〇〇
```

### 4. 依存パッケージインストール（1分）

```bash
npm install
```

### 5. ローカルサーバー起動

```bash
npm run dev
```

ブラウザで **[http://localhost:3000](http://localhost:3000)** を開く

## ✅ 動作確認チェック

| 項目 | 確認内容 |
|-----|--------|
| 1️⃣ リダイレクト | トップページから login 画面へ自動遷移 |
| 2️⃣ ログイン | 「Googleでログイン」で Google アカウント選択 |
| 3️⃣ ホーム表示 | ダッシュボードレイアウト表示（ヘッダーあり） |
| 4️⃣ 投稿フォーム | ✏️「今日の記録」ボタンクリック → フォーム表示 |
| 5️⃣ 画像選択 | 画像を選択 → プレビュー表示 |
| 6️⃣ 投稿 | 「記録を保存」をクリック → 保存成功 |
| 7️⃣ 一覧反映 | ホーム画面に投稿が新しい順で表示 |
| 8️⃣ 削除 | 記録の「削除」ボタン → 一覧から削除 |
| 9️⃣ ログアウト | ヘッダーの「ログアウト」 → login 画面へ |

## 🔐 Firestore セキュリティルール設定（重要！）

**現在はテスト モード なので、セキュリティが甘いです。**  
本運用前に必ず設定してください。

### Firestore ルール設定

Firebase Console > Firestore Database > Rules タブ：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /records/{document=**} {
      allow read, delete: if request.auth != null && 
        (request.auth.uid == resource.data.userId || !exists(resource));
      allow create: if request.auth != null && 
        request.resource.data.userId == request.auth.uid;
    }
  }
}
```

「公開」をクリック

### Storage ルール設定

Firebase Console > Storage > Rules タブ：

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /records/{userId}/{filename} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && 
        request.auth.uid == userId && 
        request.resource.size < 10 * 1024 * 1024;
      allow delete: if request.auth != null && 
        request.auth.uid == userId;
    }
  }
}
```

「公開」をクリック

## 🧪 テストシナリオ

### シナリオ 1: 新規登録 → 投稿

```
1. ログイン画面で「Googleでログイン」
2. Google アカウント選択
3. ホーム画面表示確認
4. 「今日の記録」ボタン クリック
5. 画像選択
6. コメント: 「猫のイラスト」
7. 練習時間: 30
8. 「記録を保存」クリック
9. フォームが閉じて、一覧に即座に表示されるか確認
```

### シナリオ 2: 複数投稿

```
1. もう一度「今日の記録」 → 投稿
2. さらにもう一度投稿
3. 新しい順に表示されているか確認
4. 画像、コメント、時刻 が正しく表示されているか確認
```

### シナリオ 3: 削除

```
1. 記録の「削除」ボタンをクリック
2. 確認ダイアログで「OK」
3. 一覧から削除されるか確認
```

### シナリオ 4: ログアウト

```
1. ヘッダーの「ログアウト」をクリック
2. ログイン画面へ遷移するか確認
3. ブラウザ戻るボタンで戻れないか確認
```

## 🐛 トラブルシューティング

### ログイン画面が表示されない
```bash
# キャッシュクリア
rm -rf .next
npm run dev

# ターミナルのエラーログ確認
```

### 「500 エラー」が表示される
```bash
# コンソール（F12）でエラーメッセージ確認
# 環境変数が正しく設定されているか確認
```

### 画像がアップロードできない
- Storage ルールが正しく設定されているか確認
- 画像サイズが 10MB 以下か確認
- ブラウザコンソール（F12）でエラーを確認

### Firestore に レコードが保存されない
- Firestore ルールが正しく設定されているか確認
- ユーザーが認証済みか確認（ログイン直後か確認）
- Firebase Console > Firestore > 「Data」で確認

## 📊 Firebase Console で 確認

各機能が正常に動作しているか以下で確認可能：

### Authentication
```
ビルド > Authentication > Users タブ
→ Google でログインしたユーザーが表示される
```

### Firestore
```
ビルド > Firestore Database > Data タブ
→ records コレクションに投稿データが保存される
```

### Storage
```
ビルド > Storage > Files タブ
→ records フォルダに画像が保存される
```

## 🎯 MVP 達成チェック

以下すべてが動作すれば MVP 完成！

- [x] Google ログイン機能
- [x] ログイン状態の保持
- [x] 未ログイン時のリダイレクト
- [x] 記録投稿フォーム
- [x] 画像アップロード
- [x] コメント保存
- [x] 練習時間保存
- [x] Firestore へのデータ保存
- [x] Cloud Storage への画像保存
- [x] 記録一覧の表示
- [x] リアルタイム更新
- [x] 記録削除機能
- [x] ログアウト機能

## 🚀 次のステップ（オプション）

MVP 達成後、以下の拡張を検討：

1. **ストリーク機能**
   - 連続記録日数の表示

2. **統計機能**
   - 月別の投稿数
   - 総練習時間

3. **検索機能**
   - コメントで過去の記録を検索

4. **ランキング**（複数ユーザー対応時）
   - ユーザー間のランキング

5. **AI機能**（OpenAI API 連携）
   - 投稿時に自動でコメント生成

## 📚 参考資料

- [「えがけん」セットアップガイド](./SETUP_GUIDE.md)
- [Firebase 詳細セットアップ](./FIREBASE_SETUP.md)
- [Next.js 公式ドキュメント](https://nextjs.org/docs)
- [Firebase 公式ドキュメント](https://firebase.google.com/docs)

---

**トラブル発生時は、コンソール（ブラウザ F12）でエラーを確認してください！**
