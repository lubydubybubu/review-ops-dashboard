-- 002: brands. Phase 1 uses name/status; category/website/notes are ready for the
-- phase 3 CRM (contacts, loans, contracts will reference brands.id).
-- Brands are never hard-deleted by the app: archive instead (reviews keep their FK).

create table brands (
  id          bigint generated always as identity primary key,
  name        text not null check (btrim(name) <> '' and char_length(name) <= 120),
  category    text check (category is null or btrim(category) <> ''),
  website     text check (website is null or website ~* '^https?://'),
  status      text not null default 'active' check (status in ('prospect', 'active', 'paused')),
  notes_md    text not null default '',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index brands_name_uq on brands (lower(name)) where archived_at is null;

create trigger brands_set_updated_at before update on brands
  for each row execute function set_updated_at();
