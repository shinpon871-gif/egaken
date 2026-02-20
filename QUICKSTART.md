# 🚀 クイックスタート

「えがけん」MVP を素早くセットアップして動作確認するための手順です。

## 📋 準備物

- Node.js 18 以上
- Google アカウント
- Firebase プロジェクト（無料）

## ⚡ 5分でスタート

### 1. Firebase プロジェクト作成（2分）

```Bash
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

① `firebase-tools` をインストール（グローバル推奨）:

```bash
# グローバルインストール（必要な場合）
npm install -g firebase-tools
```

② プロジェクトルートでエミュレータを初期化（まだ未実行なら）:

```bash
firebase init emulators
```

③ エミュレータを起動（Firestore, Storage, Auth のみ）:

```bash
firebase emulators:start --only firestore,storage,auth
```

1) 開発用に `lib/firebase.ts` の初期化を切り替える（条件でエミュレータに接続）か、端末で `FIREBASE_FIRESTORE_EMULATOR_HOST` 等の環境変数を設定して接続します。

- 回避策（本番準備が必要な場合）:
  - 本当にクラウド Storage を利用する場合は、プロジェクトに課金アカウント（Blaze）を紐づけます。Blaze は従量課金ですが、少量なら無料枠内での利用も可能です。課金を有効にする前に使用量とコストを確認してください。

---

### 3. CORS設定（Storage画像のSNS対応）

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<your-bucket> --cors-file=cors.json
```

### 4. .env.local 設定

Firebase Consoleから各種キーを取得し、.env.localに記入。

### 5. 依存パッケージインストール

```bash
npm install
```

### 6. 開発サーバー起動

```bash
npm run dev
```

### 7. OGP/SNS画像対策

- 画像URLはそのまま。ページURLにのみ?v=...を付与。
- 画像アップロード時はcontentType指定、Imageタグはunoptimized。

### 8. Twitter(X)シェア・AIコメント

- シェアボタンは常に最新の?v=...付きURLを生成。
- AIコメントはOpenAI APIで非同期生成、失敗時は定型文返却。

---

詳細は [SETUP_GUIDE.md](./SETUP_GUIDE.md) も参照。
