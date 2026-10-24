import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { checkAdminUser } from '@/lib/admin/guard';
import AdminPanel from './admin-panel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    redirect('/auth/login?redirectedFrom=/admin');
  }

  const session = await getCurrentSession(supabase);
  if (!session.ok || !session.user) {
    redirect('/auth/login?redirectedFrom=/admin');
  }

  const admin = checkAdminUser(session.user);
  if (!admin.ok) {
    redirect('/');
  }

  return (
    <main className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col items-center justify-start p-4 sm:p-6 lg:p-12 relative overflow-x-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-gradient-to-b from-cyan-900/10 via-indigo-950/10 to-transparent blur-3xl pointer-events-none -z-10" />
      <AdminPanel adminEmail={admin.user.email} />
    </main>
  );
}
