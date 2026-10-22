import os
import re
import sqlite3
import pandas as pd

def mkdir_if_not_exist(dir):
    if not os.path.exists(dir):
        os.makedirs(dir)

def folder_name_for(run_name):
    """The run's name as a folder name: some runs were named with a leading or
    trailing space, or a "?", which Windows can't keep in a folder name. Like
    VisualSpreadsheet's own export, a character a folder name can't have
    becomes "_" ("Burncoat?_6.3.24..." -> "Burncoat__6.3.24...")."""
    return re.sub(r'[<>:"/\\|?*]', "_", run_name).strip(" .")

# Each particle's position among all particles of its run, counting from 0.
# VisualSpreadsheet names its exported images "<run>_<position>.png" (e.g.
# "Bell Pond_5.27.23_10x_AI1 no dilution-pp_00007.png"), and the city's 2023
# export in ProjectCode/WCMC_raw_images_2023_and_others matches these files
# byte for byte. Using the same names lets the catalog treat both exports alike.
PARTICLES = """
    SELECT run.ID AS run_id, run.name AS run_name, particle.ID AS particle_id,
           particle.capture_id, particle.deleted,
           ROW_NUMBER() OVER (PARTITION BY run.ID ORDER BY particle.ID) - 1 AS position
    FROM run JOIN image_frame ON image_frame.run == run.ID
    JOIN particle ON particle.imageFrame == image_frame.ID
"""

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Write a VBD database's images and particle properties out as files.")
    parser.add_argument("db_file", help="SQLite database written by load_vbd.py")
    parser.add_argument("--runs-dir", help="folder to write one folder per run into (default: ./out/<db_file>/runs)")
    parser.add_argument("--write-raw-data", action="store_true", help="also write every table as a CSV to ./out/<db_file>/raw")
    args = parser.parse_args()

    db_file = args.db_file
    out_name = os.path.basename(db_file)
    runs_dir = args.runs_dir or f"./out/{out_name}/runs"

    db = sqlite3.connect(db_file)
    cur = db.cursor()

    if args.write_raw_data:
        mkdir_if_not_exist(f"./out/{out_name}/raw")
        res = cur.execute("SELECT name FROM sqlite_master WHERE type == 'table';")
        for tablename, in res.fetchall():
            pd.read_sql_query(f"SELECT * FROM {tablename}", db).to_csv(f"./out/{out_name}/raw/{tablename}.csv")

    # One images_details.csv per run: the particle's ID, position and capture
    # ID, then every particle_property column. Deleted particles are left out.
    details = pd.read_sql_query(f"""
        SELECT p.run_name, p.particle_id AS particle, p.position, p.capture_id, particle_property.*
        FROM ({PARTICLES}) AS p JOIN particle_property ON particle_property.particle == p.particle_id
        WHERE NOT p.deleted
        ORDER BY p.run_id, p.position
    """, db)
    details = details.loc[:, ~details.columns.duplicated()]
    for run_name, run_details in details.groupby("run_name", sort=False):
        out_folder = f"{runs_dir}/{folder_name_for(run_name)}"
        mkdir_if_not_exist(out_folder)
        run_details.drop(columns="run_name").to_csv(f"{out_folder}/images_details.csv", index=False)

    images = cur.execute(f"""
        SELECT p.run_name, p.position, particle_image.image
        FROM ({PARTICLES}) AS p JOIN particle_image ON particle_image.ID == p.particle_id
        WHERE NOT p.deleted
    """)

    count = 0
    for run_name, position, image_data in images:
        folder = folder_name_for(run_name)
        out_folder = f"{runs_dir}/{folder}"
        mkdir_if_not_exist(out_folder)
        with open(f"{out_folder}/{folder}_{position:05d}.png", "wb") as pngfile:
            pngfile.write(image_data)
        count += 1

    print(f"Wrote {count} images and {details['run_name'].nunique()} images_details.csv files to {runs_dir}")
