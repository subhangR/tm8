set role tm8_graph_owner;
-- Operator-only migration ledger. The web and enrollment roles cannot read
-- host source paths or rewrite ownership decisions.
create table public.workspace_migration_ledger (
  project_id uuid primary key references public.projects(id),
  operation_id uuid not null unique,
  workspace_id uuid not null references public.user_workspaces(id),
  account_id uuid not null references public.accounts(id),
  home_space_id uuid not null references public.spaces(id),
  original_working_dir text not null,
  source_path text not null,
  source_fingerprint text not null,
  state text not null check(state in ('copying','ready')),
  backup_path text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.workspace_migration_ledger enable row level security;
reset role;
