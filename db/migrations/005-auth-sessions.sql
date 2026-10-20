-- 005: server-side sign-in state. Replaces the stateless HMAC cookie: a session is valid only
-- while its row exists, so logout / revocation take effect immediately. Only hashes of the
-- browser-held values are stored.

-- One row per started parent-site sign-in; consumed (deleted) by the callback, so a state is one-use.
create table auth_login_attempts (
  state_hash    text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  binding_hash  text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9_-]{43}$'),
  return_to     text not null check (length(return_to) between 1 and 512 and left(return_to, 1) = '/'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  check (expires_at > created_at)
);

create index auth_login_attempts_expires on auth_login_attempts (expires_at);

create table auth_sessions (
  id           bigint generated always as identity primary key,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  mode         text not null check (mode in ('site', 'demo-password')),
  subject      text not null check (length(subject) between 1 and 64),
  -- site mode: the opaque site grant this session rides on (useless without the Ops client secret)
  site_grant   text check (site_grant ~ '^[A-Za-z0-9_-]{43,128}$'),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  validated_at timestamptz not null default now(),
  revoked_at   timestamptz,
  check (expires_at > created_at),
  check ((mode = 'site') = (site_grant is not null))
);

create index auth_sessions_subject on auth_sessions (subject) where revoked_at is null;
create index auth_sessions_expires on auth_sessions (expires_at);
