import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { AUTH_AFTER_CONFIRM_PATH } from '@/lib/auth/server';

function safeNextPath(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const next = safeNextPath(url.searchParams.get('next'));

  const redirectBase = `${url.origin}${AUTH_AFTER_CONFIRM_PATH}`;

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.redirect(
      `${redirectBase}?status=error&reason=config`,
    );
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        `${redirectBase}?status=error&reason=exchange`,
      );
    }
    return NextResponse.redirect(`${url.origin}${next}`);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) {
      return NextResponse.redirect(
        `${redirectBase}?status=error&reason=otp`,
      );
    }
    return NextResponse.redirect(`${url.origin}${next}`);
  }

  return NextResponse.redirect(`${redirectBase}?status=error&reason=missing`);
}
