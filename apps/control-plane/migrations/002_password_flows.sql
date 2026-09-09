alter table tm8_directory.auth_flows add column kind text not null default 'login' check(kind in ('login','recovery'));
create table tm8_directory.password_resets (
  handle_hash text primary key,
  access_token text not null,
  auth_subject uuid not null,
  expires_at timestamptz not null
);
revoke all on tm8_directory.password_resets from public;
