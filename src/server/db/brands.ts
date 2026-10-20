import type { IsoInstant } from '@/lib/domain/dates';
import type { BrandCreateInput, BrandUpdateInput } from '@/lib/validation';
import type { Queryable } from './client';

export type BrandStatus = 'prospect' | 'active' | 'paused';

export interface Brand {
  id: number;
  name: string;
  status: BrandStatus;
  category: string | null;
  website: string | null;
  archivedAt: IsoInstant | null;
  createdAt: IsoInstant;
  /** active (non-archived) reviews referencing the brand */
  reviewCount: number;
}

export interface BrandOption {
  id: number;
  name: string;
}

export async function listBrands(db: Queryable, { includeArchived = false } = {}): Promise<Brand[]> {
  const { rows } = await db.query<Brand>(
    `select b.id, b.name, b.status, b.category, b.website,
            b.archived_at as "archivedAt", b.created_at as "createdAt",
            count(r.id) as "reviewCount"
       from brands b
       left join reviews r on r.brand_id = b.id and r.archived_at is null
      where $1 or b.archived_at is null
      group by b.id
      order by b.archived_at nulls first, lower(b.name)`,
    [includeArchived],
  );
  return rows;
}

export async function listBrandOptions(db: Queryable): Promise<BrandOption[]> {
  const { rows } = await db.query<BrandOption>(
    `select id, name from brands where archived_at is null order by lower(name)`,
  );
  return rows;
}

export async function createBrand(db: Queryable, input: BrandCreateInput): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into brands (name, status, category, website) values ($1, $2, $3, $4) returning id`,
    [input.name, input.status, input.category, input.website],
  );
  return rows[0]!.id;
}

export async function updateBrand(db: Queryable, input: BrandUpdateInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `update brands set name = $2, status = $3, category = $4, website = $5 where id = $1`,
    [input.id, input.name, input.status, input.category, input.website],
  );
  return rowCount === 1;
}

/** Brands are archived, never deleted: reviews keep pointing at them. */
export async function setBrandArchived(db: Queryable, id: number, archived: boolean): Promise<boolean> {
  const { rowCount } = await db.query(
    `update brands set archived_at = case when $2 then coalesce(archived_at, now()) end where id = $1`,
    [id, archived],
  );
  return rowCount === 1;
}
