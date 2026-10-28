-- PropertyPortal — Row Level Security
-- Service role (server) bypasses RLS automatically. These policies protect
-- the anon / authenticated clients (mobile app, future tenant web).

-- Enable RLS
alter table public."Building"           enable row level security;
alter table public."Tenant"             enable row level security;
alter table public."Technician"         enable row level security;
alter table public."AdminUser"          enable row level security;
alter table public."MaintenanceRequest" enable row level security;
alter table public."TicketMessage"      enable row level security;
alter table public."Document"           enable row level security;
alter table public."QualityReport"      enable row level security;
alter table public."Review"             enable row level security;
alter table public."Broadcast"          enable row level security;

-- Helper: resolve the tenant row bound to the current auth user
create or replace function public.current_tenant_id() returns text
language sql stable security definer set search_path = public as $$
  select id from public."Tenant" where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.current_tenant_building() returns text
language sql stable security definer set search_path = public as $$
  select "buildingId" from public."Tenant" where auth_user_id = auth.uid() limit 1
$$;

grant execute on function public.current_tenant_id()      to anon, authenticated;
grant execute on function public.current_tenant_building() to anon, authenticated;

-- ────── Policies ──────

-- Buildings: tenant can read only their own building
drop policy if exists building_tenant_read on public."Building";
create policy building_tenant_read on public."Building"
  for select to authenticated
  using (id = public.current_tenant_building());

-- Tenants: can read their own row, update limited fields (push_token etc handled server-side)
drop policy if exists tenant_self_read on public."Tenant";
create policy tenant_self_read on public."Tenant"
  for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists tenant_self_update on public."Tenant";
create policy tenant_self_update on public."Tenant"
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Technicians: not readable by tenants (admin dashboard uses service role)
-- No policies = default deny for authenticated.

-- Maintenance requests: only the owning tenant
drop policy if exists mr_tenant_read on public."MaintenanceRequest";
create policy mr_tenant_read on public."MaintenanceRequest"
  for select to authenticated
  using ("tenantId" = public.current_tenant_id());

drop policy if exists mr_tenant_insert on public."MaintenanceRequest";
create policy mr_tenant_insert on public."MaintenanceRequest"
  for insert to authenticated
  with check ("tenantId" = public.current_tenant_id());

-- Ticket messages: readable / writable only on tickets owned by the tenant
drop policy if exists tm_tenant_read on public."TicketMessage";
create policy tm_tenant_read on public."TicketMessage"
  for select to authenticated
  using (exists (
    select 1 from public."MaintenanceRequest" mr
    where mr.id = "TicketMessage"."requestId"
      and mr."tenantId" = public.current_tenant_id()
  ));

drop policy if exists tm_tenant_insert on public."TicketMessage";
create policy tm_tenant_insert on public."TicketMessage"
  for insert to authenticated
  with check (
    exists (
      select 1 from public."MaintenanceRequest" mr
      where mr.id = "TicketMessage"."requestId"
        and mr."tenantId" = public.current_tenant_id()
    )
    and author_kind = 'tenant'
  );

-- Documents
drop policy if exists doc_tenant_all on public."Document";
create policy doc_tenant_all on public."Document"
  for all to authenticated
  using ("tenantId" = public.current_tenant_id())
  with check ("tenantId" = public.current_tenant_id());

-- Quality reports
drop policy if exists qr_tenant_read on public."QualityReport";
create policy qr_tenant_read on public."QualityReport"
  for select to authenticated
  using ("tenantId" = public.current_tenant_id());

drop policy if exists qr_tenant_insert on public."QualityReport";
create policy qr_tenant_insert on public."QualityReport"
  for insert to authenticated
  with check ("tenantId" = public.current_tenant_id());

-- Reviews: tenants read and submit their own
drop policy if exists rev_tenant_all on public."Review";
create policy rev_tenant_all on public."Review"
  for all to authenticated
  using ("tenantId" = public.current_tenant_id())
  with check ("tenantId" = public.current_tenant_id());

-- Broadcasts: tenants see broadcasts for their building
drop policy if exists bc_building_read on public."Broadcast";
create policy bc_building_read on public."Broadcast"
  for select to authenticated
  using ("buildingId" = public.current_tenant_building());

-- AdminUser: never exposed to anon/authenticated (service role only)
-- No policies.

-- ────── Storage bucket for tenant documents ──────
insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;

-- Tenants can read / write only inside a folder named after their tenant id.
drop policy if exists docs_tenant_read on storage.objects;
create policy docs_tenant_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = public.current_tenant_id()
  );

drop policy if exists docs_tenant_write on storage.objects;
create policy docs_tenant_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = public.current_tenant_id()
  );

drop policy if exists docs_tenant_delete on storage.objects;
create policy docs_tenant_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = public.current_tenant_id()
  );
