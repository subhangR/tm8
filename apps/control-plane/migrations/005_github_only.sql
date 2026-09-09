-- In-flight email confirmations and password recovery grants cannot be used
-- after switching to GitHub-only authentication. Existing accounts are kept.
delete from tm8_directory.auth_flows where kind <> 'github';
delete from tm8_directory.password_resets;
alter table tm8_directory.auth_flows drop constraint auth_flows_kind_check;
alter table tm8_directory.auth_flows add constraint auth_flows_kind_check check(kind = 'github');
