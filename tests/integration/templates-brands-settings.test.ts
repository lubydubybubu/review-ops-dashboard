import { beforeEach, describe, expect, it } from 'vitest';
import { overdueFields } from '../../src/lib/domain/overdue';
import {
  brandCreateSchema,
  reviewCreateSchema,
  settingsSchema,
  templateUpdateSchema,
} from '../../src/lib/validation';
import { createBrand, listBrands, setBrandArchived, updateBrand } from '../../src/server/db/brands';
import { listChecklist } from '../../src/server/db/checklist';
import { countReviewsByStage, listOverdueReviews } from '../../src/server/db/dashboard';
import { createReview, getReview, listReviews } from '../../src/server/db/reviews';
import { getSettings, updateSettings } from '../../src/server/db/settings';
import { createStage, listStages } from '../../src/server/db/stages';
import { listTemplates, updateTemplate } from '../../src/server/db/templates';
import { pgErrorCode, resetData, stageIdsByName, useAdminPool, useAppPool } from './helpers';

describe('review templates (R1.8)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('ships one default template per source type', async () => {
    const templates = await listTemplates(db);
    expect(templates.map((t) => t.sourceType).sort()).toEqual(['gift', 'loan', 'purchase']);
    expect(templates.every((t) => t.checklist.length >= 3)).toBe(true);
  });

  it('creating from a template computes dates, presets fields and copies the checklist', async () => {
    const loan = (await listTemplates(db)).find((t) => t.sourceType === 'loan')!;
    const id = await createReview(
      db,
      reviewCreateSchema.parse({ productName: '대여 헤드폰', templateId: loan.id, anchorField: 'shoot', anchorDate: '2026-10-28' }),
    );
    const review = await getReview(db, id);
    // loan: write-by = shoot + 4, publish = write-by + 2 (crosses the month boundary)
    expect(review).toMatchObject({
      sourceType: 'loan',
      stageName: '입고',
      templateId: loan.id,
      receivedOn: null,
      shootOn: '2026-10-28',
      writeDueOn: '2026-11-01',
      publishPlannedOn: '2026-11-03',
    });
    expect(review?.notesMd).toBe(loan.bodyMd);
    const checklist = await listChecklist(db, id);
    expect(checklist.map((c) => c.title)).toEqual(loan.checklist);
    expect(checklist.every((c) => c.doneAt === null)).toBe(true);
  });

  it('anchoring on 입고 walks the whole chain', async () => {
    const purchase = (await listTemplates(db)).find((t) => t.sourceType === 'purchase')!;
    const id = await createReview(
      db,
      reviewCreateSchema.parse({ productName: '구매품', templateId: purchase.id, anchorField: 'received', anchorDate: '2026-12-20' }),
    );
    expect(await getReview(db, id)).toMatchObject({
      receivedOn: '2026-12-20',
      shootOn: '2026-12-27',
      writeDueOn: '2027-01-03',
      publishPlannedOn: '2027-01-06',
    });
  });

  it('editing a template replaces its checklist atomically', async () => {
    const gift = (await listTemplates(db)).find((t) => t.sourceType === 'gift')!;
    const stages = await stageIdsByName(db);
    const input = templateUpdateSchema.parse({
      ...gift,
      initialStageId: stages['촬영 대기'],
      writeOffsetDays: '10',
      checklist: ['첫 항목', '둘째 항목'],
    });
    expect(await updateTemplate(db, input)).toBe(true);
    const updated = (await listTemplates(db)).find((t) => t.id === gift.id)!;
    expect(updated).toMatchObject({ writeOffsetDays: 10, initialStageId: stages['촬영 대기'], checklist: ['첫 항목', '둘째 항목'] });
    await updateTemplate(db, templateUpdateSchema.parse(gift)); // restore
  });

  it('a template cannot preset a stage of another entity type', async () => {
    const task = await db.query<{ id: number }>(
      `insert into workflow_stages (entity_type, category_key, name, sort) values ('task', 'todo', '할 일(테스트)', 99) returning id`,
    );
    const gift = (await listTemplates(db)).find((t) => t.sourceType === 'gift')!;
    await expect(
      updateTemplate(db, templateUpdateSchema.parse({ ...gift, initialStageId: task.rows[0]!.id })),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === '23503');
    await db.query('delete from workflow_stages where id = $1', [task.rows[0]!.id]);
  });
});

describe('brands', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('creates, updates, counts reviews and archives', async () => {
    const id = await createBrand(db, brandCreateSchema.parse({ name: 'Northwind Audio' }));
    await createReview(db, reviewCreateSchema.parse({ productName: 'NX7', brandId: id }));
    await updateBrand(db, { id, name: 'Northwind Audio', status: 'paused', category: '오디오', website: 'https://example.com' });

    expect(await listBrands(db)).toMatchObject([{ id, status: 'paused', category: '오디오', reviewCount: 1 }]);

    await setBrandArchived(db, id, true);
    expect(await listBrands(db)).toEqual([]);
    expect(await listBrands(db, { includeArchived: true })).toHaveLength(1);
    // the review keeps its brand
    expect((await listReviews(db))[0]?.brandName).toBe('Northwind Audio');
  });

  it('names are unique case-insensitively among active brands', async () => {
    await createBrand(db, brandCreateSchema.parse({ name: 'Kestrel Labs' }));
    await expect(createBrand(db, brandCreateSchema.parse({ name: 'kestrel labs' }))).rejects.toMatchObject({
      constraint: 'brands_name_uq',
    });
  });

  it('a brand used by reviews cannot be hard-deleted', async () => {
    const id = await createBrand(db, brandCreateSchema.parse({ name: 'Pebble Keys' }));
    await createReview(db, reviewCreateSchema.parse({ productName: '키캡', brandId: id }));
    await expect(db.query('delete from brands where id = $1', [id])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23503',
    );
  });
});

describe('stages, settings and dashboard', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('user stages are added at the end of their category', async () => {
    const created = await createStage(db, { categoryKey: 'in_progress', name: '썸네일', color: '#123456' });
    const inProgress = (await listStages(db)).filter((s) => s.categoryKey === 'in_progress');
    expect(inProgress.map((s) => s.name)).toEqual(['촬영', '작성/편집', '검수', '썸네일']);
    await db.query('delete from workflow_stages where id = $1', [created.id]);
  });

  it('settings default to Monday week start and persist updates (R1.5)', async () => {
    expect(await getSettings(db)).toMatchObject({ weekStart: 1, showWeekends: true, timeFormat24h: true });
    await updateSettings(db, settingsSchema.parse({ weekStart: 0, calendarFields: ['shoot'] }));
    expect(await getSettings(db)).toMatchObject({ weekStart: 0, showWeekends: true, calendarFields: ['shoot'] });
    await updateSettings(db, { weekStart: 1, calendarFields: ['shoot', 'write_due', 'publish_planned', 'embargo'] });
    await expect(db.query('update user_settings set week_start = 9')).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23514',
    );
    await expect(db.query('insert into user_settings (id) values (2)')).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23514',
    );
  });

  it('SQL overdue filter agrees with the TypeScript rule', async () => {
    const stages = await stageIdsByName(db);
    const rows: [string, string, string | null, string | null][] = [
      ['지난 작성 마감', '작성/편집', '2026-10-18', '2026-10-25'],
      ['오늘 마감', '작성/편집', '2026-10-19', '2026-10-20'],
      ['지난 발행', '검수', null, '2026-10-01'],
      ['발행 완료', '발행', '2026-10-01', '2026-10-02'],
      ['보류', '보류', '2026-10-01', null],
      ['날짜 없음', '입고', null, null],
    ];
    for (const [name, stage, write, publish] of rows) {
      await db.query(
        `insert into reviews (product_name, stage_id, write_due_on, publish_planned_on) values ($1, $2, $3, $4)`,
        [name, stages[stage], write, publish],
      );
    }
    const today = '2026-10-19';
    const sql = (await listOverdueReviews(db, today)).map((r) => r.productName).sort();
    const ts = (await listReviews(db)).filter((r) => overdueFields(r, today).length > 0).map((r) => r.productName).sort();
    expect(sql).toEqual(['지난 발행', '지난 작성 마감']);
    expect(sql).toEqual(ts);
  });

  it('stage counts include empty stages and ignore archived reviews', async () => {
    const stages = await stageIdsByName(db);
    await db.query(`insert into reviews (product_name, stage_id) values ('a', $1), ('b', $1), ('c', $2)`, [
      stages['촬영'],
      stages['발행'],
    ]);
    await db.query(`insert into reviews (product_name, stage_id, archived_at) values ('d', $1, now())`, [stages['촬영']]);
    const counts = Object.fromEntries((await countReviewsByStage(db)).map((c) => [c.stageId, c.count]));
    expect(counts[stages['촬영']!]).toBe(2);
    expect(counts[stages['발행']!]).toBe(1);
    expect(counts[stages['입고']!]).toBe(0);
  });
});
