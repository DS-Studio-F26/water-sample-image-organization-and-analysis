-- =============================================================================
-- 002_labeling.sql -- image labeling for the Water Sample Image Catalog
--
-- Idempotent, like 001_init.sql. Applied by apply_migrations.py after 001
-- (filename order).
--
-- What this adds:
--   * images.labeled_by / images.labeled_date, set automatically by a trigger
--     -- never taken from the client, so a labeler can't backdate a label or
--     attribute it to someone else.
--   * Admins and labelers can update images.label (and only that column; the
--     API has no privilege on any other column of images). Everyone else
--     still only has SELECT, same as 001.
--   * Read-only progress views (folder_labeling_progress, labeling_stats,
--     label_counts) and a my_labeling_count()/admin_labeling_by_user() pair
--     for the "who's labeled what" breakdown on the admin page.
--
-- import_to_supabase.py already reserves label/labeled_by/labeled_date and
-- never writes them (see IMAGE_COLUMNS / LABEL_COLUMNS there), so re-running
-- the importer after this migration does not touch or clear labels.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------

alter table public.images
  add column if not exists labeled_by   uuid references auth.users (id) on delete set null,
  add column if not exists labeled_date timestamptz;

create index if not exists images_label_idx      on public.images (label)      where label is not null;
create index if not exists images_labeled_by_idx on public.images (labeled_by) where labeled_by is not null;


-- -----------------------------------------------------------------------------
-- Role check and label-metadata trigger
-- -----------------------------------------------------------------------------

create or replace function public.can_label()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'labeler')
  );
$$;

-- Fires on every update to images, including the importer's own upserts (which
-- never change label, so this is a no-op for them). When label actually
-- changes, stamps who/when; clearing a label (set to null) clears both too.
-- Client-supplied labeled_by/labeled_date are always overwritten here, which
-- is the real enforcement -- the column grant below is only the first layer.
create or replace function public.images_set_labeled_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.label is distinct from old.label then
    if new.label is null then
      new.labeled_by := null;
      new.labeled_date := null;
    else
      new.labeled_by := auth.uid();
      new.labeled_date := now();
    end if;
  else
    new.labeled_by := old.labeled_by;
    new.labeled_date := old.labeled_date;
  end if;
  return new;
end;
$$;

create or replace trigger images_set_labeled_meta
  before update on public.images
  for each row execute function public.images_set_labeled_meta();


-- -----------------------------------------------------------------------------
-- Progress views and per-user functions
-- -----------------------------------------------------------------------------

drop view if exists public.folder_labeling_progress;
drop view if exists public.labeling_stats;
drop view if exists public.label_counts;

create view public.folder_labeling_progress
with (security_invoker = true) as
select
  f.folder_name,
  f.site_normalized,
  f.image_count,
  coalesce(l.labeled_count, 0)::int                as labeled_count,
  (f.image_count - coalesce(l.labeled_count, 0))::int as unlabeled_count,
  case when f.image_count > 0
       then round(100.0 * coalesce(l.labeled_count, 0) / f.image_count, 1)
       else 0 end                                   as pct_labeled
from public.folders_visible f
left join (
  select folder_name, count(*) as labeled_count
  from public.images
  where label is not null
  group by folder_name
) l using (folder_name)
order by f.folder_name;

create view public.labeling_stats
with (security_invoker = true) as
select
  count(*)::bigint                                                  as total_images,
  count(*) filter (where label is not null)::bigint                 as labeled_images,
  count(*) filter (where label is null)::bigint                     as unlabeled_images,
  case when count(*) > 0
       then round(100.0 * count(*) filter (where label is not null) / count(*), 1)
       else 0 end                                                   as pct_labeled,
  count(distinct labeled_by)::int                                   as labeler_count,
  max(labeled_date)                                                 as last_labeled_at
from public.images;

create view public.label_counts
with (security_invoker = true) as
select label, count(*)::bigint as image_count
from public.images
where label is not null
group by label
order by image_count desc, label;

create or replace function public.my_labeling_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.images where labeled_by = auth.uid();
$$;

-- Admin-only: how much each account has labeled. Mirrors admin_list_users().
create or replace function public.admin_labeling_by_user()
returns table (
  id              uuid,
  email           text,
  full_name       text,
  role            text,
  labeled_count   bigint,
  last_labeled_at timestamptz
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
      p.role,
      count(i.image_id),
      max(i.labeled_date)
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.images i on i.labeled_by = p.id
    group by p.id, u.email, p.email, p.full_name, p.role
    order by count(i.image_id) desc, coalesce(u.email::text, p.email);
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------

drop policy if exists "Labelers can set the label" on public.images;
create policy "Labelers can set the label"
  on public.images for update to authenticated
  using (public.can_label())
  with check (public.can_label());

-- Column-level grant: even an admin/labeler's UPDATE is rejected by Postgres
-- itself if its SET list touches anything but label. labeled_by/labeled_date
-- are never granted, so only the trigger above (security definer) sets them.
grant update (label) on table public.images to authenticated;

revoke all on table
  public.folder_labeling_progress, public.labeling_stats, public.label_counts
  from anon, authenticated;
grant select on table
  public.folder_labeling_progress, public.labeling_stats, public.label_counts
  to anon, authenticated;

revoke all on function public.can_label()               from public, anon, authenticated;
revoke all on function public.images_set_labeled_meta()  from public, anon, authenticated;
revoke all on function public.my_labeling_count()        from public, anon, authenticated;
revoke all on function public.admin_labeling_by_user()   from public, anon, authenticated;
grant execute on function public.can_label()             to authenticated;
grant execute on function public.my_labeling_count()     to authenticated;
grant execute on function public.admin_labeling_by_user() to authenticated;
