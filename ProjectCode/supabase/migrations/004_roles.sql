-- =============================================================================
-- 004_roles.sql -- the Owner role and role requests
--
-- Idempotent, like the others. Applied by apply_migrations.py after 003.
-- That script re-runs every file, so on each run 001 and 002 first put back
-- their own versions of the functions below and this file then replaces them
-- again. Every function here therefore keeps the signature 001/002 gave it
-- (create or replace can't change a function's arguments or result columns).
--
-- What this adds:
--   * An 'owner' role, held only by watersampleimageorganization@gmail.com.
--     The Owner can do everything an admin can. Nobody can be made Owner, and
--     the Owner's role can't be changed through the site, not even by the Owner.
--   * Only the Owner can change another admin's role. Admins can still change
--     their own role, and anyone's who isn't an admin.
--   * role_requests: a signed-in viewer can ask for the labeler or admin role,
--     a labeler for admin. Admins approve or decline on the admin page.
--   * team_labeling_progress(): how much each person has labeled, for
--     labelers as well as admins. Names only, never email addresses.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The owner role
-- -----------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'admin', 'labeler', 'viewer'));

-- There is only ever one Owner.
create unique index if not exists profiles_one_owner_idx
  on public.profiles (role) where role = 'owner';

-- viewer < labeler < admin < owner, for "already has that role or higher".
create or replace function public.role_rank(role_name text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case role_name
    when 'owner'   then 4
    when 'admin'   then 3
    when 'labeler' then 2
    else 1
  end;
$$;


-- -----------------------------------------------------------------------------
-- Role checks: the Owner counts as an admin everywhere
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
    where id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.can_label()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('owner', 'admin', 'labeler')
  );
$$;

-- 001's guard, with the Owner counted as an admin. Replaced before the Owner
-- is set below: 001's version would see admin -> owner as removing an admin.
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role in ('owner', 'admin')
     and (tg_op = 'DELETE' or new.role not in ('owner', 'admin')) then
    -- Serialize admin removals so two concurrent demotions can't each see
    -- "one other admin left" and both succeed.
    perform pg_advisory_xact_lock(hashtext('public.profiles:last-admin-guard'));
    if not exists (
      select 1 from public.profiles where role in ('owner', 'admin') and id <> old.id
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


-- -----------------------------------------------------------------------------
-- The project account becomes the Owner
-- -----------------------------------------------------------------------------

-- 001's trigger function, giving 'owner' instead of 'admin'. Same rule: only
-- once the project address is confirmed, so registering it isn't enough.
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
  becomes_owner boolean;
begin
  if tg_op = 'INSERT' then
    becomes_owner := is_project_account;
  else
    becomes_owner := is_project_account
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
    case when becomes_owner then 'owner' else 'viewer' end,
    coalesce(new.created_at, now())
  )
  on conflict (id) do update set
    email      = excluded.email,
    full_name  = coalesce(excluded.full_name, p.full_name),
    avatar_url = coalesce(excluded.avatar_url, p.avatar_url),
    provider   = coalesce(excluded.provider, p.provider),
    role       = case when becomes_owner then 'owner' else p.role end;

  return new;
end;
$$;

-- The project account already has a profile (as admin, from 001).
update public.profiles p
   set role = 'owner'
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'watersampleimageorganization@gmail.com'
   and u.email_confirmed_at is not null
   and p.role <> 'owner';


-- -----------------------------------------------------------------------------
-- Role requests
-- -----------------------------------------------------------------------------

-- One row per account: its latest request. A new request replaces it.
create table if not exists public.role_requests (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  requested_role text not null check (requested_role in ('admin', 'labeler')),
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'declined')),
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     uuid references auth.users (id) on delete set null
);

create or replace function public.request_role(requested text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  my_role text;
begin
  select role into my_role from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Sign in to request a role' using errcode = '42501';
  end if;

  if requested is null or requested not in ('admin', 'labeler') then
    raise exception 'Invalid request "%": you can ask for admin or labeler', requested
      using errcode = '22023';
  end if;

  if public.role_rank(my_role) >= public.role_rank(requested) then
    raise exception 'You already have that role or a higher one' using errcode = '22023';
  end if;

  insert into public.role_requests (user_id, requested_role)
  values (auth.uid(), requested)
  on conflict (user_id) do update set
    requested_role = excluded.requested_role,
    status         = 'pending',
    requested_at   = now(),
    decided_at     = null,
    decided_by     = null;
end;
$$;

create or replace function public.cancel_role_request()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.role_requests where user_id = auth.uid() and status = 'pending';
$$;


-- -----------------------------------------------------------------------------
-- Changing roles
-- -----------------------------------------------------------------------------

create or replace function public.set_user_role(target uuid, new_role text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  old_role text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles' using errcode = '42501';
  end if;

  -- 'owner' is deliberately not on the list: nobody can be made Owner.
  if new_role is null or new_role not in ('admin', 'labeler', 'viewer') then
    raise exception 'Invalid role "%": must be admin, labeler or viewer', new_role
      using errcode = '22023';
  end if;

  select role into old_role from public.profiles where id = target for update;
  if not found then
    raise exception 'No user with id %', target using errcode = 'P0002';
  end if;

  if old_role = 'owner' then
    raise exception 'The Owner''s role can''t be changed' using errcode = '42501';
  end if;
  if old_role = 'admin' and target <> auth.uid() and not public.is_owner() then
    raise exception 'Only the Owner can change another admin''s role' using errcode = '42501';
  end if;

  -- profiles_guard_last_admin raises if this would remove the last admin.
  update public.profiles set role = new_role where id = target;

  -- Giving the role asked for (or a higher one) answers an open request.
  update public.role_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where user_id = target
     and status = 'pending'
     and public.role_rank(new_role) >= public.role_rank(requested_role);
end;
$$;

create or replace function public.review_role_request(target uuid, approve boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  wanted text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can review role requests' using errcode = '42501';
  end if;

  if approve is null then
    raise exception 'approve must be true or false' using errcode = '22023';
  end if;

  select requested_role into wanted from public.role_requests
   where user_id = target and status = 'pending'
   for update;
  if not found then
    raise exception 'This account has no open role request'
      using errcode = 'P0002',
            hint = 'It may have been cancelled or already reviewed. Refresh the page.';
  end if;

  if approve then
    -- The same rules as changing the role by hand; this also marks it approved.
    perform public.set_user_role(target, wanted);
  else
    update public.role_requests
       set status = 'declined', decided_at = now(), decided_by = auth.uid()
     where user_id = target;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- Labeling progress for labelers
-- -----------------------------------------------------------------------------

-- Like admin_labeling_by_user() (002), but for anyone who can label, and with
-- no email addresses or account ids: is_me lets the page mark your own row.
create or replace function public.team_labeling_progress()
returns table (
  full_name       text,
  role            text,
  is_me           boolean,
  labeled_count   bigint,
  last_labeled_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_label() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      p.full_name,
      p.role,
      p.id = auth.uid(),
      count(*),
      max(i.labeled_date)
    from public.images i
    join public.profiles p on p.id = i.labeled_by
    group by p.id, p.full_name, p.role
    order by count(*) desc, p.full_name;
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------

-- Read-only through the API, like profiles: the functions above do the writing.
alter table public.role_requests enable row level security;

drop policy if exists "Users read their own request, admins read all" on public.role_requests;
create policy "Users read their own request, admins read all"
  on public.role_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on table public.role_requests from anon, authenticated;
grant select on table public.role_requests to authenticated;

revoke all on function public.role_rank(text)                     from public, anon, authenticated;
revoke all on function public.is_owner()                          from public, anon, authenticated;
revoke all on function public.request_role(text)                  from public, anon, authenticated;
revoke all on function public.cancel_role_request()               from public, anon, authenticated;
revoke all on function public.review_role_request(uuid, boolean)  from public, anon, authenticated;
revoke all on function public.team_labeling_progress()            from public, anon, authenticated;
grant execute on function public.is_owner()                         to authenticated;
grant execute on function public.request_role(text)                 to authenticated;
grant execute on function public.cancel_role_request()              to authenticated;
grant execute on function public.review_role_request(uuid, boolean) to authenticated;
grant execute on function public.team_labeling_progress()           to authenticated;
