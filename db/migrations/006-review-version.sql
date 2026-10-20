-- 006: integer revision for optimistic concurrency on review saves.
--
-- A form is saved only if `version` still equals the value it was loaded with (compared in the
-- UPDATE's WHERE). The trigger bumps it on every row update, from any code path (form save, board
-- move, calendar drag, archive, SQL console), so no writer can forget to. Checklist items live in
-- their own table and do not touch it. Additive: existing rows start at 1.

alter table reviews add column version integer not null default 1;

create function bump_review_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger reviews_bump_version before update on reviews
  for each row execute function bump_review_version();
