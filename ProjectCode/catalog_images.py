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

FlowCam measurements: --vbd-export points at the folders written by
Flowcam_VBD_File_Format/export_all.py, one per FlowCam run, each holding the
run's images ("<run>_<position>.png", the same names VisualSpreadsheet gives
them) and an images_details.csv with every particle's measurements. A run
that also has a folder under --root keeps the --root images -- they're the
ones already hosted, and labels hang off their image_ids -- and each image
gets the measurements of the particle at its position, but only if the
export's copy of that image is byte-identical. Runs with no --root folder are
cataloged from the export itself, as long as their site is one the --root
folders already have (the export has a few sites the city export doesn't,
such as duplicate samples and misspelled names, and those are skipped). The
measurements go to their own file,
image_measurements.csv.gz (one row per image_id): there are ~80 of them for
~670K images, too much to add to the committed manifest.

Usage:
    python catalog_images.py [--root PATH] [--vbd-export PATH] [--out-dir PATH] [--source-tag NAME]
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

# Folders that are known scratch/test data, not real samples. Matched by
# pattern rather than exact name: "Patch Pond IMPORT TEST" (no date, already
# excluded) has a byte-identical twin, "Patch Pond_10.30.2023_..._dilution-pp
# IMPORT TEST" (125/125 files match, including the first image's hash), that
# a per-name exact-match list would miss. Confirmed against the professor's
# own reference file (References/WCMC_2023_parse_samples_for_DS_project.xlsx)
# that this second one isn't a real sample either -- it's mapped identically
# to its real counterpart there too, unflagged, so it was an oversight on
# both sides, not something intentionally kept.
EXCLUDED_FOLDER_PATTERN = re.compile(r"IMPORT TEST", re.IGNORECASE)

# Not sample folders at all: unzipping the dataset on Windows leaves a
# "__MACOSX" folder of "._" resource-fork files next to the real data.
SYSTEM_FOLDER_NAMES = {"__MACOSX"}

DATE_RE = re.compile(r"(?:CR)?(\d{1,2}\.\d{1,2}\.\d{2}(?:\d{2})?)")
DILUTION_RE = re.compile(r"no dilution|(\d+(?:\.\d+)?)\s*[Dd]ilution")
# \d* before the trailing boundary catches numbered pp variants (-pp1, -pp2)
# that a plain \b after "pp" would miss -- "AI1-pp2" has no boundary between
# "pp" and "2" (both \w), so the folder was silently read as raw. Confirmed
# against the reference spreadsheet: PatchPond_CR5.21.22_10x_AI1-pp2 is a
# real Patch.P (pp) sample there.
PP_RE = re.compile(r"-?\s*pp\d*\b", re.IGNORECASE)
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


# Trailing descriptors that turned out to be collector/street names, not a
# distinct sampling location -- confirmed against the professor's reference
# mapping (References/WCMC_2023_parse_samples_for_DS_project.xlsx, "folder
# names img count cmds" sheet), which maps every one of these back to the
# same short site code as their plain parent (e.g. "CoesResHaley" -> "Coes.R",
# same as "CoesRes"). Without this, each one gets its own root and never
# merges with its parent site.
ROOT_ALIASES = {
    "coeshaley": "coes",
    "coespat": "coes",
    "patchbreezedr": "patch",
    "patchbreeze": "patch",
    "indianmelissa": "indian",
    "indianjoe": "indian",
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
    root = s if s else site_raw.lower().strip()
    return ROOT_ALIASES.get(root.replace(" ", ""), root)


def _camel_split(site_raw: str) -> str:
    """"CoesPond_WCMC" -> "Coes Pond WCMC" -- shared by compute_site_root and
    core_water_types_in so a glued word like "CoesPond" is recognized as
    containing "Pond" by both (a plain \\bpond\\b on the un-split string
    misses it: there's no word boundary between the lowercase "s" and
    uppercase "P").
    """
    return CAMEL_RE.sub(" ", site_raw.replace("_", " "))


# Documented correction for a folder name whose water-body word is wrong at
# the source (confirmed against the professor's reference mapping in
# References/WCMC_2023_parse_samples_for_DS_project.xlsx: every "CoesPond"
# folder maps to "Coes.R", i.e. Coes Reservoir). Without this, "CoesPond"
# would make the whole "coes" root look ambiguous (spanning pond and
# reservoir) when in fact every real Coes image sample is Coes Reservoir --
# "Pond" here is a misnomer, not a second physical site. Checked against the
# glued original ("CoesPond", no separator) so it can never accidentally
# match a genuinely distinct, properly-spaced "Coes Pond" if one ever shows
# up -- the reference mapping has no such folder today.
SITE_TYPE_CORRECTIONS = {"coespond": "reservoir"}


def core_water_types_in(site_raw: str) -> set:
    compact = site_raw.replace("_", "").lower()
    for prefix, corrected_type in SITE_TYPE_CORRECTIONS.items():
        if compact.startswith(prefix):
            return {corrected_type}
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


# images_details.csv columns that identify the particle rather than measure it.
DETAIL_KEY_COLUMNS = {"particle", "position", "capture_id"}
CAMEL_BOUNDARY_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def measurement_column(name: str) -> str:
    """FlowCam's camelCase property names as snake_case: diameterESD ->
    diameter_esd, ch2_ch1Ratio -> ch2_ch1_ratio, biovolumePSpheroid ->
    biovolume_p_spheroid."""
    return CAMEL_BOUNDARY_RE.sub("_", name).lower()


def read_details(path: Path) -> dict:
    """images_details.csv -> {position: row}; empty if the file isn't there."""
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {int(row["position"]): row for row in csv.DictReader(f)}


def image_position(filename: str):
    """"<run>_00012.png" -> 12, the particle's position in its FlowCam run."""
    number = Path(filename).stem.rsplit("_", 1)[-1]
    return int(number) if number.isdigit() else None


def file_sha1(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def format_measurement(value: str) -> str:
    """Seven significant digits: what a 4-byte float (Postgres "real") keeps."""
    if value in ("", None):
        return ""
    number = float(value)
    return "" if number != number else format(number, ".7g")  # NaN -> empty


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
    parser.add_argument(
        "--vbd-export",
        type=Path,
        default=Path(__file__).parent / "vbd_export",
        help="Folders written by Flowcam_VBD_File_Format/export_all.py (skipped if missing).",
    )
    parser.add_argument(
        "--vbd-source-tag",
        default="FlowCam_VBD",
        help="source_dataset value for images that come from --vbd-export.",
    )
    args = parser.parse_args()

    root: Path = args.root
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    def list_folders(base: Path) -> dict:
        if not base.is_dir():
            return {}
        return {p.name: p for p in base.iterdir() if p.is_dir() and p.name not in SYSTEM_FOLDER_NAMES}

    root_folders = list_folders(root)
    vbd_folders = list_folders(args.vbd_export)
    if vbd_folders:
        print(f"FlowCam export: {len(vbd_folders)} runs in {args.vbd_export}, "
              f"{len(vbd_folders.keys() & root_folders.keys())} of them also under {root}")
    # A run under --root is cataloged from there; the export only adds the rest.
    all_folders = {**vbd_folders, **root_folders}

    # Sort by name, not Path: Windows compares paths case-insensitively, which
    # would reorder the manifest's rows compared with a macOS run.
    sample_folders = sorted(all_folders.values(), key=lambda p: p.name)

    excluded = [f for f in sample_folders if EXCLUDED_FOLDER_PATTERN.search(f.name)]
    for f in excluded:
        print(f"Excluding known test/scratch folder: {f.name}")
    included_folders = [f for f in sample_folders if not EXCLUDED_FOLDER_PATTERN.search(f.name)]

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

    # FlowCam runs are only added at sites the city export already has. Done
    # after the -pp choice, so a skipped -pp run's raw twin stays dropped too.
    city_sites = {folder_parsed[f.name]["site_normalized"] for f in included_folders if f.parent == root}
    new_site_folders = sorted(f.name for f in included_folders
                              if f.parent != root and folder_parsed[f.name]["site_normalized"] not in city_sites)
    for name in new_site_folders:
        print(f"Skipping FlowCam run at a site the city export doesn't have "
              f"({folder_parsed[name]['site_normalized']}): {name}")
    included_folders = [f for f in included_folders if f.name not in new_site_folders]

    manifest_rows = []
    measurement_rows = []
    measurement_fields = None
    measurement_stats = collections.Counter()
    folder_stats = {}

    for folder in included_folders:
        folder_name = folder.name
        parsed = folder_parsed[folder_name]
        from_export = folder.parent != root
        export_folder = vbd_folders.get(folder_name)
        details = read_details(export_folder / "images_details.csv") if export_folder else {}
        export_positions = None  # sha1 -> position of the export's images, built if needed

        image_files = sorted(
            (p for p in folder.iterdir()
             if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and not p.name.startswith("._")),
            key=lambda p: p.name,
        )

        widths, heights = [], []
        unreadable_count = 0

        for img_path in image_files:
            # as_posix() keeps "folder/file" with a forward slash on every OS, so
            # image_id (a hash of this path) is the same on Windows and macOS.
            rel_path = img_path.relative_to(folder.parent).as_posix()
            image_id = image_id_for(rel_path)
            info = read_image_info(img_path)

            if not info["is_readable"]:
                unreadable_count += 1
            else:
                widths.append(info["width"])
                heights.append(info["height"])

            # Measurements for the particle at this image's position, if the
            # export has that particle and its image is this exact file.
            detail = details.get(image_position(img_path.name)) if details else None
            if details and not from_export:
                twin = export_folder / img_path.name
                if detail is None or not twin.exists() or file_sha1(twin) != file_sha1(img_path):
                    # The city's numbering can be offset from the run's (one
                    # folder starts at _04701), so find the particle by its image.
                    if export_positions is None:
                        export_positions = {file_sha1(p): image_position(p.name)
                                            for p in export_folder.iterdir() if p.suffix.lower() == ".png"}
                        measurement_stats["folders matched by image content"] += 1
                    detail = details.get(export_positions.get(file_sha1(img_path)))
            if detail is not None:
                if measurement_fields is None:
                    measurement_fields = [c for c in detail if c not in DETAIL_KEY_COLUMNS]
                measurement_rows.append(
                    [image_id, detail["particle"]]
                    + [format_measurement(detail.get(c, "")) for c in measurement_fields])
                measurement_stats["with measurements"] += 1
            elif export_folder:
                measurement_stats["no matching particle in the FlowCam export"] += 1
            else:
                measurement_stats["folder has no FlowCam export"] += 1

            manifest_rows.append({
                "image_id": image_id,
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
                "source_dataset": args.vbd_source_tag if from_export else args.source_tag,
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

    measurements_path = out_dir / "image_measurements.csv.gz"
    if measurement_rows:
        with gzip.open(measurements_path, "wt", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["image_id", "particle_id"] + [measurement_column(c) for c in measurement_fields])
            writer.writerows(measurement_rows)

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
    print(f"Folders skipped (FlowCam runs at new sites): {len(new_site_folders)}")
    print(f"Folders cataloged: {len(included_folders)}")
    print(f"Images cataloged: {len(manifest_rows)}")
    for reason, count in sorted(measurement_stats.items()):
        print(f"  {reason}: {count}")
    print(f"Wrote: {manifest_path}")
    print(f"Wrote: {manifest_gz_path} (commit this one — under GitHub's 100MB limit)")
    print(f"Wrote: {summary_path}")
    if measurement_rows:
        print(f"Wrote: {measurements_path} ({len(measurement_rows)} images, {len(measurement_fields)} measurements)")


if __name__ == "__main__":
    main()
