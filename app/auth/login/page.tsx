import { redirect } from 'next/navigation';

export default function AuthLoginRedirect() {
  // /auth/login へアクセスされた場合、正しいログインページへ転送
  redirect('/login');
}
