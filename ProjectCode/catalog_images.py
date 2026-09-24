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
  - folder_summary.csv     — one row per sample-event folder actually included
                              (counts, dimension range, pp/raw pairing)

Magnification is assumed to be 10x for every folder (confirmed with the
professor — folders that don't record it in their name were just named less
completely, not shot at a different magnification), so every folder parses
cleanly and there's no QA log of unparsed folders.

Folder selection: for folders that are part of a raw/-pp pair (same site,
date, and sample code), only the -pp version is cataloged -- confirmed with
Prof. Ahlgren that -pp is the city's standard post-processed output, so the
raw counterpart is dropped entirely rather than flagged. Raw folders with no
-pp counterpart are kept as-is. Nothing on disk is touched; rerunning the
script just recomputes which folders are included.

Capture mode: sample_code is also classified into capture_mode -- "autoimage"
for AI* codes, "trigger" for TR*/TM codes (confirmed with Prof. Ahlgren: AI =
autoimage mode, TR1/TM = trigger mode, which uses laser-triggered detection
and is the preferred/standardized mode post-2022).

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

# Splits glued camelCase words in raw folder names (ElmPark -> Elm Park,
# LittleIndian -> Little Indian) so site merging can find them.
CAMEL_RE = re.compile(r"(?<=[a-z])(?=[A-Z])")
# "Pond"/"Lake"/"Reservoir" ("Res" abbreviates Reservoir) are mutually
# exclusive classifications of a body of water -- a single site can't
# genuinely be both. "Park"/"Shore" describe a place, not a water-body type
# (a park can contain a pond), so they're not treated as conflicting.
CORE_WATER_TYPE_RE = re.compile(r"\b(pond|lake|reservoir|res)\b", re.IGNORECASE)
STRIP_WORDS_RE = re.compile(r"\b(pond|lake|reservoir|res|park|shore)\b", re.IGNORECASE)

ASSUMED_MAGNIFICATION = "10x"


def capture_mode_for(sample_code: str) -> str:
    """AI* -> autoimage mode; TR*/TM -> trigger mode (laser-triggered
    detection, preferred and standardized post-2022 per Prof. Ahlgren)."""
    if not sample_code:
        return None
    if sample_code.startswith("AI"):
        return "autoimage"
    if sample_code.startswith("TR") or sample_code.startswith("TM"):
        return "trigger"
    return None


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

    # Camel-split first so a glued word like "ElmPark" or "CoesPond" is still
    # recognized -- \bPark\b has no boundary between the lowercase "m" and
    # uppercase "P" in "ElmPark" otherwise.
    water_body_match = WATER_BODY_RE.search(_camel_split(site_raw))

    return {
        "site_raw": site_raw,
        # site_normalized is filled in later, once every folder's site_raw is
        # known -- merging decisions need the full set of variants, not just
        # this one string. See build_site_normalization_map().
        "site_normalized": None,
        "water_body_type": water_body_match.group(1).lower() if water_body_match else None,
        "date": date_match.group(1) if date_match else None,
        "magnification": ASSUMED_MAGNIFICATION,
        "sample_code": sample_match.group(1).upper() if sample_match else None,
        "capture_mode": capture_mode_for(sample_match.group(1).upper() if sample_match else None),
        "dilution": dilution,
        "is_pp": is_pp,
    }


def compute_site_root(site_raw: str) -> str:
    """Aggressively-merged site key: splits camelCase, strips collection tags,
    water-body words, and digits. Two site_raw values sharing a root are
    assumed to be the same physical site recorded inconsistently, UNLESS
    build_site_normalization_map() finds them genuinely conflicting.
    """
    s = _camel_split(site_raw)
    s = re.sub(r"\bWCMC\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\bCR\b", "", s, flags=re.IGNORECASE)
    s = s.lower()
    s = STRIP_WORDS_RE.sub("", s)
    s = re.sub(r"\b\d+\b", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if s else site_raw.lower().strip()


def _camel_split(site_raw: str) -> str:
    """"CoesPond_WCMC" -> "Coes Pond WCMC" -- shared by compute_site_root and
    core_water_types_in so a glued word like "CoesPond" is recognized as
    containing "Pond" by both (a plain \\bpond\\b on the un-split string
    misses it: there's no word boundary between the lowercase "s" and
    uppercase "P").
    """
    return CAMEL_RE.sub(" ", site_raw.replace("_", " "))


def core_water_types_in(site_raw: str) -> set:
    return {
        "reservoir" if m.group(1).lower() == "res" else m.group(1).lower()
        for m in CORE_WATER_TYPE_RE.finditer(_camel_split(site_raw))
    }


def build_site_normalization_map(all_site_raw: set) -> dict:
    """Map every site_raw to a merged site_normalized, EXCEPT roots whose
    variants span more than one core water-body type (e.g. "Patch Pond" and
    "Patch Reservoir") -- those genuinely might be two different physical
    sites sharing a name, so they're kept separate rather than guessed at.
    """
    roots = collections.defaultdict(set)
    for raw in all_site_raw:
        roots[compute_site_root(raw)].add(raw)

    mapping = {}
    for root, raws in roots.items():
        all_types = set()
        for r in raws:
            all_types |= core_water_types_in(r)

        if len(all_types) <= 1:
            canonical = f"{root} {next(iter(all_types))}".strip() if all_types else root
            for r in raws:
                mapping[r] = canonical
        else:
            print(f"NOTE: '{root}' spans multiple water body types {sorted(all_types)} "
                  f"-- not merged: {sorted(raws)}")
            for r in raws:
                own_types = core_water_types_in(r)
                if len(own_types) == 1:
                    mapping[r] = f"{root} {next(iter(own_types))}".strip()
                else:
                    # No type on this specific raw name -- leave as the bare
                    # root rather than guess which of the conflicting types
                    # it belongs to.
                    mapping[r] = root

    return mapping


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


def select_folders_preferring_pp(folder_parsed: dict) -> tuple:
    """Group folders by (site_raw, date, sample_code). If a group has any
    -pp folder(s), only those are kept -- the raw counterpart is dropped
    entirely (confirmed with Prof. Ahlgren: -pp is the city's standard
    post-processed output). Groups with no -pp folder keep their raw
    folder(s) as-is. Returns (selected_names, dropped_raw_names).
    """
    groups = collections.defaultdict(list)
    for folder_name, parsed in folder_parsed.items():
        key = (parsed["site_raw"], parsed["date"], parsed["sample_code"])
        groups[key].append(folder_name)

    selected = set()
    dropped = set()
    for key, folder_names in groups.items():
        pp_folders = [f for f in folder_names if folder_parsed[f]["is_pp"]]
        if pp_folders:
            selected.update(pp_folders)
            dropped.update(f for f in folder_names if f not in pp_folders)
        else:
            selected.update(folder_names)

    return selected, dropped


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

    # Merge site name variants (Bell/Bell_WCMC/Bell Pond -> "bell pond", etc.)
    # everywhere EXCEPT roots that genuinely span >1 water-body type -- those
    # print a NOTE instead of being silently merged. See build_site_normalization_map().
    site_map = build_site_normalization_map({p["site_raw"] for p in folder_parsed.values()})
    for parsed in folder_parsed.values():
        parsed["site_normalized"] = site_map[parsed["site_raw"]]

    # Backfill water_body_type from the resolved site where a folder's own
    # name has no water-body word at all (e.g. plain "Bell" merges into
    # "bell pond", so it should report "pond" too, not stay unknown) -- but
    # only for the unambiguous pond/lake/reservoir types resolved by merging;
    # "park"/"shore" aren't part of site_normalized so there's nothing to
    # backfill from for those.
    for parsed in folder_parsed.values():
        if parsed["water_body_type"] is None:
            last_word = parsed["site_normalized"].split()[-1] if parsed["site_normalized"] else ""
            if last_word in ("pond", "lake", "reservoir"):
                parsed["water_body_type"] = last_word

    # Prefer -pp: when a raw folder and its -pp sibling both exist (same
    # site + date + sample_code), only the -pp folder is cataloged.
    selected_names, dropped_names = select_folders_preferring_pp(folder_parsed)
    for name in sorted(dropped_names):
        print(f"Dropping raw folder (has a -pp counterpart): {name}")
    print(f"Dropped {len(dropped_names)} raw folders in favor of their -pp counterpart.")
    included_folders = [f for f in included_folders if f.name in selected_names]

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
                "capture_mode": parsed["capture_mode"],
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
            "capture_mode": parsed["capture_mode"],
            "dilution": parsed["dilution"],
            "is_pp": parsed["is_pp"],
            "image_count": len(image_files),
            "unreadable_count": unreadable_count,
            "min_width": min(widths) if widths else None,
            "max_width": max(widths) if widths else None,
            "min_height": min(heights) if heights else None,
            "max_height": max(heights) if heights else None,
        }

    # Note which dropped raw folder each -pp folder replaced, so the
    # relationship stays visible even though the raw folder itself has no
    # row of its own anymore. Checked against the full parsed set (not the
    # filtered folder_stats), since the raw folder was deliberately dropped.
    for folder_name, stats in folder_stats.items():
        if stats["is_pp"]:
            raw_candidate = re.sub(PP_RE, "", folder_name).strip(" _-")
            stats["pp_of_folder"] = raw_candidate if raw_candidate in folder_parsed else ""
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
        "sample_code", "capture_mode", "dilution", "is_pp", "pp_of_folder",
        "image_count", "unreadable_count", "min_width", "max_width", "min_height", "max_height",
    ]
    with summary_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=summary_fields)
        writer.writeheader()
        writer.writerows(folder_stats.values())

    print(f"Folders scanned: {len(sample_folders)}")
    print(f"Folders excluded (test/scratch): {len(excluded)}")
    print(f"Folders dropped (raw, superseded by -pp): {len(dropped_names)}")
    print(f"Folders cataloged: {len(included_folders)}")
    print(f"Images cataloged: {len(manifest_rows)}")
    print(f"Wrote: {manifest_path}")
    print(f"Wrote: {manifest_gz_path} (commit this one — under GitHub's 100MB limit)")
    print(f"Wrote: {summary_path}")


if __name__ == "__main__":
    main()
