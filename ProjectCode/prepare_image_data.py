"""
Pre-process the image manifest into per-folder JSON files for the dashboard.

Writes one small JSON file per selected folder into catalog_output/folder_images/,
plus an index mapping folder_name -> file key. The dashboard fetches only the
relevant file when a folder row is clicked.

image_manifest.csv.gz no longer carries folder_name or relative_path (dropped
deliberately -- see catalog_images.py), so this script re-derives them by
walking the same dataset root and reusing catalog_images.py's own folder
parsing and -pp-preference selection, rather than re-implementing that logic
here where it could drift out of sync. Per-image metadata (label, dimensions,
etc.) is then looked up from the manifest by image_id, which is stable across
both scripts because it's a hash of the same relative path.

Usage:
    python prepare_image_data.py [--root PATH] [--out-dir PATH]
"""

import argparse
import csv
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from catalog_images import (
    EXCLUDED_FOLDER_PATTERN,
    IMAGE_EXTENSIONS,
    image_id_for,
    parse_folder_name,
    select_folders_preferring_pp,
)

MANIFEST_FIELDS = [
    "width", "height", "file_size_bytes", "format", "mode", "is_readable", "label",
]


def folder_key(folder_name: str) -> str:
    """Create a filesystem/URL-safe filename from a folder name."""
    import hashlib
    return hashlib.sha1(folder_name.encode("utf-8")).hexdigest()[:16]


def load_manifest_by_id(gz_path: Path) -> dict:
    by_id = {}
    with gzip.open(gz_path, "rt", newline="") as f:
        for row in csv.DictReader(f):
            by_id[row["image_id"]] = row
    return by_id


def main():
    parser = argparse.ArgumentParser(description="Pre-process the manifest into per-folder JSON for the dashboard.")
    parser.add_argument(
        "--root", type=Path,
        default=Path(__file__).parent / "WCMC_raw_images_2023_and_others",
        help="Dataset root containing one folder per sample event.",
    )
    parser.add_argument(
        "--out-dir", type=Path,
        default=Path(__file__).parent / "catalog_output",
        help="Directory containing image_manifest.csv.gz and to write folder_images/ into.",
    )
    args = parser.parse_args()

    root: Path = args.root
    gz_path = args.out_dir / "image_manifest.csv.gz"
    out_dir = args.out_dir / "folder_images"
    index_path = out_dir / "_index.json"

    if not gz_path.exists():
        print(f"ERROR: {gz_path} not found. Run catalog_images.py first.")
        return
    if not root.exists():
        print(f"ERROR: {root} not found.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Reading {gz_path}...")
    manifest_by_id = load_manifest_by_id(gz_path)
    print(f"Loaded metadata for {len(manifest_by_id)} images.")

    # Re-derive which folders are in the catalog the same way catalog_images.py
    # does, so this script can never disagree with it about which folders (raw
    # vs -pp) are actually part of the dataset.
    sample_folders = [p for p in root.iterdir() if p.is_dir() and not EXCLUDED_FOLDER_PATTERN.search(p.name)]
    folder_parsed = {p.name: parse_folder_name(p.name) for p in sample_folders}
    selected_names, _dropped_names = select_folders_preferring_pp(folder_parsed)

    folders = {}
    missing_from_manifest = 0

    for folder in sample_folders:
        if folder.name not in selected_names:
            continue

        images = []
        for img_path in sorted(folder.iterdir()):
            if not (img_path.is_file() and img_path.suffix.lower() in IMAGE_EXTENSIONS
                    and not img_path.name.startswith("._")):
                continue

            rel_path = str(img_path.relative_to(root))
            image_id = image_id_for(rel_path)
            meta = manifest_by_id.get(image_id)

            image = {
                "image_id": image_id,
                "filename": img_path.name,
                "relative_path": rel_path,
            }
            if meta is None:
                missing_from_manifest += 1
                for field in MANIFEST_FIELDS:
                    image[field] = None
            else:
                image["width"] = int(meta["width"]) if meta["width"] else None
                image["height"] = int(meta["height"]) if meta["height"] else None
                image["file_size_bytes"] = int(meta["file_size_bytes"]) if meta["file_size_bytes"] else None
                image["format"] = meta["format"]
                image["mode"] = meta["mode"]
                image["is_readable"] = meta["is_readable"] == "True"
                image["label"] = meta["label"]

            images.append(image)

        folders[folder.name] = images

    if missing_from_manifest:
        print(f"WARNING: {missing_from_manifest} images found on disk had no matching manifest row "
              f"(manifest may be stale -- rerun catalog_images.py).")

    # Write per-folder JSON files and build an index
    index = {}
    for folder_name, images in folders.items():
        key = folder_key(folder_name)
        file_path = out_dir / f"{key}.json"
        with file_path.open("w") as f:
            json.dump(images, f)
        index[folder_name] = {"key": key, "image_count": len(images)}

    with index_path.open("w") as f:
        json.dump(index, f)

    print(f"Wrote {len(index)} folder files to {out_dir}")
    print(f"Wrote index to {index_path}")


if __name__ == "__main__":
    main()
