import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export async function POST() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  await supabase.auth.signOut();

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
