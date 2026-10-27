import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

function isRecoverySession(user: { recovery_sent_at?: string | null } | null): boolean {
  if (!user) return false;
  const recovery = (user as { recovery_sent_at?: string | null }).recovery_sent_at;
  if (!recovery) return false;
  const ts = Date.parse(recovery);
  if (Number.isNaN(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= 0 && ageMs < 3600_000;
}

export default async function ResetPasswordPage() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    redirect('/auth/login?error=reset_unavailable');
  }

  const session = await getCurrentSession(supabase);

  if (!session.ok || !session.user || !isRecoverySession(session.user)) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
        <div className="max-w-md w-full text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">Ссылка недействительна</h1>
          <p className="text-slate-400">
            Ссылка восстановления истекла, уже использована или недействительна. Запросите новую.
          </p>
          <Link
            href="/auth/forgot-password"
            className="inline-block px-6 py-3 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors"
          >
            Запросить новую ссылку
          </Link>
          <div className="pt-2">
            <Link href="/auth/login" className="text-sm text-slate-400 hover:text-cyan-400 transition-colors">
              Вернуться ко входу
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-white">Установите новый пароль</h1>
          <p className="text-sm text-slate-400">Придумайте надёжный пароль для вашего аккаунта.</p>
        </div>
        <ResetPasswordForm />
        <div className="text-center">
          <Link href="/auth/login" className="text-sm text-slate-400 hover:text-cyan-400 transition-colors">
            Вернуться ко входу
          </Link>
        </div>
      </div>
    </main>
  );
}
