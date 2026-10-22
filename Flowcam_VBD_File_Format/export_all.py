"""
Decode every VBD file in a folder or .zip and export each run's images and
particle properties, ready for ProjectCode/catalog_images.py.

For each VBD this runs the two steps from the README -- load_vbd.py into a
SQLite database, then extract_information.py -- reading VBDs straight out of
a .zip so the archive never has to be unpacked. Finished files are skipped,
so an interrupted run picks up where it stopped.

Usage:
    python export_all.py <folder or .zip of VBDs> <runs folder> [--sqlite-dir DIR] [--jobs N]

Example (from this folder):
    python export_all.py ~/Downloads/Worcester_FlowCam.zip ../ProjectCode/vbd_export
"""

import argparse
import os
import sqlite3
import subprocess
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from load_vbd import make_db_tables, vbd_tables

HERE = Path(__file__).resolve().parent


def vbd_sources(source: Path):
    """The VBDs in a folder, or the members of a .zip that are VBDs."""
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as z:
            return sorted(n for n in z.namelist() if n.lower().endswith(".vbd"))
    return sorted(p.name for p in source.glob("*.[vV][bB][dD]"))


class open_vbd:
    """Opens one VBD for reading, from a folder or from inside a .zip."""

    def __init__(self, source: Path, name: str):
        self.source, self.name = source, name

    def __enter__(self):
        if self.source.suffix.lower() == ".zip":
            self.zip = zipfile.ZipFile(self.source)
            self.file = self.zip.open(self.name)
        else:
            self.zip = None
            self.file = open(self.source / self.name, "rb")
        return self.file

    def __exit__(self, *exc):
        self.file.close()
        if self.zip:
            self.zip.close()


def load(name, source, sqlite_dir: Path) -> Path:
    """VBD -> SQLite, like `python load_vbd.py`. Written under a temporary name
    and renamed when complete, so a half-written database is never reused."""
    db_path = sqlite_dir / (Path(name).stem + ".sqlite")
    if db_path.exists():
        return db_path
    partial = db_path.with_suffix(".partial")
    partial.unlink(missing_ok=True)
    db = sqlite3.connect(partial)
    make_db_tables(db)
    with open_vbd(source, name) as vbd:
        for table, frame in vbd_tables(vbd):
            if frame.size:
                frame.to_sql(table, db, index=False, index_label=None, if_exists="append")
    db.commit()
    db.close()
    os.replace(partial, db_path)
    return db_path


def export(name, source, sqlite_dir: Path, runs_dir: Path) -> str:
    done = sqlite_dir / (Path(name).stem + ".exported")
    if done.exists():
        return f"{name}: already exported"
    sqlite_dir.mkdir(parents=True, exist_ok=True)
    runs_dir.mkdir(parents=True, exist_ok=True)
    db_path = load(name, source, sqlite_dir)
    result = subprocess.run(
        [sys.executable, str(HERE / "extract_information.py"), str(db_path), "--runs-dir", str(runs_dir)],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{name}: extract_information.py failed:\n{result.stderr}")
    done.write_text(result.stdout)
    return f"{name}: {result.stdout.strip()}"


def main():
    parser = argparse.ArgumentParser(description="Export every VBD in a folder or .zip.")
    parser.add_argument("source", type=Path, help="folder or .zip holding the .VBD files")
    parser.add_argument("runs_dir", type=Path, help="folder to write one folder per run into")
    parser.add_argument("--sqlite-dir", type=Path, default=HERE / "out" / "sqlite",
                        help="where the intermediate SQLite databases go (default: out/sqlite)")
    parser.add_argument("--jobs", type=int, default=3,
                        help="VBDs to process at once; each can need a few GB of memory (default: 3)")
    args = parser.parse_args()

    names = vbd_sources(args.source)
    print(f"{len(names)} VBD files in {args.source}", flush=True)

    failed = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(export, name, args.source, args.sqlite_dir, args.runs_dir): name
                   for name in names}
        for future in as_completed(futures):
            try:
                print(future.result(), flush=True)
            except Exception as exc:
                failed += 1
                print(f"ERROR: {futures[future]}: {exc}", flush=True)
    if failed:
        sys.exit(f"{failed} VBD file(s) failed; re-run to retry them.")


if __name__ == "__main__":
    main()
