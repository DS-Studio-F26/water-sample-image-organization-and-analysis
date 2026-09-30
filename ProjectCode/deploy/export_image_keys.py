"""
Write the R2 object keys (images.relative_path) from Supabase to a text file,
one per line, for `rclone copy --files-from-raw`.

Taking the keys from the database guarantees that what gets uploaded is
exactly what the dashboard will link to. Used by upload_images.ps1.

Usage (from ProjectCode/):
    python deploy/export_image_keys.py --out keys.txt              # every image
    python deploy/export_image_keys.py --out sample.txt --sample 20  # random sample
"""

import argparse
from pathlib import Path

from apply_migrations import connect, get_db_url


def main():
    parser = argparse.ArgumentParser(description="Export R2 object keys from Supabase.")
    parser.add_argument("--out", type=Path, required=True, help="file to write the keys to")
    parser.add_argument("--sample", type=int, help="only write this many random keys")
    args = parser.parse_args()

    with connect(get_db_url()) as conn:
        if args.sample:
            rows = conn.execute("select relative_path from public.images order by random() limit %s",
                                (args.sample,))
        else:
            rows = conn.execute("select relative_path from public.images order by relative_path")
        keys = [r[0] for r in rows]

    # UTF-8 without BOM and "\n" line endings: rclone reads the lines verbatim.
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        for key in keys:
            f.write(key + "\n")
    print(f"Wrote {len(keys):,} keys to {args.out}")


if __name__ == "__main__":
    main()
