"""
Pre-process the image manifest into per-folder JSON files for the dashboard.

Reads image_manifest.csv.gz (548K rows) and writes one small JSON file per
folder into catalog_output/folder_images/. The dashboard fetches only the
relevant file when a folder row is clicked.

Usage:
    python prepare_image_data.py
"""

import csv
import gzip
import json
import hashlib
from pathlib import Path


def folder_key(folder_name: str) -> str:
    """Create a filesystem/URL-safe filename from a folder name."""
    return hashlib.sha1(folder_name.encode("utf-8")).hexdigest()[:16]


def main():
    base = Path(__file__).parent
    gz_path = base / "catalog_output" / "image_manifest.csv.gz"
    out_dir = base / "catalog_output" / "folder_images"
    index_path = out_dir / "_index.json"

    if not gz_path.exists():
        print(f"ERROR: {gz_path} not found. Run catalog_images.py first.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)

    # Group images by folder_name
    folders: dict[str, list[dict]] = {}

    print(f"Reading {gz_path}...")
    with gzip.open(gz_path, "rt", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            fn = row["folder_name"]
            # Keep only the fields the dashboard needs
            image = {
                "image_id": row["image_id"],
                "filename": row["filename"],
                "relative_path": row["relative_path"],
                "width": int(row["width"]) if row["width"] else None,
                "height": int(row["height"]) if row["height"] else None,
                "file_size_bytes": int(row["file_size_bytes"]) if row["file_size_bytes"] else None,
                "format": row["format"],
                "mode": row["mode"],
                "is_readable": row["is_readable"] == "True",
                "label": row["label"],
            }
            folders.setdefault(fn, []).append(image)

    # Write per-folder JSON files and build an index
    index = {}  # folder_name -> { key, image_count }
    for folder_name, images in folders.items():
        key = folder_key(folder_name)
        file_path = out_dir / f"{key}.json"
        with file_path.open("w") as f:
            json.dump(images, f)
        index[folder_name] = {"key": key, "image_count": len(images)}

    # Write index file (maps folder_name -> key)
    with index_path.open("w") as f:
        json.dump(index, f)

    print(f"Wrote {len(index)} folder files to {out_dir}")
    print(f"Wrote index to {index_path}")


if __name__ == "__main__":
    main()
