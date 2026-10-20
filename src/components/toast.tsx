'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { IconX } from './icons';

type Tone = 'info' | 'error';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
  action?: { label: string; href?: string; onClick?: () => void };
}

type ToastFn = (message: string, options?: { tone?: Tone; action?: Toast['action'] }) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const toast = useCallback<ToastFn>(
    (message, options) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone: options?.tone ?? 'info', action: options?.action }]);
      setTimeout(() => dismiss(id), options?.tone === 'error' ? 7000 : 4500);
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[13px] ${
              t.tone === 'error'
                ? 'border-danger/40 bg-bg text-danger'
                : 'border-line-strong bg-fg text-bg'
            }`}
          >
            <span>{t.message}</span>
            {t.action ? (
              t.action.href ? (
                <Link href={t.action.href} className="font-semibold underline underline-offset-2" onClick={() => dismiss(t.id)}>
                  {t.action.label}
                </Link>
              ) : (
                <button
                  type="button"
                  className="font-semibold underline underline-offset-2"
                  onClick={() => {
                    t.action?.onClick?.();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )
            ) : null}
            <button type="button" aria-label="닫기" className="opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)}>
              <IconX className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
