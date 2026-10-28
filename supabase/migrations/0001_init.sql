-- PropertyPortal — initial schema
-- Apply with: supabase db push   (or paste into Supabase SQL editor)
-- Idempotent: safe to re-run.

-- ────── Extensions ──────

create extension if not exists "pgcrypto";

-- ────── Tables ──────

create table if not exists public."Building" (
  id          text primary key,
  code        text not null,
  name        text not null,
  address     text not null default '',
  units       integer not null default 0,
  floors      integer not null default 0,
  notes       text not null default '',
  image_url   text,
  created_at  timestamptz not null default now()
);

create table if not exists public."AdminUser" (
  id             uuid primary key default gen_random_uuid(),
  email          text unique not null,
  name           text not null,
  password_hash  text not null,
  role           text not null default 'admin',   -- 'admin' | 'manager' | 'viewer'
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

create table if not exists public."Tenant" (
  id           text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name         text not null,
  email        text unique not null,
  phone        text not null default '',
  unit         text not null,
  "buildingId" text not null references public."Building"(id) on delete restrict,
  push_token   text,
  is_verified  boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists tenant_building_idx on public."Tenant"("buildingId");
create index if not exists tenant_auth_idx      on public."Tenant"(auth_user_id);

create table if not exists public."Technician" (
  id          text primary key,
  name        text not null,
  trade       text not null,
  phone       text not null default '',
  zone        text not null default '',
  status      text not null default 'Available',
  jobs        integer not null default 0,
  rating      numeric(3,2) not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public."MaintenanceRequest" (
  id              text primary key,
  "tenantId"      text not null references public."Tenant"(id) on delete cascade,
  "tenantName"    text not null,
  "buildingId"    text not null references public."Building"(id),
  unit            text not null,
  category        text not null,
  title           text not null,
  location        text not null default '',
  description     text not null,
  status          text not null default 'Pending',
  "preferredTime" text not null default '',
  attachments     integer not null default 0,
  "submittedAt"   timestamptz not null default now(),
  "technicianId"  text references public."Technician"(id),
  "technicianName" text,
  "slaHours"      integer not null default 48,
  rating          integer,
  updated_at      timestamptz not null default now()
);

create index if not exists mr_tenant_idx      on public."MaintenanceRequest"("tenantId");
create index if not exists mr_building_idx    on public."MaintenanceRequest"("buildingId");
create index if not exists mr_status_idx      on public."MaintenanceRequest"(status);
create index if not exists mr_submitted_idx   on public."MaintenanceRequest"("submittedAt" desc);

create table if not exists public."TicketMessage" (
  id          text primary key,
  "requestId" text not null references public."MaintenanceRequest"(id) on delete cascade,
  author      text not null,
  author_kind text not null default 'admin',     -- 'admin' | 'tenant' | 'system' | 'technician'
  "tenantId"  text references public."Tenant"(id),
  "adminId"   uuid references public."AdminUser"(id),
  message     text not null,
  at          timestamptz not null default now()
);
create index if not exists tm_request_idx on public."TicketMessage"("requestId", at);

create table if not exists public."Document" (
  id          text primary key,
  "tenantId"  text not null references public."Tenant"(id) on delete cascade,
  type        text not null,
  "fileName"  text not null,
  "fileUrl"   text,
  status      text not null default 'Pending',
  note        text not null default '',
  "submittedAt" timestamptz not null default now()
);
create index if not exists doc_tenant_idx on public."Document"("tenantId");

create table if not exists public."QualityReport" (
  id            text primary key,
  "tenantId"    text not null references public."Tenant"(id) on delete cascade,
  "buildingId"  text not null references public."Building"(id),
  category      text not null,
  title         text not null,
  description   text not null,
  status        text not null default 'Pending',
  attachments   integer not null default 0,
  "submittedAt" timestamptz not null default now()
);
create index if not exists qr_tenant_idx   on public."QualityReport"("tenantId");
create index if not exists qr_building_idx on public."QualityReport"("buildingId");

create table if not exists public."Review" (
  id           text primary key,
  "tenantId"   text not null references public."Tenant"(id) on delete cascade,
  "buildingId" text not null references public."Building"(id),
  "requestId"  text references public."MaintenanceRequest"(id),
  rating       integer not null,
  comment      text not null default '',
  "createdAt"  timestamptz not null default now()
);
create index if not exists rev_building_idx on public."Review"("buildingId");

create table if not exists public."Broadcast" (
  id             text primary key,
  "buildingId"   text not null references public."Building"(id) on delete cascade,
  title          text not null,
  message        text not null,
  "sentBy"       text not null default 'Admin',
  "createdAt"    timestamptz not null default now(),
  "displayUntil" timestamptz not null,
  "dismissedBy"  text[] not null default '{}'::text[]
);
create index if not exists bc_building_idx on public."Broadcast"("buildingId", "createdAt" desc);
