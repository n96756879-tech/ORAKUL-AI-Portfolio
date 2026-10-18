import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export async function GET() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ user: null }, { status: 200 });
  }

  const session = await getCurrentSession(supabase);
  if (!session.ok) {
    return NextResponse.json({ user: null }, { status: 200 });
  }

  return NextResponse.json(
    { user: session.user ? { email: session.user.email ?? null } : null },
    { status: 200 },
  );
}
