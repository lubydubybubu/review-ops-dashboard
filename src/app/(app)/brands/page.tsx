import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { requireSession } from '@/server/auth/session';
import { listBrands } from '@/server/db/brands';
import { getPool } from '@/server/db/pool';
import { BrandManager } from './brand-manager';

export const metadata: Metadata = { title: '브랜드' };

export default async function BrandsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  await requireSession();
  const showArchived = (await searchParams).archived === '1';
  const brands = await listBrands(getPool(), { includeArchived: showArchived });
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="브랜드"
        meta={`${brands.filter((b) => !b.archivedAt).length}곳`}
        actions={
          <Link href={showArchived ? '/brands' : '/brands?archived=1'} className="text-[13px] text-muted hover:text-fg">
            {showArchived ? '보관된 브랜드 숨기기' : '보관된 브랜드 보기'}
          </Link>
        }
      />
      <BrandManager brands={brands} />
    </div>
  );
}
