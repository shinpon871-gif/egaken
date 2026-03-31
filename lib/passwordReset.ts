import { Auth, sendPasswordResetEmail } from 'firebase/auth';

/**
 * パスワードリセット診断・実行関数
 * ログベースで問題原因を特定する
 */
export interface PasswordResetResult {
  success: boolean;
  userMessage: string;
  internalMessage: string;
  errorCode?: string;
}

export async function performPasswordReset(
  auth: Auth | undefined,
  email: string,
  continueUrl?: string
): Promise<PasswordResetResult> {
  const timestamp = new Date().toISOString();

  // ========================================
  // ① Auth初期化の確認
  // ========================================
  console.log(`[${timestamp}] [reset-init] Starting password reset attempt`);
  console.log(`[${timestamp}] [reset-auth] auth exists: ${!!auth}`);
  console.log(`[${timestamp}] [reset-auth] auth.app exists: ${!!auth?.app}`);
  console.log(`[${timestamp}] [reset-auth] auth.app.options.authDomain: ${auth?.app?.options?.authDomain}`);

  if (!auth) {
    return {
      success: false,
      userMessage: 'エラーが発生しました（認証サービスが初期化されていません）',
      internalMessage: 'Auth instance is undefined',
      errorCode: 'auth/not-initialized',
    };
  }

  // ========================================
  // ② 入力値の正規化と確認
  // ========================================
  const normalize = (str: string) => str.replace(/[\s\u3000\u000B\u000C\u00A0]+/g, '');
  const cleanedEmail = normalize(email);

  console.log(`[${timestamp}] [reset-input] raw email length: ${email.length}`);
  console.log(`[${timestamp}] [reset-input] cleaned email: ${cleanedEmail}`);
  console.log(`[${timestamp}] [reset-input] email has special chars: ${/[^\w.@-]/.test(cleanedEmail)}`);

  if (!cleanedEmail) {
    return {
      success: false,
      userMessage: 'メールアドレスを入力してください',
      internalMessage: 'Email is empty after normalization',
      errorCode: 'auth/empty-email',
    };
  }

  // ========================================
  // ③ メール形式の軽微チェック
  // ========================================
  const basicEmailRegex = /^[\w!#$%&'*+/=?`{|}~^.-]+@[\w.-]+\.[a-zA-Z]{2,}$/;
  const isValidFormat = basicEmailRegex.test(cleanedEmail);
  console.log(`[${timestamp}] [reset-email-format] is valid: ${isValidFormat}`);

  // ========================================
  // ④ sendPasswordResetEmail 実行
  // ========================================
  try {
    console.log(`[${timestamp}] [reset-send-start] Calling sendPasswordResetEmail`);
    console.log(`[${timestamp}] [reset-send-start] email: ${cleanedEmail}`);
    console.log(`[${timestamp}] [reset-send-start] continueUrl: ${continueUrl || 'not specified'}`);

    if (continueUrl) {
      await sendPasswordResetEmail(auth, cleanedEmail, {
        url: continueUrl,
        handleCodeInApp: false,
      });
    } else {
      await sendPasswordResetEmail(auth, cleanedEmail);
    }

    console.log(`[${timestamp}] [reset-send-success] Email sending appears successful`);

    // ✅ 成功（ただし実際にメールが届いたかは不明）
    return {
      success: true,
      userMessage: 'パスワードリセットメールを送信しました。\n(数分以内に受け取りが無い場合は迷惑メールフォルダをご確認ください)',
      internalMessage: `Password reset email sent to ${cleanedEmail}`,
    };
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    const errorCode = error.code || 'unknown-error';
    const errorMessage = error.message || 'No error message';

    console.log(`[${timestamp}] [reset-send-error] errorCode: ${errorCode}`);
    console.log(`[${timestamp}] [reset-send-error] errorMessage: ${errorMessage}`);

    // ========================================
    // ⑤ エラーコード別の診断
    // ========================================

    switch (errorCode) {
      case 'auth/user-not-found':
        console.log(`[${timestamp}] [reset-error] User with email "${cleanedEmail}" not found in Firebase`);
        // ⚠️ セキュリティ上、実際の原因を隠す
        return {
          success: true, // UI的には成功に見せる
          userMessage: 'パスワードリセットメールを送信しました。\n(数分以内に受け取りが無い場合は迷惑メールフォルダをご確認ください)',
          internalMessage: `[SECURITY] User not found for ${cleanedEmail} (not exposed to client)`,
          errorCode: 'auth/user-not-found',
        };

      case 'auth/invalid-email':
        console.log(`[${timestamp}] [reset-error] Email format invalid: ${cleanedEmail}`);
        return {
          success: false,
          userMessage: 'メールアドレスの形式が正しくありません',
          internalMessage: `Invalid email format: ${cleanedEmail}`,
          errorCode: 'auth/invalid-email',
        };

      case 'auth/too-many-requests':
        console.log(`[${timestamp}] [reset-error] Rate limited - too many reset attempts`);
        console.log(`[${timestamp}] [reset-error] advise user to wait and check spam folder`);
        return {
          success: false,
          userMessage: 'ログイン試行が多すぎます。数時間後にお試しください。\n既にメールを送信している場合は迷惑メールフォルダをご確認ください',
          internalMessage: 'Rate limit exceeded for password reset',
          errorCode: 'auth/too-many-requests',
        };

      case 'auth/network-request-failed':
        console.log(`[${timestamp}] [reset-error] Network request failed`);
        console.log(`[${timestamp}] [reset-error] possible causes: offline, firewall, network issue`);
        return {
          success: false,
          userMessage: 'ネットワークエラーが発生しました。インターネット接続を確認して再度お試しください',
          internalMessage: 'Network request failed',
          errorCode: 'auth/network-request-failed',
        };

      case 'auth/service-disabled':
        console.log(`[${timestamp}] [reset-error] Email/Password sign-in is disabled in Firebase Console`);
        return {
          success: false,
          userMessage: 'この認証方法は現在利用できません',
          internalMessage: 'Email/Password authentication is disabled in Firebase Console',
          errorCode: 'auth/service-disabled',
        };

      case 'auth/internal-error':
        console.log(`[${timestamp}] [reset-error] Firebase internal error: ${errorMessage}`);
        return {
          success: false,
          userMessage: 'サーバーエラーが発生しました。時間をおいて再度お試しください',
          internalMessage: `Firebase internal error: ${errorMessage}`,
          errorCode: 'auth/internal-error',
        };

      default:
        console.log(`[${timestamp}] [reset-error] Unhandled error code: ${errorCode}`);
        console.log(`[${timestamp}] [reset-error] Full error:`, error);
        return {
          success: false,
          userMessage: 'エラーが発生しました。時間をおいて再度お試しください',
          internalMessage: `Unhandled error - ${errorCode}: ${errorMessage}`,
          errorCode: errorCode,
        };
    }
  }
}

/**
 * よくある原因の診断チェックリスト（手動確認用）
 * これはコンソールに出力するためのもの
 */
export function printDiagnosticChecklist() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  パスワードリセットメール問題 - 診断チェックリスト           ║
╚════════════════════════════════════════════════════════════════╝

【Firebase Console 設定確認】
  [ ] Authentication → Sign-in method → Email/Password が「有効」か
  [ ] Authentication → Templates の「パスワードリセット」が設定されているか
  [ ] Authentication → Authorized domains に本番ドメインが含まれているか
  
【メール送信後の確認】
  [ ] 迷惑メールフォルダをご確認ください
  [ ] 送信者アドレスが noreply@firebase.com になっていないか確認
  
【ブラウザ・ネットワーク確認】
  [ ] ブラウザのコンソールエラーを確認
  [ ] Developer Tools → Network タブで sendPasswordResetEmail の通信成功を確認
  [ ] 海外VPN接続をしていないか（Firebase だいたい認識される）
  
【Firebase ログ確認】
  [ ] Firebase Console → Authentication → Logs でエラー詳細を確認
  [ ] 「Password Reset Email Sent」ログが記録されているか
  
【よくある原因】
  1. Authorized domain 未設定 → continueUrl が設定されていない
  2. パスワードリセットテンプレートが無効
  3. ユーザーが実は登録されていない
  4. 迷惑メールフィルタに引っかかっている
  5. レート制限（auth/too-many-requests）
  `);
}
