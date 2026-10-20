import type { CalendarField } from '@/lib/domain/review';
import { CALENDAR_FIELD_META } from '@/lib/domain/review';

export function Dot({ color, className = 'size-2' }: { color: string; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${className}`} style={{ background: color }} />;
}

export function StageBadge({ name, color, onHold = false }: { name: string; color: string; onHold?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]">
      <Dot color={color} />
      <span className={onHold ? 'text-muted' : undefined}>{name}</span>
    </span>
  );
}

export function FieldLabel({ field }: { field: CalendarField }) {
  const meta = CALENDAR_FIELD_META[field];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Dot color={meta.color} className="size-1.5" />
      {meta.label}
    </span>
  );
}

export function OverdueTag({ children = '지연' }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">
      {children}
    </span>
  );
}
