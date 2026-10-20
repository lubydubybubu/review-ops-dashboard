-- 003: review templates, reviews, stage history and checklist items.
--
-- Date rule: date-only facts (received, shoot day, deadlines, embargo) are `date` values
-- interpreted in Asia/Seoul. Instants (shoot start/end, actual publish) are timestamptz.

create table templates (
  id                  bigint generated always as identity primary key,
  entity_type         text not null default 'review' check (entity_type in ('review', 'task')),
  name                text not null check (btrim(name) <> '' and char_length(name) <= 80),
  source_type         text check (source_type in ('loan', 'gift', 'purchase')),
  initial_stage_id    bigint,
  -- deadline chain: shoot = received + a, write-by = shoot + b, publish = write-by + c
  shoot_offset_days   smallint check (shoot_offset_days between 0 and 365),
  write_offset_days   smallint check (write_offset_days between 0 and 365),
  publish_offset_days smallint check (publish_offset_days between 0 and 365),
  body_md             text not null default '',
  sort                integer not null default 0,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- a template may only preset a stage of its own entity type
  foreign key (initial_stage_id, entity_type) references workflow_stages (id, entity_type),
  check (entity_type = 'review' or (source_type is null and shoot_offset_days is null
         and write_offset_days is null and publish_offset_days is null))
);

create unique index templates_name_uq on templates (entity_type, lower(name)) where archived_at is null;

create trigger templates_set_updated_at before update on templates
  for each row execute function set_updated_at();

create table template_checklist_items (
  id          bigint generated always as identity primary key,
  template_id bigint not null references templates (id) on delete cascade,
  title       text not null check (btrim(title) <> '' and char_length(title) <= 200),
  sort        integer not null,
  unique (template_id, sort)
);

create table reviews (
  id                 bigint generated always as identity primary key,
  product_name       text not null check (btrim(product_name) <> '' and char_length(product_name) <= 200),
  title              text check (title is null or (btrim(title) <> '' and char_length(title) <= 200)),
  brand_id           bigint references brands (id) on delete restrict,
  source_type        text check (source_type in ('loan', 'gift', 'purchase')),
  stage_id           bigint not null,
  stage_entity       text not null default 'review' check (stage_entity = 'review'),
  priority           text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  channels           text[] not null default '{}'
                     check (channels <@ array['youtube', 'shorts', 'instagram', 'blog', 'tiktok', 'threads']),
  received_on        date,
  shoot_on           date,
  shoot_starts_at    timestamptz,
  shoot_ends_at      timestamptz,
  write_due_on       date,
  publish_planned_on date,
  embargo_until      date,
  published_at       timestamptz,
  published_url      text check (published_url is null or published_url ~* '^https?://'),
  template_id        bigint references templates (id) on delete set null,
  notes_md           text not null default '',
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  foreign key (stage_id, stage_entity) references workflow_stages (id, entity_type),

  -- a timed shoot must fall on its shoot day (KST) and end after it starts
  constraint reviews_shoot_time_on_day check (
    shoot_starts_at is null
    or (shoot_on is not null and (shoot_starts_at at time zone 'Asia/Seoul')::date = shoot_on)),
  constraint reviews_shoot_end_after_start check (
    shoot_ends_at is null or (shoot_starts_at is not null and shoot_ends_at > shoot_starts_at)),
  -- the product must be in hand before it is shot; writing/publishing follow the shoot
  constraint reviews_received_before_shoot check (received_on <= shoot_on),
  constraint reviews_shoot_before_write_due check (shoot_on <= write_due_on),
  constraint reviews_shoot_before_publish check (shoot_on <= publish_planned_on)
);

comment on column reviews.embargo_until is
  'Publish-not-before date. Phase 3 contracts may fill this; a publish date before it is a UI warning, not an error.';

create trigger reviews_set_updated_at before update on reviews
  for each row execute function set_updated_at();

-- Calendar range queries hit one date column at a time; partial indexes skip archived rows.
create index reviews_shoot_on_idx on reviews (shoot_on) where archived_at is null and shoot_on is not null;
create index reviews_write_due_on_idx on reviews (write_due_on) where archived_at is null and write_due_on is not null;
create index reviews_publish_planned_on_idx on reviews (publish_planned_on) where archived_at is null and publish_planned_on is not null;
create index reviews_embargo_until_idx on reviews (embargo_until) where archived_at is null and embargo_until is not null;
create index reviews_stage_idx on reviews (stage_id) where archived_at is null;
create index reviews_brand_idx on reviews (brand_id);
create index reviews_template_idx on reviews (template_id);

create table review_stage_history (
  id            bigint generated always as identity primary key,
  review_id     bigint not null references reviews (id) on delete cascade,
  from_stage_id bigint references workflow_stages (id),
  to_stage_id   bigint not null references workflow_stages (id),
  changed_at    timestamptz not null default now(),
  check (from_stage_id is distinct from to_stage_id)
);

create index review_stage_history_review_idx on review_stage_history (review_id, changed_at desc, id desc);

-- History is written by the database in the same statement as the stage change, so no
-- code path (board drag, detail form, SQL console) can change a stage without a record.
create function log_review_stage_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into review_stage_history (review_id, from_stage_id, to_stage_id)
    values (new.id, null, new.stage_id);
  elsif new.stage_id is distinct from old.stage_id then
    insert into review_stage_history (review_id, from_stage_id, to_stage_id)
    values (new.id, old.stage_id, new.stage_id);
  end if;
  return null;
end;
$$;

create trigger reviews_log_stage_change after insert or update of stage_id on reviews
  for each row execute function log_review_stage_change();

create table review_checklist_items (
  id         bigint generated always as identity primary key,
  review_id  bigint not null references reviews (id) on delete cascade,
  title      text not null check (btrim(title) <> '' and char_length(title) <= 200),
  sort       integer not null,
  done_at    timestamptz,
  created_at timestamptz not null default now()
);

create index review_checklist_items_review_idx on review_checklist_items (review_id, sort);

-- Default templates, one per source type (editable in 설정).
insert into templates (name, source_type, initial_stage_id, shoot_offset_days, write_offset_days, publish_offset_days, body_md, sort)
select v.name, v.source_type, s.id, v.a, v.b, v.c, v.body, v.sort
from (values
  ('대여 리뷰', 'loan',     3, 4, 2, E'## 반납\n- 반납 예정일:\n- 구성품:\n', 1),
  ('제공 리뷰', 'gift',     5, 5, 3, E'## 브랜드 전달 사항\n- \n', 2),
  ('구매 리뷰', 'purchase', 7, 7, 3, E'## 구매 정보\n- 구매처:\n- 가격:\n', 3)
) as v(name, source_type, a, b, c, body, sort)
join workflow_stages s on s.entity_type = 'review' and s.name = '입고';

insert into template_checklist_items (template_id, title, sort)
select t.id, v.title, v.sort
from (values
  ('loan', '언박싱 촬영', 1), ('loan', '외관·디테일 컷', 2), ('loan', '스펙 표 정리', 3), ('loan', '반납 전 구성품 확인', 4),
  ('gift', '언박싱 촬영', 1), ('gift', '스펙 표 정리', 2), ('gift', '브랜드 전달 사항 확인', 3),
  ('purchase', '언박싱 촬영', 1), ('purchase', '스펙 표 정리', 2), ('purchase', '장기 사용 메모', 3)
) as v(source_type, title, sort)
join templates t on t.source_type = v.source_type;
