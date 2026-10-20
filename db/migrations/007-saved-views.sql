-- 007: saved views ("저장된 보기") — named list / board / calendar views shown as tabs.
--
-- A view owns its settings (filter, sorts, group, visible properties, calendar date fields) as one
-- jsonb document. Its shape is validated by a zod schema at the action boundary and again when read
-- (an unreadable document falls back to the layout default); the database only insists on an object.
-- Filters are compiled to parameterized SQL from a closed list of properties and operators, so the
-- document never names a column. `position` orders the one shared tab bar (deferrable so two tabs can
-- swap places in one transaction). `version` is the compare-and-set token for saving settings, bumped by
-- a trigger whenever `config` changes (renames and reorders do not invalidate an open draft).

create table saved_views (
  id         bigint generated always as identity primary key,
  layout     text not null check (layout in ('list', 'board', 'calendar')),
  name       text not null check (btrim(name) <> '' and char_length(name) <= 40),
  position   integer not null check (position >= 0),
  config     jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_position_uq unique (position) deferrable initially deferred
);

create unique index saved_views_layout_name_uq on saved_views (layout, lower(name));

create trigger saved_views_set_updated_at before update on saved_views
  for each row execute function set_updated_at();

create function bump_saved_view_version() returns trigger
language plpgsql as $$
begin
  if new.config is distinct from old.config then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

create trigger saved_views_bump_version before update on saved_views
  for each row execute function bump_saved_view_version();

-- Defaults that reproduce the pre-views screens: the table (newest first, embargo/channels hidden), the
-- stage board (priority order) and the calendar with the date fields the owner had switched on.
insert into saved_views (layout, name, position, config) values
  ('list', '전체 리뷰', 0,
   '{"v":1,"filter":{"op":"and","rules":[]},"sorts":[],"groupBy":null,"hidden":["embargo","channels"],"calendarFields":[]}'),
  ('board', '진행 보드', 1,
   '{"v":1,"filter":{"op":"and","rules":[]},"sorts":[{"prop":"priority","dir":"asc"}],"groupBy":"stage","hidden":["stage","channels"],"calendarFields":[]}');

insert into saved_views (layout, name, position, config)
select 'calendar', '캘린더', 2,
       jsonb_build_object('v', 1, 'filter', jsonb_build_object('op', 'and', 'rules', '[]'::jsonb), 'sorts', '[]'::jsonb,
                          'groupBy', null, 'hidden', '[]'::jsonb, 'calendarFields', to_jsonb(s.calendar_fields))
  from user_settings s where s.id = 1;
