-- =============================================================================
-- 003_measurements.sql -- FlowCam particle measurements for every image
--
-- Idempotent, like 001 and 002. Applied by apply_migrations.py after them.
--
-- What this adds:
--   * 62 "real" columns on images, one per FlowCam measurement that varies
--     (diameter, area, shape, colour, fluorescence, ...). They come from the
--     VBD files via Flowcam_VBD_File_Format/export_all.py and catalog_images.py,
--     and deploy/import_measurements.py fills them. Images with no FlowCam
--     record keep them null. (18 more FlowCam fields are zero for every
--     particle in our data, so they aren't stored.)
--   * measurement_columns: one row per filterable measurement -- these 62 plus
--     the existing pixel width/height -- with its label, unit and group for the
--     dashboard, and min/max/percentiles that import_measurements.py fills in.
--   * measurement_folder_counts(filters): how many images in each folder fall
--     inside a set of measurement ranges, for scripts. (The dashboard counts
--     in the browser from deploy/build_filter_data.py's files: this reads the
--     whole images table, 8-12 s on the free tier.)
--
-- The columns live on images itself rather than in a table of their own:
-- that saves a second copy of every image_id, its index and a row header,
-- about 60 MB of the free tier's 500 MB.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
-- Adding a nullable column without a default only changes the catalog, so this
-- doesn't rewrite the table. FlowCam's "width" and "length" become
-- particle_width / particle_length: images.width is the image's pixel width.

alter table public.images
  add column if not exists diameter_esd          real,
  add column if not exists diameter_abd          real,
  add column if not exists diameter_fd           real,
  add column if not exists particle_length       real,
  add column if not exists particle_width        real,
  add column if not exists area_abd              real,
  add column if not exists area_filled           real,
  add column if not exists perimeter             real,
  add column if not exists convex_perimeter      real,
  add column if not exists geodesic_length       real,
  add column if not exists geodesic_thickness    real,
  add column if not exists volume_abd            real,
  add column if not exists volume_esd            real,
  add column if not exists biovolume_sphere      real,
  add column if not exists biovolume_cylinder    real,
  add column if not exists biovolume_p_spheroid  real,
  add column if not exists aspect_ratio          real,
  add column if not exists circularity           real,
  add column if not exists circularity_hu        real,
  add column if not exists circle_fit            real,
  add column if not exists compactness           real,
  add column if not exists convexity             real,
  add column if not exists elongation            real,
  add column if not exists roughness             real,
  add column if not exists symmetry              real,
  add column if not exists fiber_curl            real,
  add column if not exists fiber_straightness    real,
  add column if not exists geodesic_aspect_ratio real,
  add column if not exists feret_angle_max       real,
  add column if not exists feret_angle_min       real,
  add column if not exists particles_per_chain   real,
  add column if not exists average_red           real,
  add column if not exists average_green         real,
  add column if not exists average_blue          real,
  add column if not exists ratio_red_green       real,
  add column if not exists ratio_red_blue        real,
  add column if not exists ratio_blue_green      real,
  add column if not exists intensity             real,
  add column if not exists sigma_intensity       real,
  add column if not exists sum_intensity         real,
  add column if not exists transparency          real,
  add column if not exists edge_gradient         real,
  add column if not exists ch1_area              real,
  add column if not exists ch1_peak              real,
  add column if not exists ch1_width             real,
  add column if not exists ch2_area              real,
  add column if not exists ch2_peak              real,
  add column if not exists ch2_width             real,
  add column if not exists ch2_ch1_ratio         real,
  add column if not exists capture_x             real,
  add column if not exists capture_y             real,
  add column if not exists elapsed_time          real,
  add column if not exists raw_area              real,
  add column if not exists raw_filled_area       real,
  add column if not exists raw_convex_hull_area  real,
  add column if not exists raw_perimeter         real,
  add column if not exists raw_convex_perimeter  real,
  add column if not exists raw_feret_max         real,
  add column if not exists raw_feret_min         real,
  add column if not exists raw_feret_mean        real,
  add column if not exists raw_legendre_major    real,
  add column if not exists raw_legendre_minor    real;


-- -----------------------------------------------------------------------------
-- measurement_columns: what the dashboard can filter on
-- -----------------------------------------------------------------------------
-- source_name is the column in catalog_output/image_measurements.csv.gz.
-- width/height are the existing pixel dimensions (loaded by
-- import_to_supabase.py); import_measurements.py fills every other column and
-- the statistics. measurement_folder_counts() accepts only these columns.

create table if not exists public.measurement_columns (
  column_name  text primary key,
  source_name  text    not null,
  label        text    not null,
  unit         text,
  group_name   text    not null,
  sort_order   integer not null,
  description  text,
  image_count  integer,  -- images with a value
  min_value    real,
  max_value    real,
  p01          real,     -- 1st and 99th percentiles: the dashboard's default
  p99          real      -- slider range, so a few extreme particles don't squash it
);

insert into public.measurement_columns as m
  (column_name, source_name, label, unit, group_name, sort_order, description)
values
  ('diameter_esd',          'diameter_esd',          'Diameter (ESD)',              'µm',  'Size', 10,  'Equivalent spherical diameter, from the particle''s mean Feret diameter.'),
  ('diameter_abd',          'diameter_abd',          'Diameter (ABD)',              'µm',  'Size', 11,  'Area-based diameter: the diameter of a circle with the particle''s area.'),
  ('diameter_fd',           'diameter_fd',           'Diameter (filled)',           'µm',  'Size', 12,  'Area-based diameter with holes in the particle filled in.'),
  ('particle_length',       'length',                'Length',                      'µm',  'Size', 13,  'Longest Feret diameter.'),
  ('particle_width',        'width',                 'Width',                       'µm',  'Size', 14,  'Shortest Feret diameter.'),
  ('area_abd',              'area_abd',              'Area (ABD)',                  'µm²', 'Size', 15,  'Particle area from its pixel count.'),
  ('area_filled',           'area_filled',           'Area (filled)',               'µm²', 'Size', 16,  'Particle area with holes filled in.'),
  ('perimeter',             'perimeter',             'Perimeter',                   'µm',  'Size', 17,  'Length of the particle''s outline.'),
  ('convex_perimeter',      'convex_perimeter',      'Convex perimeter',            'µm',  'Size', 18,  'Perimeter of the convex hull around the particle.'),
  ('geodesic_length',       'geodesic_length',       'Geodesic length',             'µm',  'Size', 19,  'Length along the particle, following its shape (useful for filaments).'),
  ('geodesic_thickness',    'geodesic_thickness',    'Geodesic thickness',          'µm',  'Size', 20,  'Thickness across the particle, following its shape.'),
  ('volume_abd',            'volume_abd',            'Volume (ABD)',                'µm³', 'Size', 21,  'Volume of a sphere with the ABD diameter.'),
  ('volume_esd',            'volume_esd',            'Volume (ESD)',                'µm³', 'Size', 22,  'Volume of a sphere with the ESD diameter.'),
  ('biovolume_sphere',      'biovolume_sphere',      'Biovolume (sphere)',          'µm³', 'Size', 23,  'Biovolume assuming a spherical cell.'),
  ('biovolume_cylinder',    'biovolume_cylinder',    'Biovolume (cylinder)',        'µm³', 'Size', 24,  'Biovolume assuming a cylindrical cell.'),
  ('biovolume_p_spheroid',  'biovolume_p_spheroid',  'Biovolume (prolate spheroid)','µm³', 'Size', 25,  'Biovolume assuming a prolate spheroid.'),
  ('width',                 'image_width',           'Image width',                 'px',  'Size', 26,  'Width of the image crop.'),
  ('height',                'image_height',          'Image height',                'px',  'Size', 27,  'Height of the image crop.'),
  ('aspect_ratio',          'aspect_ratio',          'Aspect ratio',                null,  'Shape', 30, 'Width divided by length: 1 for round particles, near 0 for long thin ones.'),
  ('circularity',           'circularity',           'Circularity',                 null,  'Shape', 31, 'How close the outline is to a circle (1 = circle).'),
  ('circularity_hu',        'circularity_hu',        'Circularity (Hu)',            null,  'Shape', 32, 'Circularity from Hu moments; less sensitive to a rough outline.'),
  ('circle_fit',            'circle_fit',            'Circle fit',                  null,  'Shape', 33, 'How well the outline fits a circle.'),
  ('compactness',           'compactness',           'Compactness',                 null,  'Shape', 34, 'Perimeter squared over area, scaled so a circle is 1.'),
  ('convexity',             'convexity',             'Convexity',                   null,  'Shape', 35, 'How convex the outline is (1 = no indentations).'),
  ('elongation',            'elongation',            'Elongation',                  null,  'Shape', 36, 'Geodesic length over thickness.'),
  ('roughness',             'roughness',             'Roughness',                   null,  'Shape', 37, 'How rough the outline is compared with its convex hull (1 = smooth).'),
  ('symmetry',              'symmetry',              'Symmetry',                    null,  'Shape', 38, 'How symmetric the particle is (1 = symmetric).'),
  ('fiber_curl',            'fiber_curl',            'Fiber curl',                  null,  'Shape', 39, 'How curled a filament is.'),
  ('fiber_straightness',    'fiber_straightness',    'Fiber straightness',          null,  'Shape', 40, 'How straight a filament is.'),
  ('geodesic_aspect_ratio', 'geodesic_aspect_ratio', 'Geodesic aspect ratio',       null,  'Shape', 41, 'Geodesic thickness over geodesic length.'),
  ('feret_angle_max',       'feret_angle_max',       'Feret angle (max)',           '°',   'Shape', 42, 'Angle of the longest Feret diameter.'),
  ('feret_angle_min',       'feret_angle_min',       'Feret angle (min)',           '°',   'Shape', 43, 'Angle of the shortest Feret diameter.'),
  ('particles_per_chain',   'particles_per_chain',   'Particles per chain',         null,  'Shape', 44, 'Number of cells FlowCam counted in a chain.'),
  ('average_red',           'average_red',           'Average red',                 null,  'Colour and intensity', 50, 'Mean red value of the particle''s pixels (0-255).'),
  ('average_green',         'average_green',         'Average green',               null,  'Colour and intensity', 51, 'Mean green value of the particle''s pixels (0-255).'),
  ('average_blue',          'average_blue',          'Average blue',                null,  'Colour and intensity', 52, 'Mean blue value of the particle''s pixels (0-255).'),
  ('ratio_red_green',       'ratio_red_green',       'Red/green ratio',             null,  'Colour and intensity', 53, 'Average red over average green.'),
  ('ratio_red_blue',        'ratio_red_blue',        'Red/blue ratio',              null,  'Colour and intensity', 54, 'Average red over average blue.'),
  ('ratio_blue_green',      'ratio_blue_green',      'Blue/green ratio',            null,  'Colour and intensity', 55, 'Average blue over average green.'),
  ('intensity',             'intensity',             'Intensity',                   null,  'Colour and intensity', 56, 'Mean grey level of the particle (0-255).'),
  ('sigma_intensity',       'sigma_intensity',       'Intensity std. dev.',         null,  'Colour and intensity', 57, 'Spread of grey levels within the particle.'),
  ('sum_intensity',         'sum_intensity',         'Total intensity',             null,  'Colour and intensity', 58, 'Sum of the particle''s grey levels.'),
  ('transparency',          'transparency',          'Transparency',                null,  'Colour and intensity', 59, 'One minus the ratio of ABD to ESD diameter.'),
  ('edge_gradient',         'edge_gradient',         'Edge gradient',               null,  'Colour and intensity', 60, 'Sharpness of the particle''s edge; low values suggest it is out of focus.'),
  ('ch1_area',              'ch1_area',              'Ch1 area',                    null,  'Fluorescence', 70, 'Area under the channel 1 fluorescence signal.'),
  ('ch1_peak',              'ch1_peak',              'Ch1 peak',                    null,  'Fluorescence', 71, 'Peak of the channel 1 fluorescence signal.'),
  ('ch1_width',             'ch1_width',             'Ch1 width',                   null,  'Fluorescence', 72, 'Width of the channel 1 fluorescence signal.'),
  ('ch2_area',              'ch2_area',              'Ch2 area',                    null,  'Fluorescence', 73, 'Area under the channel 2 fluorescence signal.'),
  ('ch2_peak',              'ch2_peak',              'Ch2 peak',                    null,  'Fluorescence', 74, 'Peak of the channel 2 fluorescence signal.'),
  ('ch2_width',             'ch2_width',             'Ch2 width',                   null,  'Fluorescence', 75, 'Width of the channel 2 fluorescence signal.'),
  ('ch2_ch1_ratio',         'ch2_ch1_ratio',         'Ch2/Ch1 ratio',               null,  'Fluorescence', 76, 'Channel 2 over channel 1 fluorescence.'),
  ('capture_x',             'capture_x',             'Capture X',                   'px',  'Capture', 80, 'Horizontal position of the particle in the camera frame.'),
  ('capture_y',             'capture_y',             'Capture Y',                   'px',  'Capture', 81, 'Vertical position of the particle in the camera frame.'),
  ('elapsed_time',          'elapsed_time',          'Elapsed time',                's',   'Capture', 82, 'Time since the start of the run when the particle was imaged.'),
  ('raw_area',              'raw_area',              'Area (pixels)',               'px²', 'Pixel measurements', 90, 'Particle area in pixels.'),
  ('raw_filled_area',       'raw_filled_area',       'Filled area (pixels)',        'px²', 'Pixel measurements', 91, 'Particle area in pixels with holes filled in.'),
  ('raw_convex_hull_area',  'raw_convex_hull_area',  'Convex hull area (pixels)',   'px²', 'Pixel measurements', 92, 'Area of the convex hull in pixels.'),
  ('raw_perimeter',         'raw_perimeter',         'Perimeter (pixels)',          'px',  'Pixel measurements', 93, 'Outline length in pixels.'),
  ('raw_convex_perimeter',  'raw_convex_perimeter',  'Convex perimeter (pixels)',   'px',  'Pixel measurements', 94, 'Convex hull perimeter in pixels.'),
  ('raw_feret_max',         'raw_feret_max',         'Feret max (pixels)',          'px',  'Pixel measurements', 95, 'Longest Feret diameter in pixels.'),
  ('raw_feret_min',         'raw_feret_min',         'Feret min (pixels)',          'px',  'Pixel measurements', 96, 'Shortest Feret diameter in pixels.'),
  ('raw_feret_mean',        'raw_feret_mean',        'Feret mean (pixels)',         'px',  'Pixel measurements', 97, 'Mean Feret diameter in pixels.'),
  ('raw_legendre_major',    'raw_legendre_major',    'Legendre major axis (pixels)','px',  'Pixel measurements', 98, 'Major axis of the best-fitting ellipse, in pixels.'),
  ('raw_legendre_minor',    'raw_legendre_minor',    'Legendre minor axis (pixels)','px',  'Pixel measurements', 99, 'Minor axis of the best-fitting ellipse, in pixels.')
on conflict (column_name) do update set
  source_name = excluded.source_name,
  label       = excluded.label,
  unit        = excluded.unit,
  group_name  = excluded.group_name,
  sort_order  = excluded.sort_order,
  description = excluded.description;


-- -----------------------------------------------------------------------------
-- measurement_folder_counts(filters)
-- -----------------------------------------------------------------------------
-- filters is a JSON object of {column: [min, max]}; either bound may be null.
-- Returns each folder that has at least one image inside every range, with
-- how many it has. Columns must be listed in measurement_columns, so nothing
-- from the caller is ever spliced into the SQL except a validated column name
-- (quoted with %I) and a number. Bounds are compared as "real", the columns'
-- own type, so a value shown as 20.7 is inside [.., 20.7].
--
-- This reads the whole images table (there's no room for 64 indexes in the
-- free tier), so it's too slow for a visitor's 3 s request limit.

create or replace function public.measurement_folder_counts(filters jsonb)
returns table (folder_name text, matched bigint)
language plpgsql
stable
set search_path = public
as $$
declare
  conds  text[] := array[]::text[];
  col    text;
  bounds jsonb;
  bound  jsonb;
  op     text;
  i      int;
begin
  if filters is null or jsonb_typeof(filters) <> 'object' then
    raise exception 'filters must be a JSON object of {column: [min, max]}' using errcode = '22023';
  end if;

  for col, bounds in select key, value from jsonb_each(filters) loop
    if not exists (select 1 from public.measurement_columns m where m.column_name = col) then
      raise exception 'Unknown measurement "%"', col using errcode = '22023';
    end if;
    if jsonb_typeof(bounds) <> 'array' or jsonb_array_length(bounds) <> 2 then
      raise exception 'Bounds for "%" must be [min, max]', col using errcode = '22023';
    end if;
    for i in 0..1 loop
      bound := bounds -> i;
      op := case i when 0 then '>=' else '<=' end;
      if jsonb_typeof(bound) = 'number' then
        conds := conds || format('%I %s (%s)::real', col, op, (bound #>> '{}')::numeric);
      elsif jsonb_typeof(bound) <> 'null' then
        raise exception 'Bounds for "%" must be numbers or null', col using errcode = '22023';
      end if;
    end loop;
  end loop;

  if cardinality(conds) = 0 then
    conds := array['true'];
  end if;

  return query execute
    'select i.folder_name, count(*) from public.images i where '
    || array_to_string(conds, ' and ')
    || ' group by i.folder_name';
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------
-- Read-only for everyone, like folders and images. The new images columns
-- need no grant of their own: 001 grants SELECT on the whole table, and 002's
-- UPDATE grant covers only images.label.

alter table public.measurement_columns enable row level security;

drop policy if exists "Anyone can read measurement columns" on public.measurement_columns;
create policy "Anyone can read measurement columns"
  on public.measurement_columns for select to anon, authenticated using (true);

revoke all on table public.measurement_columns from anon, authenticated;
grant select on table public.measurement_columns to anon, authenticated;

revoke all on function public.measurement_folder_counts(jsonb) from public, anon, authenticated;
grant execute on function public.measurement_folder_counts(jsonb) to anon, authenticated;
