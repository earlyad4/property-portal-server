-- Tenant: add missing columns
  alter table public."Tenant"                                                                                           
    add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null,
    add column if not exists push_token   text,                                                                         
    add column if not exists is_verified  boolean not null default false,                                               
    add column if not exists created_at   timestamptz not null default now();
                                                                                                                        
  create index if not exists tenant_auth_idx on public."Tenant"(auth_user_id);                                          
   
  -- MaintenanceRequest: add missing column                                                                             
  alter table public."MaintenanceRequest"                   
    add column if not exists updated_at timestamptz not null default now();

  -- TicketMessage: add missing column (fixes 0002 error)                                                               
  alter table public."TicketMessage"
    add column if not exists author_kind text not null default 'admin';                                                 
                                                            
  -- Document: add missing column
  alter table public."Document"
    add column if not exists "fileUrl" text;                                                                            
   
  -- New tables                                                                                                         
  create table if not exists public."AdminUser" (           
    id             uuid primary key default gen_random_uuid(),
    email          text unique not null,
    name           text not null,
    password_hash  text not null,                                                                                       
    role           text not null default 'admin',
    is_active      boolean not null default true,                                                                       
    created_at     timestamptz not null default now(),      
    last_login_at  timestamptz
  );
                                                                                                                        
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