"""
Build the files the dashboard counts measurement filters from.

    catalog_output/image_manifest.csv.gz      -> catalog_output/filter_data/
    catalog_output/image_measurements.csv.gz     current.json
                                                 <version>/index.json
                                                 <version>/<column>.f32  (one per filter)

Counting how many images in each folder fall inside a set of ranges means
reading every image's values. Done in the database, that reads the whole
~300 MB images table and takes 8-12 s on the free tier, past Supabase's 3 s
limit for anonymous requests. So the dashboard counts in the browser instead:
for each measurement it downloads one file of every image's value, ~2.3 MB,
from R2 through the image Worker, the first time that measurement is used.

The values are 4-byte floats, the same type as the database's "real"
columns, so the browser's counts match what the folder panel then gets
from the database. Images are in a fixed order: folders as listed in
index.json, and within each folder by image_id. A missing value is NaN.
<version> is a hash of the contents, so browsers can cache the files for
good; current.json names the version to use. upload_images.ps1 builds and
uploads them to r2:<bucket>/_filters/.

Usage (from ProjectCode/):
    python deploy/build_filter_data.py
"""

import argparse
import array
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

from import_measurements import BASE_COLUMNS, DataError, measurement_columns, read_measurements
from import_to_supabase import CATALOG_DIR, load_folders, load_images

OUT_DIR = CATALOG_DIR / "filter_data"


def main():
    parser = argparse.ArgumentParser(description="Build the dashboard's measurement filter files.")
    parser.add_argument("--summary", type=Path, default=CATALOG_DIR / "folder_summary.csv")
    parser.add_argument("--manifest", type=Path, default=CATALOG_DIR / "image_manifest.csv.gz")
    parser.add_argument("--measurements", type=Path, default=CATALOG_DIR / "image_measurements.csv.gz")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    print("Reading the catalog ...")
    try:
        folders_raw, _, _, _ = load_folders(args.summary)
        image_rows, _, _ = load_images(args.manifest, folders_raw)
        columns = measurement_columns()
        measured = [(c, src) for c, src in columns if c not in BASE_COLUMNS]
        ids, values = read_measurements(args.measurements, measured)
    except (DataError, OSError) as exc:
        sys.exit(f"ERROR: {exc}")
    row_of = {image_id: i for i, image_id in enumerate(ids)}

    # Fixed order: folders by name, images in each by image_id.
    by_folder = {}
    for image_id, folder, _filename, width, height, *_ in image_rows:
        by_folder.setdefault(folder, []).append((image_id, width, height))
    folders = sorted(by_folder)
    ordered = []
    for folder in folders:
        ordered.extend(sorted(by_folder[folder]))

    arrays = {}
    for column, source in columns:
        out = array.array("f")
        if column in BASE_COLUMNS:
            slot = 1 if column == "width" else 2
            out.extend(math.nan if img[slot] is None else float(img[slot]) for img in ordered)
        else:
            src = values[source]
            out.extend(src[row_of[img[0]]] if img[0] in row_of else math.nan for img in ordered)
        if sys.byteorder != "little":
            out.byteswap()  # the files are little-endian, like every browser
        arrays[column] = out.tobytes()

    index = {
        "images": len(ordered),
        "folders": [[folder, len(by_folder[folder])] for folder in folders],
        "columns": [column for column, _ in columns],
    }
    digest = hashlib.sha1(json.dumps(index, sort_keys=True).encode("utf-8"))
    for column, _ in columns:
        digest.update(arrays[column])
    version = digest.hexdigest()[:12]
    index["version"] = version

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.iterdir():  # earlier builds
        if old.is_dir():
            shutil.rmtree(old)
    version_dir = out_dir / version
    version_dir.mkdir()
    (version_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    for column, data in arrays.items():
        (version_dir / f"{column}.f32").write_bytes(data)
    (out_dir / "current.json").write_text(json.dumps({"version": version}), encoding="utf-8")

    size = sum(len(d) for d in arrays.values())
    print(f"Wrote {len(arrays)} measurement files for {len(ordered):,} images in {len(folders):,} folders "
          f"({size / 2**20:,.0f} MB, {size / len(arrays) / 2**20:.1f} MB each) to {version_dir}")
    print(f"current.json -> version {version}")


if __name__ == "__main__":
    main()
