-- 004: owner preferences. Single-owner app, so one row enforced by the CHECK on id.

create table user_settings (
  id              smallint primary key default 1 check (id = 1),
  week_start      smallint not null default 1 check (week_start between 0 and 6), -- 0 = 일, 1 = 월
  show_weekends   boolean not null default true,
  time_format_24h boolean not null default true,
  theme           text not null default 'system' check (theme in ('system', 'light', 'dark')),
  timezone        text not null default 'Asia/Seoul',
  calendar_fields text[] not null default array['shoot', 'write_due', 'publish_planned', 'embargo']
                  check (calendar_fields <@ array['shoot', 'write_due', 'publish_planned', 'embargo']),
  calendar_view   text not null default 'month' check (calendar_view in ('month', 'week')),
  updated_at      timestamptz not null default now()
);

create trigger user_settings_set_updated_at before update on user_settings
  for each row execute function set_updated_at();

insert into user_settings (id) values (1);
