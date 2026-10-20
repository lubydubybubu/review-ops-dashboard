'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Thin wrapper over the native `popover` attribute: the browser provides the top layer (never clipped
 * by a scrolling tab bar), light dismiss and Esc. Open it with `<button popoverTarget={id}>`; the panel
 * is placed under that button and kept inside the viewport. Content renders only while open.
 */
export function Popover({
  id,
  label,
  className = '',
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onToggle = (e: Event) => setOpen((e as ToggleEvent).newState === 'open');
    el.addEventListener('beforetoggle', onToggle);
    return () => el.removeEventListener('beforetoggle', onToggle);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const anchor = [...document.querySelectorAll<HTMLElement>(`[popovertarget="${id}"]`)].find((a) => a.offsetParent !== null);
    if (!anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      el.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - width - 8))}px`;
      el.style.top = `${a.bottom + 4}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, id]);

  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role="dialog"
      aria-label={label}
      className={`fixed inset-auto m-0 max-h-[min(32rem,calc(100dvh-6rem))] overflow-y-auto rounded-lg border border-line-strong bg-bg p-0 text-[13px] text-fg ${className}`}
    >
      {open ? children : null}
    </div>
  );
}

/** Close the popover that contains `el` (after choosing a menu item). */
export function closePopoverOf(el: Element | null) {
  el?.closest<HTMLElement>('[popover]')?.hidePopover();
}
