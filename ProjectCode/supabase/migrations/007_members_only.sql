-- =============================================================================
-- 007_members_only.sql -- members-only catalog, who labeled an image, invites
--
-- Idempotent, like the others. Applied by apply_migrations.py after 006, in the
-- same transaction as every other file, so 001-006 putting back their "anyone
-- can read" policies on each run is never visible: this file removes them again
-- before anything commits.
--
-- What this adds:
--   * Only approved members (labeler, admin, owner) can read the catalog: the
--     folders, images, QA log, measurements, label list and every view and
--     function built on them. Visitors who aren't signed in get nothing, and
--     signed-in viewers get empty results. Viewers keep what the admin page
--     needs: their own profile and their own role request.
--   * labeler_names(): the name of everyone who has labeled an image, so the
--     pages can say who gave a label. Names only; admins also get the email
--     address of an account that has no name.
--   * invites: an admin invites an email address as a labeler or an admin. The
--     role is given when that address signs in with a confirmed email (Google,
--     or email + password once the confirmation link is clicked). An address
--     that already has a confirmed account gets the role straight away. The
--     database sends no email: the admin page writes the invitation for the
--     admin to send.
--
-- The images in R2 and the measurement filter files are served by the image
-- Worker, which doesn't check sign-ins, so someone who already knows an
-- image's address can still open it.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Members only: approved accounts read the catalog, nobody else
-- -----------------------------------------------------------------------------

drop policy if exists "Anyone can read folders" on public.folders;
drop policy if exists "Members can read folders" on public.folders;
create policy "Members can read folders"
  on public.folders for select to authenticated
  using ((select public.can_label()));

drop policy if exists "Anyone can read images" on public.images;
drop policy if exists "Members can read images" on public.images;
create policy "Members can read images"
  on public.images for select to authenticated
  using ((select public.can_label()));

drop policy if exists "Anyone can read the QA log" on public.qa_log;
drop policy if exists "Members can read the QA log" on public.qa_log;
create policy "Members can read the QA log"
  on public.qa_log for select to authenticated
  using ((select public.can_label()));

drop policy if exists "Anyone can read measurement columns" on public.measurement_columns;
drop policy if exists "Members can read measurement columns" on public.measurement_columns;
create policy "Members can read measurement columns"
  on public.measurement_columns for select to authenticated
  using ((select public.can_label()));

drop policy if exists "Anyone can read the label list" on public.label_options;
drop policy if exists "Members can read the label list" on public.label_options;
create policy "Members can read the label list"
  on public.label_options for select to authenticated
  using ((select public.can_label()));

-- The views are security_invoker, so the policies above already apply to
-- them; taking the privilege away from anon as well makes signed-out requests
-- fail outright instead of returning empty rows.
revoke select on table
  public.folders, public.images, public.qa_log, public.measurement_columns, public.label_options,
  public.folders_visible, public.dashboard_stats,
  public.chart_site_counts, public.chart_date_counts, public.chart_water_body_counts,
  public.folder_labeling_progress, public.labeling_stats, public.label_counts
  from anon;

-- measurement_folder_counts() runs as the caller, so RLS covers it too.
revoke all on function public.measurement_folder_counts(jsonb) from public, anon;

-- 006's function runs as its owner (it reads pending_labels), so it checks
-- for a member itself. Same signature, so folder_labeling_progress keeps using it.
create or replace function public.pending_label_counts()
returns table (folder_name text, pending_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select i.folder_name, count(*)
  from public.pending_labels p
  join public.images i on i.image_id = p.image_id
  where i.label is null and public.can_label()
  group by i.folder_name;
$$;

revoke all on function public.pending_label_counts() from public, anon, authenticated;
grant execute on function public.pending_label_counts() to authenticated;


-- -----------------------------------------------------------------------------
-- Who labeled an image
-- -----------------------------------------------------------------------------
-- images.labeled_by holds an account id. This turns the ids into names for the
-- people who can read the images anyway. Labelers see names only, as on the
-- admin page's progress table (004's team_labeling_progress).

create or replace function public.labeler_names()
returns table (id uuid, name text)
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
    select p.id,
           coalesce(nullif(btrim(p.full_name), ''),
                    case when public.is_admin() then p.email end,
                    'Unnamed account')
    from public.profiles p
    where exists (select 1 from public.images i where i.labeled_by = p.id);
end;
$$;


-- -----------------------------------------------------------------------------
-- Invites
-- -----------------------------------------------------------------------------

-- One row per address: its latest invite. A new invite replaces it.
create table if not exists public.invites (
  email       text primary key
                check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role        text not null check (role in ('admin', 'labeler')),
  invited_by  uuid references auth.users (id) on delete set null,
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null
);

-- Gives a confirmed account the role its address was invited as. Never lowers
-- a role and never touches the Owner. Called by the sign-in trigger below.
create or replace function public.apply_invite(account uuid, address text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  inv public.invites%rowtype;
begin
  select * into inv from public.invites
   where email = lower(btrim(address)) and accepted_at is null
   for update;
  if not found then
    return;
  end if;

  update public.profiles
     set role = inv.role
   where id = account
     and role <> 'owner'
     and public.role_rank(role) < public.role_rank(inv.role);

  -- An open request for that role (or a lower one) is answered by the invite.
  update public.role_requests
     set status = 'approved', decided_at = now(), decided_by = inv.invited_by
   where user_id = account
     and status = 'pending'
     and public.role_rank(inv.role) >= public.role_rank(requested_role);

  update public.invites
     set accepted_at = now(), accepted_by = account
   where email = inv.email;
end;
$$;

-- 004's trigger function, plus the invite check once the address is confirmed.
-- A failed invite check must never stop anyone from signing in, so its errors
-- only become warnings in the database log.
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

  if new.email is not null and new.email_confirmed_at is not null and not is_project_account then
    begin
      perform public.apply_invite(new.id, new.email);
    exception when others then
      raise warning 'Invite for % not applied: %', new.email, sqlerrm;
    end;
  end if;

  return new;
end;
$$;

-- Invite an address as a labeler or an admin (any admin may invite either,
-- as any admin may give either role on the accounts table). Returns
-- 'applied' when a confirmed account with that address already exists and
-- now has the role, or 'invited' when it's waiting for that address to sign in.
create or replace function public.admin_invite(invite_email text, invite_role text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  addr     text := lower(btrim(coalesce(invite_email, '')));
  target   uuid;
  cur_role text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can invite people' using errcode = '42501';
  end if;

  if invite_role is null or invite_role not in ('admin', 'labeler') then
    raise exception 'Invalid role "%": invite as admin or labeler', invite_role using errcode = '22023';
  end if;
  if addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if addr = 'watersampleimageorganization@gmail.com' then
    raise exception 'That address is the Owner''s account' using errcode = '22023';
  end if;

  select u.id, p.role into target, cur_role
    from auth.users u
    join public.profiles p on p.id = u.id
   where lower(u.email) = addr and u.email_confirmed_at is not null
   limit 1;

  if found then
    if public.role_rank(cur_role) >= public.role_rank(invite_role) then
      raise exception '% already has the % role', addr, cur_role
        using errcode = '22023',
              hint = 'Change it on the accounts table instead.';
    end if;
    -- The same rules as changing the role by hand; this also answers a request.
    perform public.set_user_role(target, invite_role);
    insert into public.invites as i (email, role, invited_by, invited_at, accepted_at, accepted_by)
    values (addr, invite_role, auth.uid(), now(), now(), target)
    on conflict (email) do update set
      role = excluded.role, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
      accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by;
    return 'applied';
  end if;

  insert into public.invites as i (email, role, invited_by)
  values (addr, invite_role, auth.uid())
  on conflict (email) do update set
    role = excluded.role, invited_by = excluded.invited_by, invited_at = now(),
    accepted_at = null, accepted_by = null;
  return 'invited';
end;
$$;

-- Withdraw an invite nobody has used yet.
create or replace function public.admin_cancel_invite(invite_email text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can cancel invites' using errcode = '42501';
  end if;
  delete from public.invites
   where email = lower(btrim(coalesce(invite_email, ''))) and accepted_at is null;
  if not found then
    raise exception 'No open invite for %', invite_email
      using errcode = 'P0002', hint = 'It may already have been used or cancelled. Refresh the page.';
  end if;
end;
$$;

-- Anyone invited before this ran and already confirmed gets the role now
-- (only matters on a re-run after invites were added by hand).
do $$
declare
  r record;
begin
  for r in
    select u.id, u.email from auth.users u
    join public.invites i on i.email = lower(u.email) and i.accepted_at is null
    where u.email_confirmed_at is not null
      and lower(u.email) <> 'watersampleimageorganization@gmail.com'
  loop
    perform public.apply_invite(r.id, r.email);
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------

-- Admins read the invites; the functions above do the writing.
alter table public.invites enable row level security;

drop policy if exists "Admins read invites" on public.invites;
create policy "Admins read invites"
  on public.invites for select to authenticated
  using ((select public.is_admin()));

revoke all on table public.invites from anon, authenticated;
grant select on table public.invites to authenticated;

revoke all on function public.labeler_names()                from public, anon, authenticated;
revoke all on function public.apply_invite(uuid, text)       from public, anon, authenticated;
revoke all on function public.admin_invite(text, text)       from public, anon, authenticated;
revoke all on function public.admin_cancel_invite(text)      from public, anon, authenticated;
revoke all on function public.handle_auth_user_change()      from public, anon, authenticated;
grant execute on function public.labeler_names()             to authenticated;
grant execute on function public.admin_invite(text, text)    to authenticated;
grant execute on function public.admin_cancel_invite(text)   to authenticated;
