-- =============================================================================
-- 005_label_options.sql -- the label list, shared by everyone
--
-- Idempotent, like the others. Applied by apply_migrations.py after 004.
--
-- What this adds:
--   * label_options: every label that can go in images.label, each with its
--     category (Cyanobacteria, Other significant, or Non-organism / Unsure).
--     It starts with the agreed list below; labelers add more from the
--     labeling page ("Enter new label"), and everyone sees them straight away.
--   * images.label must name a row of label_options. The check runs only when
--     a label changes, so the importer's upserts (which never change labels)
--     skip it.
--   * Admins can change a label's category at any time, and rename or delete
--     a label that no image uses yet: admin_update_label(), admin_delete_label().
--   * Labels from before this list (cyanobacteria, diatom, debris, blank,
--     unsure, other_organism) are cleared, as agreed: the old placeholder set
--     isn't kept. After the first run there are none left, so re-running this
--     file clears nothing.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The table
-- -----------------------------------------------------------------------------

create table if not exists public.label_options (
  -- What images.label stores, and what people see. Exact duplicates are
  -- refused; near-duplicates ("microcystis" next to "Microcystis") are allowed.
  name        text primary key
                check (length(name) between 1 and 60 and name = btrim(name)),
  category    text not null
                check (category in ('cyanobacteria', 'other_significant', 'non_organism')),
  is_builtin  boolean not null default false,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- Tidies the name (no outer spaces, no runs of spaces) and, for rows added
-- through the API, stamps who added it. A labeler can't add a "built-in" label
-- or attribute one to someone else.
create or replace function public.label_options_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.name := regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g');
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.is_builtin := false;
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  return new;
end;
$$;

create or replace trigger label_options_before_write
  before insert or update on public.label_options
  for each row execute function public.label_options_before_write();


-- -----------------------------------------------------------------------------
-- The agreed starting list
-- -----------------------------------------------------------------------------

insert into public.label_options (name, category, is_builtin) values
  ('Aphanizomenon',      'cyanobacteria',     true),
  ('Dolichospermum',     'cyanobacteria',     true),
  ('Microcystis',        'cyanobacteria',     true),
  ('Oscillatoria',       'cyanobacteria',     true),
  ('Woronichinia',       'cyanobacteria',     true),
  ('Microcystis Debris', 'cyanobacteria',     true),
  ('Staurastrum',        'other_significant', true),
  ('Fragilaria',         'other_significant', true),
  ('Dinobryon',          'other_significant', true),
  ('Centric Diatom',     'other_significant', true),
  ('Blank / empty',      'non_organism',      true),
  ('Unsure',             'non_organism',      true)
on conflict (name) do nothing;


-- -----------------------------------------------------------------------------
-- Old placeholder labels go
-- -----------------------------------------------------------------------------
-- Uses the partial index on images.label, so it never reads the whole table.
-- images_set_labeled_meta (002) clears labeled_by/labeled_date with the label.

update public.images
   set label = null
 where label is not null
   and not exists (select 1 from public.label_options o where o.name = images.label);


-- -----------------------------------------------------------------------------
-- images.label must be on the list
-- -----------------------------------------------------------------------------
-- A trigger rather than a foreign key: adding a foreign key would check every
-- row of the ~300 MB images table, and this only looks at rows whose label
-- actually changes. "for share" stops an admin deleting the label at the same
-- moment (admin_delete_label locks the row "for update").

create or replace function public.images_check_label()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.label is not null and new.label is distinct from old.label then
    perform 1 from public.label_options where name = new.label for share;
    if not found then
      raise exception 'Unknown label "%"', new.label
        using errcode = '23503',
              hint = 'Add it with "Enter new label" first, or refresh the page.';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger images_check_label
  before update of label on public.images
  for each row execute function public.images_check_label();


-- -----------------------------------------------------------------------------
-- Admin changes
-- -----------------------------------------------------------------------------

-- Change a label's category (always allowed) and/or its name (only while no
-- image uses it, so no label in images.label ever changes behind a labeler's back).
create or replace function public.admin_update_label(label_name text, new_name text, new_category text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  cleaned text := regexp_replace(btrim(coalesce(new_name, '')), '\s+', ' ', 'g');
begin
  if not public.is_admin() then
    raise exception 'Only admins can change labels' using errcode = '42501';
  end if;

  perform 1 from public.label_options where name = label_name for update;
  if not found then
    raise exception 'No label called "%"', label_name using errcode = 'P0002',
      hint = 'It may have been renamed or deleted. Refresh the page.';
  end if;

  if new_category is null or new_category not in ('cyanobacteria', 'other_significant', 'non_organism') then
    raise exception 'Invalid category "%"', new_category using errcode = '22023';
  end if;

  if cleaned = '' then
    raise exception 'A label needs a name' using errcode = '22023';
  end if;

  if cleaned is distinct from label_name then
    if exists (select 1 from public.images where label = label_name) then
      raise exception 'Images already use "%", so it can''t be renamed', label_name
        using errcode = '22023', hint = 'You can still change its category.';
    end if;
    if exists (select 1 from public.label_options where name = cleaned) then
      raise exception 'There is already a label called "%"', cleaned using errcode = '23505';
    end if;
  end if;

  update public.label_options
     set name = cleaned, category = new_category
   where name = label_name;
end;
$$;

create or replace function public.admin_delete_label(label_name text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete labels' using errcode = '42501';
  end if;

  perform 1 from public.label_options where name = label_name for update;
  if not found then
    raise exception 'No label called "%"', label_name using errcode = 'P0002',
      hint = 'It may already have been deleted. Refresh the page.';
  end if;

  if exists (select 1 from public.images where label = label_name) then
    raise exception 'Images use "%", so it can''t be deleted', label_name
      using errcode = '22023', hint = 'Relabel those images first.';
  end if;

  delete from public.label_options where name = label_name;
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------

alter table public.label_options enable row level security;

drop policy if exists "Anyone can read the label list" on public.label_options;
create policy "Anyone can read the label list"
  on public.label_options for select to anon, authenticated
  using (true);

drop policy if exists "Labelers can add labels" on public.label_options;
create policy "Labelers can add labels"
  on public.label_options for insert to authenticated
  with check (public.can_label());

-- Only the name and category can be sent; the trigger fills in the rest.
-- Changing and deleting go through the admin functions above.
revoke all on table public.label_options from anon, authenticated;
grant select on table public.label_options to anon, authenticated;
grant insert (name, category) on table public.label_options to authenticated;

revoke all on function public.label_options_before_write()          from public, anon, authenticated;
revoke all on function public.images_check_label()                  from public, anon, authenticated;
revoke all on function public.admin_update_label(text, text, text)  from public, anon, authenticated;
revoke all on function public.admin_delete_label(text)              from public, anon, authenticated;
grant execute on function public.admin_update_label(text, text, text) to authenticated;
grant execute on function public.admin_delete_label(text)             to authenticated;
