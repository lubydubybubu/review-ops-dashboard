'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '@/server/actions/auth';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password" className="label">
        비밀번호
      </label>
      <input
        id="password"
        name="password"
        type="password"
        className="input h-10"
        autoComplete="current-password"
        autoFocus
        required
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? 'login-error' : undefined}
      />
      {state.error ? (
        <p id="login-error" role="alert" className="text-[13px] text-danger">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary h-10" disabled={pending}>
        {pending ? '확인 중…' : '로그인'}
      </button>
    </form>
  );
}
