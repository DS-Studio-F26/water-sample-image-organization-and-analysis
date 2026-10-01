-- =============================================================================
-- 001_init.sql -- Plan A schema for the Water Sample Image Catalog (Supabase)
--
-- Idempotent: safe to re-run. Applied by ProjectCode/deploy/apply_migrations.py,
-- which runs this whole file inside one transaction.
--
-- Security model in short:
--   * folders / images / qa_log are public, read-only data. The browser reads
--     them with the anon key; nobody can write them through the API. The import
--     script writes them over the direct DB connection as the table owner.
--   * profiles holds each account's role. A user can read only their own row.
--     Admins see everyone through admin_list_users(). Roles change only through
--     set_user_role(), which is admin-only and refuses to remove the last admin.
--
-- Duplicates: catalog_images.py already drops raw folders that have a -pp
-- counterpart, so there is no is_duplicate column. Folders with no images are
-- hidden by folders_visible.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- One row per sample-event folder; mirrors catalog_output/folder_summary.csv.
create table if not exists public.folders (
  folder_name      text primary key,
  site_raw         text,
  site_normalized  text,
  water_body_type  text,
  date             text,  -- as written in the folder name: M.D.YY or M.D.YYYY
  magnification    text,
  sample_code      text,
  capture_mode     text,
  dilution         text,
  is_pp            boolean not null,
  pp_of_folder     text,
  image_count      integer not null default 0,
  unreadable_count integer not null default 0,
  min_width        integer,
  max_width        integer,
  min_height       integer,
  max_height       integer
);

-- One row per image. Only per-image columns live here; site, date, sample code
-- etc. are identical for every image in a folder and come from folders.
create table if not exists public.images (
  image_id        text primary key,  -- sha1('<folder>/<filename>')[:16], from the manifest
  folder_name     text not null
                    references public.folders (folder_name)
                    deferrable initially deferred,
  filename        text not null,
  -- R2 object key. Built here so it is always '<folder>/<filename>' with a
  -- forward slash, regardless of which OS produced the manifest.
  relative_path   text generated always as (folder_name || '/' || filename) stored,
  width           integer,
  height          integer,
  file_size_bytes bigint,
  format          text,
  mode            text,
  is_readable     boolean not null default true,
  source_dataset  text,
  label           text  -- reserved for future labeling; nothing reads or writes it yet
);

create index if not exists images_folder_name_idx on public.images (folder_name);

create table if not exists public.qa_log (
  id         bigint generated always as identity primary key,
  level      text not null default 'INFO',
  target     text,
  detail     text,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  avatar_url text,
  provider   text,
  role       text not null default 'viewer'
               check (role in ('admin', 'labeler', 'viewer')),
  created_at timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- Folder dates are written M.D.YY or M.D.YYYY (two-digit years are 20xx).
-- Returns null for anything that isn't a real calendar date.
create or replace function public.parse_sample_date(d text)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  parts text[];
  y     int;
begin
  if d is null or d !~ '^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})$' then
    return null;
  end if;
  parts := string_to_array(d, '.');
  y := parts[3]::int;
  if y < 100 then
    y := y + 2000;
  end if;
  return make_date(y, parts[1]::int, parts[2]::int);
exception when others then
  return null;  -- e.g. 2.30.22
end;
$$;

-- "email", "google", or "email, google" once an account has linked both.
create or replace function public.provider_label(app_meta jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    (select string_agg(p, ', ' order by p)
       from jsonb_array_elements_text(
              case when jsonb_typeof(app_meta -> 'providers') = 'array'
                   then app_meta -> 'providers'
                   else '[]'::jsonb
              end) as p),
    app_meta ->> 'provider');
$$;


-- -----------------------------------------------------------------------------
-- Profiles: created and kept in sync from auth.users
-- -----------------------------------------------------------------------------

-- The project account becomes admin the first time its email is confirmed:
-- immediately for Google sign-in (Google emails arrive confirmed), or when the
-- confirmation link is clicked for email + password sign-up. Requiring a
-- confirmed email stops anyone from claiming admin by merely *registering*
-- the project address without access to its inbox.
create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_project_account boolean :=
    coalesce(lower(new.email) = 'watersampleimageorganization@gmail.com', false)
    and new.email_confirmed_at is not null;
  becomes_admin boolean;
begin
  if tg_op = 'INSERT' then
    becomes_admin := is_project_account;
  else
    becomes_admin := is_project_account
      and (old.email_confirmed_at is null
           or lower(old.email) is distinct from lower(new.email));
  end if;

  insert into public.profiles as p
    (id, email, full_name, avatar_url, provider, role, created_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    public.provider_label(new.raw_app_meta_data),
    case when becomes_admin then 'admin' else 'viewer' end,
    coalesce(new.created_at, now())
  )
  on conflict (id) do update set
    email      = excluded.email,
    full_name  = coalesce(excluded.full_name, p.full_name),
    avatar_url = coalesce(excluded.avatar_url, p.avatar_url),
    provider   = coalesce(excluded.provider, p.provider),
    role       = case when becomes_admin then 'admin' else p.role end;

  return new;
end;
$$;

-- "create or replace" rather than drop + create: auth.users belongs to
-- Supabase's auth role, and DROP TRIGGER would require owning the table.
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_change();

create or replace trigger on_auth_user_updated
  after update of email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data
  on auth.users
  for each row execute function public.handle_auth_user_change();

-- Accounts created before this migration ran get a profile too.
insert into public.profiles (id, email, full_name, avatar_url, provider, role, created_at)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
  coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture'),
  public.provider_label(u.raw_app_meta_data),
  case
    when lower(u.email) = 'watersampleimageorganization@gmail.com'
         and u.email_confirmed_at is not null
    then 'admin'
    else 'viewer'
  end,
  coalesce(u.created_at, now())
from auth.users u
on conflict (id) do nothing;

-- Never leave the project without an admin, whichever path tries it
-- (set_user_role, the Supabase dashboard, or deleting the auth user).
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role is distinct from 'admin') then
    -- Serialize admin removals so two concurrent demotions can't each see
    -- "one other admin left" and both succeed.
    perform pg_advisory_xact_lock(hashtext('public.profiles:last-admin-guard'));
    if not exists (
      select 1 from public.profiles where role = 'admin' and id <> old.id
    ) then
      raise exception 'Cannot remove the last admin'
        using errcode = 'P0001',
              hint = 'Make another user an admin first.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace trigger profiles_guard_last_admin
  before update of role or delete on public.profiles
  for each row execute function public.guard_last_admin();


-- -----------------------------------------------------------------------------
-- Role functions (called from the browser via supabase.rpc)
-- -----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.admin_list_users()
returns table (
  id              uuid,
  email           text,
  full_name       text,
  avatar_url      text,
  provider        text,
  role            text,
  created_at      timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      p.id,
      coalesce(u.email::text, p.email),
      p.full_name,
      p.avatar_url,
      coalesce(public.provider_label(u.raw_app_meta_data), p.provider),
      p.role,
      coalesce(u.created_at, p.created_at),
      u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by coalesce(u.created_at, p.created_at);
end;
$$;

create or replace function public.set_user_role(target uuid, new_role text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles' using errcode = '42501';
  end if;

  if new_role is null or new_role not in ('admin', 'labeler', 'viewer') then
    raise exception 'Invalid role "%": must be admin, labeler or viewer', new_role
      using errcode = '22023';
  end if;

  -- profiles_guard_last_admin raises if this would remove the last admin.
  update public.profiles set role = new_role where id = target;
  if not found then
    raise exception 'No user with id %', target using errcode = 'P0002';
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- Views (security_invoker: the caller's own permissions and RLS apply)
-- -----------------------------------------------------------------------------
-- Everything aggregates the 613-row folders table, never the 500K-row images
-- table. folders.image_count and the dimension ranges come from
-- folder_summary.csv, and the import script verifies they match the images
-- it loads before committing.

drop view if exists public.chart_water_body_counts;
drop view if exists public.chart_date_counts;
drop view if exists public.chart_site_counts;
drop view if exists public.dashboard_stats;
drop view if exists public.folders_visible;

create view public.folders_visible
with (security_invoker = true) as
select
  f.folder_name,
  f.site_raw,
  f.site_normalized,
  f.water_body_type,
  f.date,
  public.parse_sample_date(f.date) as sample_date,
  f.magnification,
  f.sample_code,
  f.capture_mode,
  f.dilution,
  f.is_pp,
  f.pp_of_folder,
  f.image_count,
  f.unreadable_count,
  f.min_width,
  f.max_width,
  f.min_height,
  f.max_height
from public.folders f
where f.image_count > 0;

create view public.dashboard_stats
with (security_invoker = true) as
select
  count(*)::int                                                 as total_folders,
  coalesce(sum(image_count), 0)::bigint                         as total_images,
  count(distinct site_normalized)::int                          as unique_sites,
  min(sample_date)                                              as first_date,
  max(sample_date)                                              as last_date,
  (count(*) filter (where is_pp))::int                          as pp_folders,
  (count(*) filter (where not is_pp))::int                      as raw_folders,
  coalesce(sum(image_count) filter (where is_pp), 0)::bigint     as pp_images,
  coalesce(sum(image_count) filter (where not is_pp), 0)::bigint as raw_images
from public.folders_visible;

create view public.chart_site_counts
with (security_invoker = true) as
select
  coalesce(site_normalized, 'Unknown') as site_normalized,
  sum(image_count)::bigint             as image_count,
  count(*)::int                        as folder_count
from public.folders_visible
group by 1
order by image_count desc, site_normalized;

-- Monthly buckets, matching the "Images by Collection Date" chart.
create view public.chart_date_counts
with (security_invoker = true) as
select
  date_trunc('month', sample_date)::date as month,
  sum(image_count)::bigint               as image_count,
  count(*)::int                          as folder_count
from public.folders_visible
where sample_date is not null
group by 1
order by 1;

create view public.chart_water_body_counts
with (security_invoker = true) as
select
  coalesce(water_body_type, 'Unknown') as water_body_type,
  count(*)::int                        as folder_count,
  sum(image_count)::bigint             as image_count
from public.folders_visible
group by 1
order by folder_count desc, water_body_type;


-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- No INSERT/UPDATE/DELETE policies anywhere, so the API can't write these
-- tables. The import connects as the table owner, which RLS doesn't restrict.

alter table public.folders  enable row level security;
alter table public.images   enable row level security;
alter table public.qa_log   enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "Anyone can read folders" on public.folders;
create policy "Anyone can read folders"
  on public.folders for select to anon, authenticated using (true);

drop policy if exists "Anyone can read images" on public.images;
create policy "Anyone can read images"
  on public.images for select to anon, authenticated using (true);

drop policy if exists "Anyone can read the QA log" on public.qa_log;
create policy "Anyone can read the QA log"
  on public.qa_log for select to anon, authenticated using (true);

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
-- Supabase grants anon/authenticated ALL on new objects by default. Narrow it
-- to read-only, so writes are blocked by privileges as well as by RLS.

revoke all on table
  public.folders, public.images, public.qa_log, public.profiles,
  public.folders_visible, public.dashboard_stats,
  public.chart_site_counts, public.chart_date_counts, public.chart_water_body_counts
  from anon, authenticated;

grant select on table
  public.folders, public.images, public.qa_log,
  public.folders_visible, public.dashboard_stats,
  public.chart_site_counts, public.chart_date_counts, public.chart_water_body_counts
  to anon, authenticated;

grant select on table public.profiles to authenticated;

revoke all on sequence public.qa_log_id_seq from anon, authenticated;

-- Role functions: signed-in users only (each one checks for admin itself).
revoke all on function public.is_admin()                 from public, anon, authenticated;
revoke all on function public.admin_list_users()         from public, anon, authenticated;
revoke all on function public.set_user_role(uuid, text)  from public, anon, authenticated;
grant execute on function public.is_admin()                to authenticated;
grant execute on function public.admin_list_users()        to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Internal helpers and trigger functions: not callable through the API.
-- (parse_sample_date stays executable: folders_visible runs it as the caller.)
revoke all on function public.provider_label(jsonb)       from public, anon, authenticated;
revoke all on function public.handle_auth_user_change()   from public, anon, authenticated;
revoke all on function public.guard_last_admin()          from public, anon, authenticated;
