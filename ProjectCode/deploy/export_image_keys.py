"""
Write the R2 object keys (images.relative_path) from Supabase to a text file,
one per line, for `rclone copy --files-from-raw`.

Taking the keys from the database guarantees that what gets uploaded is
exactly what the dashboard will link to. Used by upload_images.ps1.

Usage (from ProjectCode/):
    python deploy/export_image_keys.py --out keys.txt              # every image
    python deploy/export_image_keys.py --out sample.txt --sample 20  # random sample
    python deploy/export_image_keys.py --out vbd.txt --source FlowCam_VBD  # one source_dataset
"""

import argparse
from pathlib import Path

from apply_migrations import connect, get_db_url


def main():
    parser = argparse.ArgumentParser(description="Export R2 object keys from Supabase.")
    parser.add_argument("--out", type=Path, required=True, help="file to write the keys to")
    parser.add_argument("--sample", type=int, help="only write this many random keys")
    parser.add_argument("--source", help="only images with this source_dataset (each lives in its own folder)")
    args = parser.parse_args()

    where, params = ("where source_dataset = %s", [args.source]) if args.source else ("", [])
    with connect(get_db_url()) as conn:
        if args.sample:
            rows = conn.execute(f"select relative_path from public.images {where} order by random() limit %s",
                                params + [args.sample])
        else:
            rows = conn.execute(f"select relative_path from public.images {where} order by relative_path",
                                params)
        keys = [r[0] for r in rows]

    # UTF-8 without BOM and "\n" line endings: rclone reads the lines verbatim.
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        for key in keys:
            f.write(key + "\n")
    print(f"Wrote {len(keys):,} keys to {args.out}")


if __name__ == "__main__":
    main()
