"""
Catalog script for the water sample image dataset.

Walks a dataset root (default: WCMC_raw_images_2023_and_others), parses metadata
out of each sample-event folder name, reads each image's dimensions/format/mode,
flags raw/pp duplicate images, and writes:

  - image_manifest.csv     — one row per image (the seed data for the future
                              labeling database / app; includes an empty `label`
                              column ready for manual labeling or CSV import)
  - image_manifest.csv.gz  — gzip copy of the manifest for committing to git;
                              the raw CSV runs well over GitHub's 100MB file
                              limit, the gzip copy does not (pandas can read it
                              directly via pd.read_csv(path, compression="gzip"))
  - folder_summary.csv     — one row per sample-event folder (counts, dimension
                              range, pp/raw pairing)

Magnification is assumed to be 10x for every folder (confirmed with the
professor — folders that don't record it in their name were just named less
completely, not shot at a different magnification), so every folder parses
cleanly and there's no QA log of unparsed folders.

Duplicate detection: for folders that are part of a raw/-pp pair (same site,
date, and sample code), images are content-hashed. A raw-side image whose
hash also appears in its -pp sibling is flagged `is_duplicate=True` rather
than removed -- the underlying files are never touched, so the flag can be
recomputed if the pairing logic changes.

Usage:
    python catalog_images.py [--root PATH] [--out-dir PATH] [--source-tag NAME]
"""

import argparse
import collections
import csv
import gzip
import hashlib
import re
import shutil
from pathlib import Path

from PIL import Image, UnidentifiedImageError

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}

# Folders that are known scratch/test data, not real samples.
EXCLUDED_FOLDER_NAMES = {"Patch Pond IMPORT TEST"}

DATE_RE = re.compile(r"(?:CR)?(\d{1,2}\.\d{1,2}\.\d{2}(?:\d{2})?)")
DILUTION_RE = re.compile(r"no dilution|(\d+(?:\.\d+)?)\s*[Dd]ilution")
PP_RE = re.compile(r"-?\s*pp\b", re.IGNORECASE)
# Matches TR1/TM/AI1/TRI etc. preceded by "x" (glued to the magnification,
# e.g. "10xTR1") or by any non-alphanumeric (underscore, space, string start),
# and not embedded in a longer word. A plain trailing \b doesn't work here:
# "_TR1_" has no word boundary after "1" since "_" also counts as \w.
SAMPLE_CODE_RE = re.compile(
    r"(?:(?<=[xX])|(?<![A-Za-z0-9]))(TR\d*|TM\d*|AI\d*|TRI\d*)(?![A-Za-z0-9])"
)
WATER_BODY_RE = re.compile(r"\b(Pond|Lake|Reservoir|Park|Shore)\b", re.IGNORECASE)

ASSUMED_MAGNIFICATION = "10x"


def parse_folder_name(name: str) -> dict:
    date_match = DATE_RE.search(name)
    dilution_match = DILUTION_RE.search(name)
    sample_match = SAMPLE_CODE_RE.search(name)
    is_pp = bool(PP_RE.search(name))

    if dilution_match:
        dilution = "no dilution" if dilution_match.group(0).lower().startswith("no") else dilution_match.group(0)
    else:
        dilution = None

    # Site = everything before the date token (or before the sample code if no date).
    cut_at = date_match.start() if date_match else (sample_match.start() if sample_match else len(name))
    site_raw = name[:cut_at].strip(" _-")

    water_body_match = WATER_BODY_RE.search(site_raw)

    return {
        "site_raw": site_raw,
        "site_normalized": normalize_site(site_raw),
        "water_body_type": water_body_match.group(1).lower() if water_body_match else None,
        "date": date_match.group(1) if date_match else None,
        "magnification": ASSUMED_MAGNIFICATION,
        "sample_code": sample_match.group(1).upper() if sample_match else None,
        "dilution": dilution,
        "is_pp": is_pp,
    }


def normalize_site(site_raw: str) -> str:
    """Best-effort canonical site name: strip separators/collection tags, lowercase.

    Deliberately does NOT strip water-body-type words (Pond/Lake/Reservoir/Park/Shore)
    in general -- doing so previously merged distinct sites like "Patch Pond" and
    "Patch Reservoir" into one. Under-merging is safer than silently conflating
    different sites.

    One confirmed exception: any site starting with "Bell" is the same site
    recorded under a shorter name (confirmed assumption, not a guess), so it's
    forced to "bell pond" here rather than left split into "bell" / "bell pond".
    """
    s = site_raw.replace("_", " ")
    s = re.sub(r"\bWCMC\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\bCR\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.lower()
    if s.startswith("bell"):
        return "bell pond"
    return s


def image_id_for(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def read_image_info(path: Path) -> dict:
    try:
        with Image.open(path) as im:
            width, height = im.size
            return {
                "width": width,
                "height": height,
                "format": im.format,
                "mode": im.mode,
                "is_readable": True,
            }
    except (UnidentifiedImageError, OSError) as exc:
        return {
            "width": None,
            "height": None,
            "format": None,
            "mode": None,
            "is_readable": False,
            "error": str(exc),
        }


def find_duplicate_relpaths(root: Path, folder_parsed: dict) -> set:
    """Return the set of raw-side image relative paths whose content is also
    present in their -pp sibling folder (same site + date + sample_code).
    Only folders that are part of such a pair get hashed -- the rest of the
    dataset is untouched by this step.
    """
    groups = collections.defaultdict(list)
    for folder_name, parsed in folder_parsed.items():
        key = (parsed["site_raw"], parsed["date"], parsed["sample_code"])
        groups[key].append(folder_name)

    duplicate_relpaths = set()

    for key, folder_names in groups.items():
        pp_folders = [f for f in folder_names if folder_parsed[f]["is_pp"]]
        raw_folders = [f for f in folder_names if not folder_parsed[f]["is_pp"]]
        if not pp_folders or not raw_folders:
            continue

        pp_hashes = set()
        for pp_folder in pp_folders:
            for p in (root / pp_folder).iterdir():
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and not p.name.startswith("._"):
                    pp_hashes.add(md5_of(p))

        for raw_folder in raw_folders:
            for p in (root / raw_folder).iterdir():
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and not p.name.startswith("._"):
                    if md5_of(p) in pp_hashes:
                        duplicate_relpaths.add(str(p.relative_to(root)))

    return duplicate_relpaths


def main():
    parser = argparse.ArgumentParser(description="Catalog the water sample image dataset.")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).parent / "WCMC_raw_images_2023_and_others",
        help="Dataset root containing one folder per sample event.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).parent / "catalog_output",
        help="Directory to write manifest/summary CSVs into.",
    )
    parser.add_argument(
        "--source-tag",
        default="WCMC_raw_2023",
        help="Value stamped into the manifest's source_dataset column.",
    )
    args = parser.parse_args()

    root: Path = args.root
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    sample_folders = sorted(p for p in root.iterdir() if p.is_dir())

    excluded = [f for f in sample_folders if f.name in EXCLUDED_FOLDER_NAMES]
    for f in excluded:
        print(f"Excluding known test/scratch folder: {f.name}")
    included_folders = [f for f in sample_folders if f.name not in EXCLUDED_FOLDER_NAMES]

    folder_parsed = {f.name: parse_folder_name(f.name) for f in included_folders}

    # Site names that collapse together but disagree on water-body type (e.g.
    # a "Pond" and a "Reservoir" sharing a name) may be two different real
    # sites -- not auto-resolved, just surfaced here for visibility.
    site_groups = collections.defaultdict(set)
    for parsed in folder_parsed.values():
        site_groups[parsed["site_normalized"]].add(parsed["site_raw"])
    for site_normalized, raws in site_groups.items():
        types = {WATER_BODY_RE.search(r).group(1).lower() for r in raws if WATER_BODY_RE.search(r)}
        if len(types) > 1:
            print(f"NOTE: site '{site_normalized}' spans water body types {sorted(types)}: {sorted(raws)}")

    print("Hashing raw/-pp pairs to flag duplicates...")
    duplicate_relpaths = find_duplicate_relpaths(root, folder_parsed)
    print(f"Flagged {len(duplicate_relpaths)} raw-side images as duplicates of a -pp copy.")

    manifest_rows = []
    folder_stats = {}

    for folder in included_folders:
        folder_name = folder.name
        parsed = folder_parsed[folder_name]

        image_files = sorted(
            p for p in folder.iterdir()
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and not p.name.startswith("._")
        )

        widths, heights = [], []
        unreadable_count = 0

        for img_path in image_files:
            rel_path = str(img_path.relative_to(root))
            info = read_image_info(img_path)

            if not info["is_readable"]:
                unreadable_count += 1
            else:
                widths.append(info["width"])
                heights.append(info["height"])

            manifest_rows.append({
                "image_id": image_id_for(rel_path),
                "filename": img_path.name,
                "site_raw": parsed["site_raw"],
                "site_normalized": parsed["site_normalized"],
                "water_body_type": parsed["water_body_type"],
                "date": parsed["date"],
                "magnification": parsed["magnification"],
                "sample_code": parsed["sample_code"],
                "dilution": parsed["dilution"],
                "is_pp": parsed["is_pp"],
                "is_duplicate": rel_path in duplicate_relpaths,
                "width": info["width"],
                "height": info["height"],
                "file_size_bytes": img_path.stat().st_size,
                "format": info["format"],
                "mode": info["mode"],
                "is_readable": info["is_readable"],
                "label": "",
                "labeled_by": "",
                "labeled_date": "",
                "source_dataset": args.source_tag,
            })

        folder_stats[folder_name] = {
            "folder_name": folder_name,
            "site_raw": parsed["site_raw"],
            "site_normalized": parsed["site_normalized"],
            "water_body_type": parsed["water_body_type"],
            "date": parsed["date"],
            "magnification": parsed["magnification"],
            "sample_code": parsed["sample_code"],
            "dilution": parsed["dilution"],
            "is_pp": parsed["is_pp"],
            "image_count": len(image_files),
            "unreadable_count": unreadable_count,
            "min_width": min(widths) if widths else None,
            "max_width": max(widths) if widths else None,
            "min_height": min(heights) if heights else None,
            "max_height": max(heights) if heights else None,
        }

    # Note raw/pp pairs so folder_summary makes the relationship visible.
    for folder_name, stats in folder_stats.items():
        if stats["is_pp"]:
            raw_candidate = re.sub(PP_RE, "", folder_name).strip(" _-")
            stats["pp_of_folder"] = raw_candidate if raw_candidate in folder_stats else ""
        else:
            stats["pp_of_folder"] = ""

    manifest_path = out_dir / "image_manifest.csv"
    with manifest_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(manifest_rows[0].keys()) if manifest_rows else [])
        writer.writeheader()
        writer.writerows(manifest_rows)

    manifest_gz_path = out_dir / "image_manifest.csv.gz"
    with manifest_path.open("rb") as src, gzip.open(manifest_gz_path, "wb") as dst:
        shutil.copyfileobj(src, dst)

    summary_path = out_dir / "folder_summary.csv"
    summary_fields = [
        "folder_name", "site_raw", "site_normalized", "water_body_type", "date", "magnification",
        "sample_code", "dilution", "is_pp", "pp_of_folder",
        "image_count", "unreadable_count", "min_width", "max_width", "min_height", "max_height",
    ]
    with summary_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=summary_fields)
        writer.writeheader()
        writer.writerows(folder_stats.values())

    duplicate_count = sum(1 for r in manifest_rows if r["is_duplicate"])

    print(f"Folders scanned: {len(sample_folders)}")
    print(f"Folders excluded: {len(excluded)}")
    print(f"Images cataloged: {len(manifest_rows)}")
    print(f"Images flagged as duplicates: {duplicate_count}")
    print(f"Wrote: {manifest_path}")
    print(f"Wrote: {manifest_gz_path} (commit this one — under GitHub's 100MB limit)")
    print(f"Wrote: {summary_path}")


if __name__ == "__main__":
    main()
