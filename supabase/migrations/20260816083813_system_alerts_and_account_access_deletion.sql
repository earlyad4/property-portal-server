-- PropertyPortal operational alerts and delayed tenant account-access deletion.
-- Apply to staging first. The server service role is the only API principal
-- granted access to SystemAlert; administrators read it through the server API.

create table if not exists public."SystemAlert" (
  alert_id uuid primary key default gen_random_uuid(),
  incident_key text not null,
  event_type text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'recovered', 'failed_delivery')),
  delivery_status text not null default 'queued'
    check (delivery_status in ('queued', 'sent', 'delivered', 'delayed', 'failed', 'bounced')),
  environment text not null,
  release_id text not null,
  affected_component text not null,
  diagnostic_details jsonb not null default '{}'::jsonb,
  recommended_action text not null,
  health_endpoint_status text not null,
  recipients text[] not null default '{}'::text[],
  resend_email_id text,
  resend_email_ids text[] not null default '{}'::text[],
  resend_event_ids text[] not null default '{}'::text[],
  reminder_sent_at timestamptz,
  escalation_sent_at timestamptz,
  retry_count integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  recovery_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public."AdminUser"(id) on delete set null,
  acknowledgement_note text,
  updated_at timestamptz not null default now()
);

create unique index if not exists system_alert_one_active_incident_idx
  on public."SystemAlert" (incident_key, environment)
  where status in ('open', 'acknowledged', 'failed_delivery');
create index if not exists system_alert_created_idx
  on public."SystemAlert" (created_at desc);
create index if not exists system_alert_resend_email_idx
  on public."SystemAlert" (resend_email_id)
  where resend_email_id is not null;

alter table public."SystemAlert" enable row level security;
alter table public."SystemAlert" force row level security;
revoke all on table public."SystemAlert" from public, anon, authenticated;
grant select, insert, update, delete on table public."SystemAlert" to service_role;

alter table public."Tenant"
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_scheduled_for timestamptz,
  add column if not exists deletion_cancelled_at timestamptz,
  add column if not exists access_disabled_at timestamptz;

create index if not exists tenant_pending_access_deletion_idx
  on public."Tenant" (deletion_scheduled_for)
  where deletion_scheduled_for is not null and access_disabled_at is null;

-- Direct Supabase Data API access also stops after the access-disabled date.
create or replace function public.current_tenant_id() returns text
language sql stable security definer set search_path = public as $$
  select id from public."Tenant"
  where auth_user_id = auth.uid() and access_disabled_at is null
  limit 1
$$;

create or replace function public.current_tenant_building() returns text
language sql stable security definer set search_path = public as $$
  select "buildingId" from public."Tenant"
  where auth_user_id = auth.uid() and access_disabled_at is null
  limit 1
$$;

drop policy if exists tenant_self_read on public."Tenant";
create policy tenant_self_read on public."Tenant"
  for select to authenticated
  using (auth_user_id = auth.uid() and access_disabled_at is null);

drop policy if exists tenant_self_update on public."Tenant";
create policy tenant_self_update on public."Tenant"
  for update to authenticated
  using (auth_user_id = auth.uid() and access_disabled_at is null)
  with check (auth_user_id = auth.uid() and access_disabled_at is null);
