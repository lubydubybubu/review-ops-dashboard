import { addDays, kstInstant, type IsoDate } from '@/lib/domain/dates';
import type { Channel, Priority, SourceType } from '@/lib/domain/review';
import { createBrand } from './brands';
import type { Database } from './client';
import { createReview, moveReviewStage } from './reviews';
import { listStages } from './stages';
import { listTemplates } from './templates';

/**
 * DEMO data only: every brand and product here is fictional. Dates are relative to
 * `today` so the dashboard always has something overdue, due this week and upcoming.
 */

const BRANDS = [
  { name: 'Northwind Audio', status: 'active', category: '오디오' },
  { name: 'Kestrel Labs', status: 'active', category: '주변기기' },
  { name: 'Pebble Keys', status: 'active', category: '키보드' },
  { name: 'Lumen Optics', status: 'prospect', category: '카메라·조명' },
  { name: 'Orbit Mobile', status: 'paused', category: '모바일 액세서리' },
  { name: 'Haneul Works', status: 'active', category: '데스크 셋업' },
] as const;

interface DemoReview {
  product: string;
  brand: (typeof BRANDS)[number]['name'] | null;
  source: SourceType;
  stage: string;
  priority?: Priority;
  channels?: Channel[];
  /** day offsets from today */
  received?: number;
  shoot?: number;
  shootTime?: [string, string];
  write?: number;
  publish?: number;
  embargo?: number;
  publishedDaysAgo?: number;
  checklistDone?: number;
  notes?: string;
}

const REVIEWS: DemoReview[] = [
  { product: 'Northwind NX7 무선 헤드폰', brand: 'Northwind Audio', source: 'loan', stage: '작성/편집', priority: 'high', channels: ['youtube', 'blog'], received: -9, shoot: -6, write: -1, publish: 2, embargo: 1, checklistDone: 2,
    notes: '## 핵심 포인트\n- 노이즈 캔슬링: 지하철 소음 비교 컷\n- 배터리: 30시간 주장 → 실측 필요\n\n## 반납\n- 반납 예정일: 다음 주 금요일\n- 구성품: 케이블 2, 파우치 1\n' },
  { product: 'Kestrel K2 기계식 키보드', brand: 'Kestrel Labs', source: 'gift', stage: '촬영', channels: ['youtube', 'shorts'], received: -4, shoot: 0, shootTime: ['14:00', '16:30'], write: 5, publish: 8, checklistDone: 1 },
  { product: 'Pebble 로우프로파일 키캡 세트', brand: 'Pebble Keys', source: 'gift', stage: '입고', channels: ['instagram'], received: -1 },
  { product: 'Lumen L1 4K 웹캠', brand: 'Lumen Optics', source: 'loan', stage: '촬영 대기', priority: 'high', channels: ['youtube'], received: -2, shoot: 1, shootTime: ['10:00', '11:30'], write: 4, publish: 6, embargo: 6 },
  { product: 'Orbit 폴드 스마트폰 케이스', brand: 'Orbit Mobile', source: 'purchase', stage: '발행', channels: ['blog'], received: -24, shoot: -20, write: -14, publish: -12, publishedDaysAgo: 12, checklistDone: 3 },
  { product: 'Haneul 펠트 데스크 매트', brand: 'Haneul Works', source: 'purchase', stage: '검수', priority: 'low', channels: ['blog', 'instagram'], received: -12, shoot: -8, write: -3, publish: 3, checklistDone: 3 },
  { product: 'Northwind Buds 2', brand: 'Northwind Audio', source: 'loan', stage: '검수', channels: ['youtube', 'shorts'], received: -7, shoot: -4, write: 1, publish: 3, checklistDone: 4 },
  { product: 'Kestrel M5 무선 마우스', brand: 'Kestrel Labs', source: 'gift', stage: '보류', priority: 'low', received: -15 },
  { product: 'Lumen R12 링라이트', brand: 'Lumen Optics', source: 'gift', stage: '작성/편집', channels: ['youtube'], received: -6, shoot: -3, write: 2, publish: 5, checklistDone: 2 },
  { product: 'Pebble 75% 알루미늄 키보드', brand: 'Pebble Keys', source: 'loan', stage: '촬영 대기', priority: 'high', channels: ['youtube', 'blog'], received: 0, shoot: 2, write: 6, publish: 9, embargo: 9 },
  { product: 'Orbit 맥세이프 보조배터리', brand: 'Orbit Mobile', source: 'purchase', stage: '입고', channels: ['shorts'], received: 1 },
  { product: 'Haneul 원목 모니터 받침대', brand: 'Haneul Works', source: 'purchase', stage: '발행', channels: ['blog'], received: -30, shoot: -26, write: -20, publish: -18, publishedDaysAgo: 17, checklistDone: 3 },
  { product: 'Northwind S3 스튜디오 모니터', brand: 'Northwind Audio', source: 'loan', stage: '작성/편집', priority: 'high', channels: ['youtube'], received: -13, shoot: -10, write: -2, publish: 1, checklistDone: 3 },
  { product: 'Kestrel Q1 USB 마이크', brand: 'Kestrel Labs', source: 'gift', stage: '촬영', channels: ['youtube', 'shorts'], received: -3, shoot: -1, write: 3, publish: 10, checklistDone: 1 },
  { product: 'USB-C 허브 5종 비교', brand: null, source: 'purchase', stage: '입고', channels: ['blog'], received: -3 },
  { product: 'Lumen 미니 LED 패널', brand: 'Lumen Optics', source: 'loan', stage: '촬영 대기', channels: ['instagram'], received: 9, shoot: 12, write: 16, publish: 19, embargo: 18 },
  { product: 'Pebble 무소음 스위치 키트', brand: 'Pebble Keys', source: 'gift', stage: '입고', received: 14, shoot: 18, write: 23, publish: 26 },
];

export async function seedDemo(db: Database, today: IsoDate): Promise<{ brands: number; reviews: number }> {
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from reviews');
  if (rows[0]!.n > 0) throw new Error('reviews already exist; seed only runs on an empty database (use --reset)');

  const brandIds = new Map<string, number>();
  for (const b of BRANDS) {
    brandIds.set(b.name, await createBrand(db, { name: b.name, status: b.status, category: b.category, website: null }));
  }

  const stages = await listStages(db);
  const stageId = (name: string) => stages.find((s) => s.name === name)!.id;
  const templates = await listTemplates(db);
  const day = (offset: number | undefined) => (offset === undefined ? null : addDays(today, offset));

  for (const r of REVIEWS) {
    const template = templates.find((t) => t.sourceType === r.source);
    const id = await createReview(db, {
      productName: r.product,
      templateId: template?.id ?? null,
      stageId: stageId('입고'),
      brandId: r.brand ? brandIds.get(r.brand)! : null,
      sourceType: r.source,
      anchorField: null,
      anchorDate: null,
    });

    const shootOn = day(r.shoot);
    await db.query(
      `update reviews set priority = $2, channels = $3, received_on = $4, shoot_on = $5,
              shoot_starts_at = $6, shoot_ends_at = $7, write_due_on = $8, publish_planned_on = $9,
              embargo_until = $10, notes_md = coalesce($11, notes_md)
        where id = $1`,
      [
        id,
        r.priority ?? 'normal',
        r.channels ?? [],
        day(r.received),
        shootOn,
        shootOn && r.shootTime ? kstInstant(shootOn, r.shootTime[0]) : null,
        shootOn && r.shootTime ? kstInstant(shootOn, r.shootTime[1]) : null,
        day(r.write),
        day(r.publish),
        day(r.embargo),
        r.notes ?? null,
      ],
    );

    // Walk the board left to right so the stage history looks like real use.
    const target = stages.findIndex((s) => s.name === r.stage);
    const path = r.stage === '보류' ? [stages[target]!] : stages.slice(1, target + 1);
    for (const stage of path) await moveReviewStage(db, id, stage.id);
    await db.query(
      `update review_stage_history h
          set changed_at = now() - make_interval(days => (x.n - x.rn)::int * 2)
         from (select id, row_number() over (order by id) as rn, count(*) over () as n
                 from review_stage_history where review_id = $1) x
        where h.id = x.id`,
      [id],
    );

    if (r.publishedDaysAgo !== undefined) {
      await db.query(`update reviews set published_at = now() - make_interval(days => $2) where id = $1`, [
        id,
        r.publishedDaysAgo,
      ]);
    }
    if (r.checklistDone) {
      await db.query(
        `update review_checklist_items set done_at = now()
          where review_id = $1 and sort <= $2`,
        [id, r.checklistDone],
      );
    }
  }
  return { brands: BRANDS.length, reviews: REVIEWS.length };
}
