-- 001: shared helpers + the stage model (fixed categories, user-editable stages).
--
-- Categories are fixed reference data (할 일 / 진행 중 / 완료). Stages are ordered
-- inside a category and are shared by entity type ('review' now, 'task' in phase 2).

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table stage_categories (
  key   text primary key check (key in ('todo', 'in_progress', 'done')),
  label text not null check (btrim(label) <> ''),
  sort  smallint not null unique
);

insert into stage_categories (key, label, sort) values
  ('todo', '할 일', 1),
  ('in_progress', '진행 중', 2),
  ('done', '완료', 3);

create table workflow_stages (
  id           bigint generated always as identity primary key,
  entity_type  text not null check (entity_type in ('review', 'task')),
  category_key text not null references stage_categories (key),
  name         text not null check (btrim(name) <> '' and char_length(name) <= 40),
  color        text not null default '#8A8A8A' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort         integer not null check (sort >= 0),
  is_default   boolean not null default false,
  -- "보류" lives in the 완료 category (it is not active work) but must not count as
  -- published; the flag keeps that distinction without a fourth category.
  is_on_hold   boolean not null default false,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  -- target of composite FKs that pin a row to stages of its own entity type
  unique (id, entity_type),
  unique (entity_type, category_key, sort),
  check (not is_on_hold or category_key = 'done'),
  check (not (is_default and is_on_hold))
);

create unique index workflow_stages_name_uq
  on workflow_stages (entity_type, lower(name)) where archived_at is null;
create unique index workflow_stages_one_default_uq
  on workflow_stages (entity_type) where is_default;

insert into workflow_stages (entity_type, category_key, name, color, sort, is_default, is_on_hold) values
  ('review', 'todo',        '입고',      '#8A8A8A', 1, true,  false),
  ('review', 'todo',        '촬영 대기', '#B08D57', 2, false, false),
  ('review', 'in_progress', '촬영',      '#4C7DD9', 1, false, false),
  ('review', 'in_progress', '작성/편집', '#C88A12', 2, false, false),
  ('review', 'in_progress', '검수',      '#8B5CF6', 3, false, false),
  ('review', 'done',        '발행',      '#2F9E6E', 1, false, false),
  ('review', 'done',        '보류',      '#6B6B6B', 2, false, true);
