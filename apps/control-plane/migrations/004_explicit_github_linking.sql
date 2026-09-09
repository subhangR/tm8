-- Supabase may combine provider identities by verified email. tm8 requires a
-- separate explicit link before that additional GitHub identity can sign in.
alter table tm8_directory.accounts add column github_subject text unique;
alter table tm8_directory.auth_flows add column parent_session_id uuid references tm8_directory.sessions(id);
alter table tm8_directory.auth_flows drop constraint auth_flows_kind_check;
alter table tm8_directory.auth_flows add constraint auth_flows_kind_check check(kind in ('login','recovery','github'));
