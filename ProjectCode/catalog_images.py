"""
Catalog script for the water sample image dataset.

Walks a dataset root (default: WCMC_raw_images_2023_and_others), parses metadata
out of each sample-event folder name, reads each image's dimensions/format/mode,
and writes:

  - image_manifest.csv     — one row per image (the seed data for the future
                              labeling database / app; includes an empty `label`
                              column ready for manual labeling or CSV import)
  - image_manifest.csv.gz  — gzip copy of the manifest for committing to git;
                              the raw CSV runs well over GitHub's 100MB file
                              limit, the gzip copy does not (pandas can read it
                              directly via pd.read_csv(path, compression="gzip"))
  - folder_summary.csv  — one row per sample-event folder (counts, dimension
                           range, parsed metadata, pp/raw pairing)
  - qa_log.csv          — folders/files that didn't parse cleanly or failed to
                           open, so problems are visible instead of silently
                           dropped

Usage:
    python catalog_images.py [--root PATH] [--out-dir PATH] [--source-tag NAME]
"""

import argparse
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
MAG_RE = re.compile(r"(\d{1,3})[xX]")
DILUTION_RE = re.compile(r"no dilution|(\d+(?:\.\d+)?)\s*[Dd]ilution")
PP_RE = re.compile(r"-?\s*pp\b", re.IGNORECASE)
# Sample/replicate code: short alpha(+digit) token before dilution/pp, e.g. TR1, TM, AI1
SAMPLE_CODE_RE = re.compile(r"_(TR\d*|TM\d*|AI\d*|TRI\d*)\b", re.IGNORECASE)
WATER_BODY_RE = re.compile(r"\b(Pond|Lake|Reservoir|Park|Shore)\b", re.IGNORECASE)


def parse_folder_name(name: str) -> dict:
    date_match = DATE_RE.search(name)
    mag_match = MAG_RE.search(name)
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
        "magnification": f"{mag_match.group(1)}x" if mag_match else None,
        "sample_code": sample_match.group(1).upper() if sample_match else None,
        "dilution": dilution,
        "is_pp": is_pp,
        "parsed_ok": bool(date_match and mag_match),
    }


def normalize_site(site_raw: str) -> str:
    """Best-effort canonical site name: strip separators/collection tags, lowercase.

    Deliberately does NOT strip water-body-type words (Pond/Lake/Reservoir/Park/Shore)
    — doing so previously merged distinct sites like "Patch Pond" and "Patch Reservoir"
    into one. Under-merging is safer than silently conflating different sites; use the
    water_body_type field plus manual review (see qa_log site_name_ambiguous entries)
    to decide which raw names are actually the same place.
    """
    s = site_raw.replace("_", " ")
    s = re.sub(r"\bWCMC\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\bCR\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s.lower()


def image_id_for(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]


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
        help="Directory to write manifest/summary/qa CSVs into.",
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

    manifest_rows = []
    qa_rows = []
    folder_stats = {}  # folder_name -> dict accumulator

    sample_folders = sorted(p for p in root.iterdir() if p.is_dir())

    for folder in sample_folders:
        folder_name = folder.name

        if folder_name in EXCLUDED_FOLDER_NAMES:
            qa_rows.append({"level": "folder_excluded", "target": folder_name, "detail": "known test/scratch folder"})
            continue

        parsed = parse_folder_name(folder_name)
        if not parsed["parsed_ok"]:
            qa_rows.append({
                "level": "folder_unparsed",
                "target": folder_name,
                "detail": f"date_found={bool(parsed['date'])} mag_found={bool(parsed['magnification'])}",
            })

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
                qa_rows.append({
                    "level": "image_unreadable",
                    "target": rel_path,
                    "detail": info.get("error", ""),
                })
            else:
                widths.append(info["width"])
                heights.append(info["height"])

            manifest_rows.append({
                "image_id": image_id_for(rel_path),
                "relative_path": rel_path,
                "filename": img_path.name,
                "folder_name": folder_name,
                "site_raw": parsed["site_raw"],
                "site_normalized": parsed["site_normalized"],
                "water_body_type": parsed["water_body_type"],
                "date": parsed["date"],
                "magnification": parsed["magnification"],
                "sample_code": parsed["sample_code"],
                "dilution": parsed["dilution"],
                "is_pp": parsed["is_pp"],
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
            "parsed_ok": parsed["parsed_ok"],
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

    # Flag site_normalized groups spanning >1 distinct water-body-type word (e.g. a
    # "Pond" and a "Reservoir" sharing a normalized name) for manual review — do not
    # resolve automatically, since that risks merging genuinely different sites.
    site_groups = {}
    for stats in folder_stats.values():
        site_groups.setdefault(stats["site_normalized"], set()).add(stats["site_raw"])
    for site_normalized, raws in site_groups.items():
        body_types = {r for r in raws if WATER_BODY_RE.search(r)}
        distinct_types = {WATER_BODY_RE.search(r).group(1).lower() for r in body_types}
        if len(distinct_types) > 1:
            qa_rows.append({
                "level": "site_name_ambiguous",
                "target": site_normalized,
                "detail": f"raw names span water body types {sorted(distinct_types)}: {sorted(raws)}",
            })

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
        "sample_code", "dilution", "is_pp", "pp_of_folder", "parsed_ok",
        "image_count", "unreadable_count", "min_width", "max_width", "min_height", "max_height",
    ]
    with summary_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=summary_fields)
        writer.writeheader()
        writer.writerows(folder_stats.values())

    qa_path = out_dir / "qa_log.csv"
    with qa_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["level", "target", "detail"])
        writer.writeheader()
        writer.writerows(qa_rows)

    print(f"Folders scanned: {len(sample_folders)}")
    print(f"Images cataloged: {len(manifest_rows)}")
    print(f"QA issues logged: {len(qa_rows)}")
    print(f"Wrote: {manifest_path}")
    print(f"Wrote: {manifest_gz_path} (commit this one — under GitHub's 100MB limit)")
    print(f"Wrote: {summary_path}")
    print(f"Wrote: {qa_path}")


if __name__ == "__main__":
    main()
