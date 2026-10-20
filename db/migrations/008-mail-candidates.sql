-- 008: review requests found in the owner's mail ("메일에서 온 의뢰").
--
-- A job on another host reads the mailbox read-only, extracts candidates and POSTs them to
-- /api/ingest/mail-candidates; that endpoint inserts rows here and touches nothing else. A
-- candidate never becomes a review on its own: the owner accepts it (one transaction creates the
-- review and marks the row accepted), links it to an existing review, or dismisses it.
--
-- Everything that came from the mail is untrusted text: the UI renders it as plain text only.
-- `message_id` / `thread_id` are mailbox ids (hex), the only values a mail link is built from.
--
-- Status rules (CHECK below):
--   pending    new, waiting for the owner                       review_id null,     decided_at null
--   duplicate  new mail in a thread that already has a review   review_id = that,   decided_at null
--   accepted   became / was linked to a review                  review_id not null, decided_at set
--   dismissed  ignored by the owner (undo within 7 days)        review_id kept,     decided_at set
-- `version` is the compare-and-set token for decisions, bumped by a trigger on every update.

create table mail_candidates (
  id            bigint generated always as identity primary key,
  source        text not null check (source in ('gmail')),
  message_id    text not null check (message_id ~ '^[0-9a-f]{8,64}$'),
  thread_id     text not null check (thread_id ~ '^[0-9a-f]{8,64}$'),
  received_at   timestamptz not null,
  from_name     text check (from_name is null or char_length(from_name) <= 200),
  from_address  text not null check (char_length(from_address) between 3 and 320),
  subject       text not null check (char_length(subject) <= 500),
  snippet       text not null default '' check (char_length(snippet) <= 1000),
  extracted     jsonb not null check (jsonb_typeof(extracted) = 'object'),
  evidence      jsonb not null default '[]'
                check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 5),
  confidence    real not null check (confidence >= 0 and confidence <= 1),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed', 'duplicate')),
  review_id     bigint references reviews (id) on delete restrict,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  version       integer not null default 1,
  constraint mail_candidates_message_uq unique (source, message_id),
  constraint mail_candidates_status_shape check (
    (status = 'pending' and review_id is null and decided_at is null)
    or (status = 'duplicate' and review_id is not null and decided_at is null)
    or (status = 'accepted' and review_id is not null and decided_at is not null)
    or (status = 'dismissed' and decided_at is not null))
);

-- thread lookups (re-delivery → duplicate) and the inbox (open items, newest first)
create index mail_candidates_thread_idx on mail_candidates (source, thread_id);
create index mail_candidates_open_idx on mail_candidates (received_at desc, id desc) where status in ('pending', 'duplicate');
create index mail_candidates_review_idx on mail_candidates (review_id) where review_id is not null;

create function bump_mail_candidate_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger mail_candidates_bump_version before update on mail_candidates
  for each row execute function bump_mail_candidate_version();
