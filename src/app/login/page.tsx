import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeReturnTo } from '@/server/auth/handoff';
import { authConfigOrNull, hasSession } from '@/server/auth/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: '로그인' };

const MESSAGES: Record<string, string> = {
  ended: '사이트 관리자 세션이 끝나(로그아웃·비밀번호 변경·만료) Ops 세션도 끝났습니다.',
  unavailable: '사이트 관리자 로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'signed-out': '로그아웃했습니다.',
  state: '로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.',
  denied: '사이트 관리자만 Review Ops에 로그인할 수 있습니다.',
  handoff: '사이트 관리자 로그인을 완료하지 못했습니다. 다시 시도해 주세요.',
  busy: '로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  config: '로그인이 설정되지 않았습니다.',
};

type Search = { next?: string; reason?: string; error?: string };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (await hasSession()) redirect('/');
  const { next, reason, error } = await searchParams;
  const config = authConfigOrNull();
  const notice = MESSAGES[String(error ?? reason ?? '')] ?? null;
  const returnTo = safeReturnTo(next);
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-[20rem]">
        <p className="mb-8 flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" />
          Review Ops
        </p>
        {notice ? (
          <p role="status" className="mb-4 text-[13px] text-muted">
            {notice}
          </p>
        ) : null}
        {config?.mode === 'site' ? (
          // A plain GET link: the site hands a code only to an admin session, and only the browser that started can redeem it.
          <>
            <a className="btn btn-primary h-10 w-full justify-center" href={`/auth/start?next=${encodeURIComponent(returnTo)}`}>
              사이트 관리자 계정으로 로그인
            </a>
            <p className="mt-3 text-[12px] text-subtle">사이트 관리자 로그인이 필요합니다. 관리자 로그인 화면이 나오면 로그인한 뒤 여기서 다시 시작하세요.</p>
          </>
        ) : config?.mode === 'demo-password' ? (
          <>
            <p className="mb-3 text-[12px] text-subtle">데모 모드 — 로컬 전용 비밀번호 로그인</p>
            <LoginForm next={returnTo} />
          </>
        ) : (
          <p className="text-[13px] text-muted">로그인이 꺼져 있습니다. 서버의 인증 설정(OPS_AUTH_MODE)을 확인하세요.</p>
        )}
      </div>
    </main>
  );
}
