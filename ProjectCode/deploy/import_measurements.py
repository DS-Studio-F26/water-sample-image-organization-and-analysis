"""
Fill in the FlowCam measurements on public.images (migration 003).

    catalog_output/image_measurements.csv.gz -> public.images measurement columns
                                             -> public.measurement_columns statistics

Run it after import_to_supabase.py (every image_id in the file must already be
in public.images) and after apply_migrations.py has applied
003_measurements.sql. Which CSV column goes into which images column is read
from that migration's measurement_columns rows, so it's defined in one place.

Why batches: writing values into an existing row makes Postgres write a new
copy of the row and leave the old one behind until VACUUM. Filling ~670K
rows in one transaction would need room for both copies at once -- well past
the free tier's 500 MB -- so the rows go in batches, each committed and then
vacuumed, which lets the next batch reuse the space. The cost: if a run
stops part-way, some images have their measurements and some don't yet. Run
it again; rows that already match are skipped.

Usage (from ProjectCode/):
    python deploy/import_measurements.py --dry-run   # check the file, estimate size; writes nothing
    python deploy/import_measurements.py             # load
"""

import argparse
import array
import csv
import gzip
import math
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from apply_migrations import MIGRATIONS_DIR, PROJECT_DIR, connect, describe, get_db_url

CATALOG_DIR = PROJECT_DIR / "catalog_output"
MIGRATION = MIGRATIONS_DIR / "003_measurements.sql"
SIZE_LIMIT_MB = 450  # Nick's choice for all 64 filters; Supabase's free tier stops at 500 MB
BATCH_ROWS = 25_000
MB = 1024 * 1024
# Filterable, but loaded by import_to_supabase.py with the rest of the image.
BASE_COLUMNS = {"width", "height"}
# Rough growth of an images row once its measurements are filled: 4 bytes per
# real, plus a wider null bitmap.
BYTES_PER_VALUE = 4
NULL_BITMAP_GROWTH = 8


class DataError(Exception):
    pass


def measurement_columns():
    """[(images column, CSV column)] from 003_measurements.sql's insert."""
    sql = MIGRATION.read_text(encoding="utf-8")
    rows = re.findall(r"^\s+\('(\w+)',\s+'(\w+)'", sql, re.MULTILINE)
    if not rows:
        raise DataError(f"no measurement_columns rows found in {MIGRATION.name}")
    return rows


def read_measurements(path: Path, columns):
    """Checks the file and returns (image_ids in order, {CSV column: array of values})."""
    with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        if header[0] != "image_id":
            raise DataError(f"{path.name}: the first column must be image_id")
        missing = [src for _, src in columns if src not in header]
        if missing:
            raise DataError(f"{path.name} is missing column(s): {', '.join(missing)}")
        index = {src: header.index(src) for _, src in columns}
        values = {src: array.array("f") for _, src in columns}
        ids, seen = [], set()
        for line, row in enumerate(reader, start=2):
            image_id = row[0]
            if image_id in seen:
                raise DataError(f"{path.name} line {line}: duplicate image_id {image_id}")
            seen.add(image_id)
            ids.append(image_id)
            for src, i in index.items():
                text = row[i]
                try:
                    number = float(text) if text != "" else math.nan
                except ValueError:
                    raise DataError(f"{path.name} line {line}, {src}: not a number: {text!r}") from None
                values[src].append(number)
    return ids, values


def batches(path: Path, columns, size: int):
    """The file again, as lists of COPY rows: (image_id, value or None, ...)."""
    with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        index = [header.index(src) for _, src in columns]
        batch = []
        for row in reader:
            batch.append([row[0]] + [float(row[i]) if row[i] != "" else None for i in index])
            if len(batch) == size:
                yield batch
                batch = []
        if batch:
            yield batch


def percentile(sorted_values, p: float):
    return sorted_values[round(p * (len(sorted_values) - 1))]


def column_stats(values: array.array):
    present = sorted(v for v in values if not math.isnan(v))
    if not present:
        return (0, None, None, None, None)
    return (len(present), present[0], present[-1], percentile(present, 0.01), percentile(present, 0.99))


def quoted(cols):
    return ", ".join(f'"{c}"' for c in cols)


def load(conn, path: Path, columns, total: int) -> int:
    cols = [c for c, _ in columns]
    stage_cols = ", ".join(f'"{c}" real' for c in cols)
    target = quoted(cols)
    source = ", ".join(f's."{c}"' for c in cols)
    current = ", ".join(f'i."{c}"' for c in cols)
    changed = sent = 0
    started = time.time()
    for batch in batches(path, columns, BATCH_ROWS):
        with conn.transaction():
            conn.execute("set local statement_timeout = '10min'")
            conn.execute(f"create temp table stage_measurements (image_id text primary key, {stage_cols}) "
                         "on commit drop")
            with conn.cursor().copy(f"copy stage_measurements (image_id, {target}) from stdin") as copy:
                for row in batch:
                    copy.write_row(row)
            changed += conn.execute(
                f"update public.images i set ({target}) = ({source}) from stage_measurements s "
                f"where i.image_id = s.image_id and ({current}) is distinct from ({source})").rowcount
        conn.execute("vacuum public.images")  # lets the next batch reuse the old rows' space
        sent += len(batch)
        print(f"    {sent:,} of {total:,} rows checked, {changed:,} updated "
              f"({time.time() - started:.0f}s)", flush=True)
    return changed


def clear_missing(conn, ids, columns) -> int:
    """Measurements on images that are no longer in the file go back to null."""
    cols = [c for c, _ in columns]
    with conn.transaction():
        conn.execute("create temp table measured_ids (image_id text primary key) on commit drop")
        with conn.cursor().copy("copy measured_ids (image_id) from stdin") as copy:
            for image_id in ids:
                copy.write_row((image_id,))
        return conn.execute(
            f"update public.images i set ({quoted(cols)}) = ({', '.join('null' for _ in cols)}) "
            f"where num_nonnulls({', '.join(f'i.{c}' for c in cols)}) > 0 "
            "and not exists (select 1 from measured_ids m where m.image_id = i.image_id)").rowcount


def save_stats(conn, stats: dict) -> None:
    with conn.transaction():
        for column, (count, lo, hi, p01, p99) in stats.items():
            conn.execute("update public.measurement_columns set image_count = %s, min_value = %s, "
                         "max_value = %s, p01 = %s, p99 = %s where column_name = %s",
                         (count, lo, hi, p01, p99, column))
        for column in sorted(BASE_COLUMNS):
            conn.execute(f"""
                update public.measurement_columns m set
                  image_count = s.n, min_value = s.lo, max_value = s.hi, p01 = s.p01, p99 = s.p99
                from (select count("{column}") as n, min("{column}") as lo, max("{column}") as hi,
                             percentile_disc(0.01) within group (order by "{column}") as p01,
                             percentile_disc(0.99) within group (order by "{column}") as p99
                      from public.images) s
                where m.column_name = '{column}'""")



def main():
    parser = argparse.ArgumentParser(description="Load FlowCam measurements into Supabase.")
    parser.add_argument("--dry-run", action="store_true", help="check the file and estimate the size; write nothing")
    parser.add_argument("--measurements", type=Path, default=CATALOG_DIR / "image_measurements.csv.gz")
    args = parser.parse_args()

    started = time.time()
    print("Reading and checking the measurements ...")
    try:
        all_columns = measurement_columns()
        columns = [(c, src) for c, src in all_columns if c not in BASE_COLUMNS]
        ids, values = read_measurements(args.measurements, columns)
    except (DataError, OSError) as exc:
        sys.exit(f"ERROR: {exc}\nNothing was written.")
    print(f"  {args.measurements.name}: {len(ids):,} images, {len(columns)} measurement columns "
          f"(+ {len(BASE_COLUMNS)} filterable image columns already in public.images)")
    stats = {c: column_stats(values[src]) for c, src in columns}
    empty = [c for c, s in stats.items() if s[0] == 0]
    if empty:
        print(f"  NOTE: no values at all for: {', '.join(empty)}")
    added = len(ids) * (len(columns) * BYTES_PER_VALUE + NULL_BITMAP_GROWTH)

    load_dotenv(PROJECT_DIR / ".env")
    if not os.environ.get("SUPABASE_DB_URL", "").strip():
        if args.dry_run:
            print(f"Estimated growth of the images table: ~{added / MB:,.0f} MB "
                  "(no SUPABASE_DB_URL, so the current size is unknown).")
            print(f"Dry run finished in {time.time() - started:.0f}s. Nothing was written.")
            return
        get_db_url()  # exits with the usual message

    url = get_db_url()
    print(f"Connecting to {describe(url)} ...")
    with connect(url) as conn:
        have = {r[0] for r in conn.execute(
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = 'images'")}
        missing = [c for c, _ in columns if c not in have]
        migrated = not missing and conn.execute("select to_regclass('public.measurement_columns')").fetchone()[0]
        if not migrated:
            if not args.dry_run:
                sys.exit("ERROR: migration 003_measurements.sql isn't applied yet "
                         "(run python deploy/apply_migrations.py). Nothing was written.")
            print("  NOTE: migration 003_measurements.sql isn't applied yet; apply it before the real run.")

        print("  Checking that every image is in public.images ...")
        known = {r[0] for r in conn.execute("select image_id from public.images")}
        unknown = [i for i in ids if i not in known]
        if unknown:
            message = (f"{len(unknown):,} image_id(s) in {args.measurements.name} aren't in public.images "
                       f"(e.g. {unknown[0]}). Run python deploy/import_to_supabase.py first.")
            if not args.dry_run:
                sys.exit(f"ERROR: {message} Nothing was written.")
            print(f"  NOTE: {message}")
        already = conn.execute("select count(*) from public.images where diameter_esd is not null"
                               ).fetchone()[0] if migrated else 0
        size = conn.execute("select pg_database_size(current_database())").fetchone()[0]
        to_fill = max(0, len(ids) - already)
        estimate = size + to_fill * (len(columns) * BYTES_PER_VALUE + NULL_BITMAP_GROWTH)
        print(f"  now: {size / MB:,.1f} MB; {already:,} images already have measurements")
        print(f"  estimated size after loading: ~{estimate / MB:,.0f} MB "
              f"(limit for this project: {SIZE_LIMIT_MB} MB; Supabase free tier: 500 MB)")
        if estimate > SIZE_LIMIT_MB * MB:
            sys.exit(f"ERROR: over the {SIZE_LIMIT_MB} MB limit. Nothing was written.")
        if args.dry_run:
            print(f"Dry run finished in {time.time() - started:.0f}s. Nothing was written.")
            return

        print(f"Loading in batches of {BATCH_ROWS:,} ...")
        changed = load(conn, args.measurements, columns, len(ids))
        cleared = clear_missing(conn, ids, columns)
        if cleared:
            conn.execute("vacuum public.images")
        print("  Updating measurement_columns statistics ...")
        save_stats(conn, stats)
        conn.execute("analyze public.images, public.measurement_columns")

        filled = conn.execute("select count(*) from public.images where diameter_esd is not null").fetchone()[0]
        size_after = conn.execute("select pg_database_size(current_database())").fetchone()[0]
        print(f"Done: {changed:,} images updated, {cleared:,} cleared; {filled:,} images have measurements "
              f"(file: {len(ids):,}). Database: {size_after / MB:,.1f} MB (was {size / MB:,.1f} MB).")
        if filled != len(ids):
            print("WARNING: the count doesn't match the file; run this script again.")
    print("Next: upload_images.ps1 rebuilds and uploads the dashboard's filter files to match.")
    print(f"Finished in {time.time() - started:.0f}s.")


if __name__ == "__main__":
    main()
