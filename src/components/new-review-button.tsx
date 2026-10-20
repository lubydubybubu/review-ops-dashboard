'use client';

import { IconPlus } from './icons';
import { useShell } from './shell-context';

export function NewReviewButton({ label = '새 리뷰' }: { label?: string }) {
  const { openQuickCreate } = useShell();
  return (
    <button type="button" className="btn btn-primary" onClick={() => openQuickCreate()}>
      <IconPlus className="size-3.5" />
      {label}
    </button>
  );
}
