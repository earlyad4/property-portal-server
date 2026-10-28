-- PropertyPortal — grant table privileges to Supabase roles.
-- Required because tables were created via SQL editor (owner: postgres),
-- which does not auto-grant to service_role / anon / authenticated.
-- Without this, even the sb_secret_ key gets "permission denied for table X"
-- before RLS evaluation.

-- Ensure roles can use the schema at all.
grant usage on schema public to postgres, anon, authenticated, service_role;

-- service_role bypasses RLS but still needs table ACL privileges.
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- anon + authenticated: RLS policies decide row visibility, but ACL must allow access.
grant select, insert, update, delete on all tables    in schema public to authenticated;
grant select                         on all tables    in schema public to anon;
grant usage, select                  on all sequences in schema public to anon, authenticated;
grant execute                        on all functions in schema public to anon, authenticated;

-- Future-proof: same defaults for any new object created later in this schema.
alter default privileges in schema public
  grant all privileges on tables    to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant all privileges on functions to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated;
alter default privileges in schema public
  grant execute on functions to anon, authenticated;
