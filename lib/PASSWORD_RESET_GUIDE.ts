// パスワードリセット問題 - 診断ガイド & 実装サマリー

/**
 * 📋 ③ FIREBASE設定チェックリスト
 * 
 * メールが届かない原因のほとんどは「コード」ではなく「設定」
 * Firebase Console で以下を必ず確認してください
 */

/*
╔════════════════════════════════════════════════════════════════╗
║  1️⃣  Sign-in Method の確認                                    ║
╚════════════════════════════════════════════════════════════════╝

Firebase Console > Authentication > Sign-in method

  ✓ Email/Password が「有効」になっているか？
    - 無効の場合 → 「有効にする」をクリック
    
  ✓ 「メールリンク（パスワードレス）」は「無効」で OK
    - 今回は使わない認証方式
*/

/*
╔════════════════════════════════════════════════════════════════╗
║  2️⃣  メールテンプレートの確認                                  ║
╚════════════════════════════════════════════════════════════════╝

Firebase Console > Authentication > Templates

  ✓ 「パスワード リセット」テンプレートが設定されているか？
    - デフォルトテンプレート でも OK
    - カスタマイズする場合は「編集」で変更可能
    
  ✓ 「Sender name」は何でもいい（デフォルト ok）
  
  ✓ 「Sender email (noreply@...)」を確認
    - ← これが送信元になる
*/

/*
╔════════════════════════════════════════════════════════════════╗
║  3️⃣  Authorized Domains の確認 ★ 最重要 ★                    ║
╚════════════════════════════════════════════════════════════════╝

Firebase Console > Authentication > Settings > Authorized domains

  ⚠️  これが無いと、パスワードリセットリンクが無効になる
  
  現在のドメイン（本番 & ローカル）を追加：
  
  ✓ 本番環境: https://yoursite.com
  ✓ ローカル: http://localhost:3000
  ✓ プレビュー環境がある場合も追加

  追加方法：
  1. 「ドメインを追加」をクリック
  2. https://yoursite.com を入力
  3. 「確認」をクリック（メール確認が必要な場合がある）
  
  ⚠️  これを忘れるのが多い!
*/

/*
╔════════════════════════════════════════════════════════════════╗
║  4️⃣  メールの到達確認                                          ║
╚════════════════════════════════════════════════════════════════╝

「送信する」ボタンを押した後：

  ✓ 迷惑メール / スパムフォルダを確認
    - Gmail: タブの下部 → 「迷惑メール」を確認
    - Outlook: 同様に「迷惑メール」を確認
    - 携帯キャリア: キャリアの設定で「受信拒否」になっていないか確認
    
  ✓ 受信者のメールフィルタ設定を確認
    - noreply@firebase.com をホワイトリストに登録
    
  ✓ ドメイン受け取り側の設定（MX/SPF）
    - 企業メール or 独自ドメインの場合は SPF/DKIM が正しいか確認
*/

/*
╔════════════════════════════════════════════════════════════════╗
║  5️⃣  Firebase ログ確認                                        ║
╚════════════════════════════════════════════════════════════════╝

Firebase Console > Authentication > Logs

  パスワードリセット試行ごとに以下をチェック：
  
  ✓ 「Password Reset Email Sent」 が記録されているか？
    - YES → コードは成功している、メール配信に問題
    - NO → コード or Firebase 側に問題
    
  ✓ エラーログを確認
    - Error: user not found → ユーザーが存在しない
    - Error: service disabled → Email/Password が無効
    - Error: ... → エラーメッセージを確認
*/

/**
 * 📋 ② エラーハンドリング実装
 * 
 * 以下の 4 個のケースに対応済み
 */

/*
┌────────────────────────────────────────┐
│ ケース 1: user-not-found               │
└────────────────────────────────────────┘

❌ 修正前:
   - UI: "登録されていないメールアドレスです"
   - 問題: ユーザー列挙攻撃の脆弱性
   
✅ 修正後:
   - UI: "パスワードリセットメールを送信しました"
   - 内部ログ: "[SECURITY] User not found..."
   - 効果: 外部から「そのユーザーが存在するか」判定不可
*/

/*
┌────────────────────────────────────────┐
│ ケース 2: メール送信成功 → 実は迷惑メール │
└────────────────────────────────────────┘

UI メッセージ改善:

  旧: "パスワードリセットメールを送信しました"
  
  新: "パスワードリセットメールを送信しました。
      (数分以内に受け取りが無い場合は迷惑メールフォルダをご確認ください)"
      
  効果: ユーザーが迷惑メール対策を知る
*/

/*
┌────────────────────────────────────────┐
│ ケース 3: 無限リトライ（too-many-requests） │
└────────────────────────────────────────┘

エラーコード: auth/too-many-requests

UI メッセージ:
  "ログイン試行が多すぎます。数時間後にお試しください。
   既にメールを送信している場合は迷惑メールフォルダをご確認ください"

ログ出力:
  [reset-error] Rate limited - too many reset attempts
*/

/*
┌────────────────────────────────────────┐
│ ケース 4: ネットワークエラー            │
└────────────────────────────────────────┘

エラーコード: auth/network-request-failed

原因の可能性:
  1. ユーザーのオフラライン
  2. ファイアウォール/プロキシのブロック
  3. Firebase API の一時的な不具合
  4. DNS 解決失敗

UI メッセージ:
  "ネットワークエラーが発生しました。インターネット接続を確認して
   再度お試しください"

ログ出力:
  [reset-error] Network request failed
  [reset-error] possible causes: offline, firewall, network issue
*/

/**
 * 📋 ① 実装コード - 呼び出し
 */

/*
// app/(auth)/login/page.tsx

const handlePasswordReset = async () => {
  setEmailErrorMsg('');
  
  if (!email.trim()) {
    setEmailErrorMsg('メールアドレスを入力してください');
    return;
  }

  // 開発時ログ出力
  console.log('[🔐 PASSWORD RESET] Starting...');
  console.log('[🔐 PASSWORD RESET] email:', email);

  const result = await performPasswordReset(auth, email);
  
  // ユーザー向けメッセージ表示
  setEmailErrorMsg(result.userMessage);
  
  // 内部ログ（開発者向け）
  console.log('[🔐 PASSWORD RESET] Result:', {
    success: result.success,
    errorCode: result.errorCode,
    internalMessage: result.internalMessage,
  });
};
*/

/**
 * 📋 実装コード - performPasswordReset 関数詳細
 */

/*
エクスポート: lib/passwordReset.ts

interface PasswordResetResult {
  success: boolean;
  userMessage: string;        // ← ユーザーに表示する
  internalMessage: string;    // ← 開発者用ログ
  errorCode?: string;         // ← エラー分類
}

async function performPasswordReset(
  auth: Auth | undefined,
  email: string,
  continueUrl?: string      // ← Authorized domains に対応させる
): Promise<PasswordResetResult>

以下をすべて実行:
  ✓ Auth 初期化状態の確認 → ログ出力
  ✓ メール入力の正規化（スペース・不可視文字除去）
  ✓ sendPasswordResetEmail 実行
  ✓ 8 種類のエラーコードハンドリング
  ✓ セキュリティ対応（user-not-found を隠す）
  ✓ 迷惑メール対策の注意書き表示
*/

/**
 * 📋 ④ デバッグ用の手順（本番の問題調査時）
 */

/*
Step 1: ブラウザのコンソール を開く
  F12 or 右クリック → 検査 → Console タブ

Step 2: パスワードリセット を試す
  - 「パスワードを忘れた場合」ボタンをクリック
  - メールアドレスを入力
  - 「送信」をクリック

Step 3: コンソールログの確認
  以下が出力されているはず：

  [reset-init] Starting password reset attempt
  [reset-auth] auth exists: true
  [reset-auth] auth.app exists: true
  [reset-auth] auth.app.options.authDomain: yourproject.firebaseapp.com
  [reset-input] raw email length: 20
  [reset-input] cleaned email: user@example.com
  [reset-send-start] Calling sendPasswordResetEmail
  [reset-send-success] Email sending appears successful

Step 4: エラーが出た場合
  ❌ "[reset-send-error] errorCode: auth/invalid-email"
     → メール形式が正しくない
     
  ❌ "[reset-send-error] errorCode: auth/user-not-found"
     → ユーザーが登録されていない（セキュリティで隠している）
     → Firebase Console → Users で確認
     
  ❌ "[reset-send-error] errorCode: auth/service-disabled"
     → Email/Password 認証が無効
     → Firebase Console → Sign-in method で確認
     
  ❌ "[reset-send-error] errorCode: auth/network-request-failed"
     → ネットワーク問題
     → オフラインか、ファイアウォールを確認

Step 5: Firebase Console で確認
  Firebase Console > Authentication > Logs
  
  時系列で最新エントリを見て：
  - "Password Reset Email Sent" が記録されているか？
    → YES: コードはOK、メール配信側の問題
    → NO: Firebase 側or設定の問題
*/

/**
 * 📋 ⑤ 本番運用用チェックリスト
 */

/*
□ Authorized domains が正しく設定されているか
  - 新しいテスト・ステージング環境を追加したら忘れずに登録

□ パスワードリセットテンプレートが有効か
  - メールのカスタマイズを行った場合は送信テストする

□ UI メッセージが表示されているか
  - 「迷惑メールフォルダをご確認ください」が見えるか確認

□ エラーハンドリングが機能しているか
  - 無効なメールアドレス → error表示
  - レート制限 →適切なメッセージ

□ ログが出力されているか（開発時）
  - 本番環境では console.log を削除or condition 付きにする

□ セキュリティ監査
  - user-not-found が UI で隠れているか確認
  - エラーメッセージからシステム開示がないか確認
*/

export {};
