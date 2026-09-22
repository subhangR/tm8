set role tm8_graph_owner;

-- Filesystem skills are references; preserve every legacy identity/body/edge.
alter table public.skills
  add column provider text not null default 'tm8' check (provider in ('claude','agents','codex','hermes','tm8')),
  add column level text not null default 'space' check (level in ('system','admin','user','project','nested','plugin','synced','session','space')),
  add column root_kind text check (root_kind in ('home','project','plugin','subdir')),
  add column root_ref text,
  add column source_path text check (source_path is null or left(source_path, 1) = '/'),
  add column dir_name text,
  add column frontmatter jsonb not null default '{}' check (jsonb_typeof(frontmatter) = 'object'),
  add column loader_metadata jsonb not null default '{}' check (jsonb_typeof(loader_metadata) = 'object'),
  add column content_hash text,
  add column file_mtime timestamptz,
  add column body_bytes integer check (body_bytes >= 0),
  add column bundle jsonb,
  add column missing boolean not null default false,
  add column last_seen_at timestamptz,
  add constraint skills_file_body_not_cached check (content = '' or (provider = 'tm8' and source_path is null));

create unique index skills_source_path_unique on public.skills (source_path) where source_path is not null;

-- Birth only: existing skills keep their status along with their body and edges.
create or replace function internal.kind_seeds_done(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('commit', 'message', 'file', 'memory', 'artifact', 'skill')
$$;

reset role;
