-- Apply to the central Supabase Postgres database, never a workspace graph DB.
-- Only the central backend role may use this schema; it is not a PostgREST API.
create schema if not exists tm8_directory;
revoke all on schema tm8_directory from public;

create table tm8_directory.accounts (
  id uuid primary key,
  identity_id text not null unique,
  auth_subject uuid unique,
  email text not null,
  status text not null default 'invited' check(status in ('invited','active','suspended')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index directory_account_email on tm8_directory.accounts(lower(email));
create table tm8_directory.machines (
  id uuid primary key,
  name text not null,
  public_origin text not null unique,
  provider text not null check(provider in ('local','aws','azure','utho','other')),
  capacity integer not null default 10 check(capacity between 1 and 10000),
  allocated integer not null default 0 check(allocated >= 0 and allocated <= capacity),
  state text not null default 'enrolling' check(state in ('enrolling','ready','draining','offline')),
  credential_hash text not null,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);
create table tm8_directory.invitations (
  id uuid primary key,
  account_id uuid not null references tm8_directory.accounts(id),
  code_hash text not null unique,
  target_machine_id uuid references tm8_directory.machines(id),
  space_id uuid,
  created_by uuid not null references tm8_directory.accounts(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  check(space_id is null or target_machine_id is not null)
);
create table tm8_directory.assignments (
  account_id uuid primary key references tm8_directory.accounts(id),
  machine_id uuid not null references tm8_directory.machines(id),
  workspace_id uuid not null unique,
  operation_id uuid not null unique,
  state text not null default 'pending' check(state in ('pending','provisioning','ready','failed','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assignments_machine on tm8_directory.assignments(machine_id);
create table tm8_directory.sessions (
  id uuid primary key,
  account_id uuid not null references tm8_directory.accounts(id),
  secret_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table tm8_directory.handoffs (
  code_hash text primary key,
  session_id uuid not null references tm8_directory.sessions(id),
  machine_id uuid not null references tm8_directory.machines(id),
  expires_at timestamptz not null,
  redeemed_at timestamptz
);
create table tm8_directory.auth_flows (
  state_hash text primary key,
  verifier text not null,
  invitation_code text,
  expires_at timestamptz not null
);
create table tm8_directory.audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  resource_id uuid,
  created_at timestamptz not null default now()
);
revoke all on all tables in schema tm8_directory from public;
revoke all on all sequences in schema tm8_directory from public;
