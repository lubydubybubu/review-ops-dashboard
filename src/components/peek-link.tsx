'use client';

import Link from 'next/link';
import { useShell } from './shell-context';

/**
 * A link to /reviews/[id] whose plain click opens the quick-edit peek instead. Modifier / middle
 * clicks keep their browser meaning (new tab etc.), and without JS it is still the full page link.
 */
export function PeekLink({
  reviewId,
  ...props
}: { reviewId: number } & Omit<React.ComponentProps<typeof Link>, 'href'>) {
  const { openPeek } = useShell();
  return (
    <Link
      {...props}
      href={`/reviews/${reviewId}`}
      data-peek-link={reviewId}
      onClick={(e) => {
        props.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const el = e.currentTarget;
        openPeek(reviewId, () => (el.isConnected ? el : document.querySelector<HTMLElement>(`[data-peek-link="${reviewId}"]`)));
      }}
    />
  );
}
