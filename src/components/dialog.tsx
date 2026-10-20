'use client';

import { useEffect, useRef } from 'react';

/**
 * Thin wrapper over the native <dialog>: modal focus trapping, Esc to close and the
 * top layer come from the browser. Clicking the backdrop closes it too.
 */
export function Dialog({
  open,
  onClose,
  label,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Re-sync after every render: the browser can close the element on its own (Esc).
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={`m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-bg p-0 text-fg backdrop:backdrop-blur-[1px] ${className}`}
    >
      {open ? children : null}
    </dialog>
  );
}
