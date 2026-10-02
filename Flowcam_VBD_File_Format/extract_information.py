import os
import sqlite3
import pandas as pd

def mkdir_if_not_exist(dir):
    if not os.path.exists(dir):
        os.makedirs(dir)

if __name__ == "__main__":
    import sys

    db_file = sys.argv[1]

    db = sqlite3.connect(db_file)
    cur = db.cursor()

    mkdir_if_not_exist(f"./out/{db_file}/raw")
    res = cur.execute("SELECT name FROM sqlite_master;")
    for tablename, in res.fetchall():
        pd.read_sql_query(f"SELECT * FROM {tablename}", db).to_csv(f"./out/{db_file}/raw/{tablename}.csv")


    images = cur.execute("""SELECT run.ID, run.name, particle.ID, particle_image.image FROM 
        run JOIN image_frame ON image_frame.run == run.ID 
        JOIN particle ON particle.imageFrame == image_frame.ID 
        JOIN particle_image ON particle_image.ID == particle.ID
    """)

    for i, (run_id, run_name, particle_id, image_data) in enumerate(images.fetchall()):
        out_folder = f"./out/{db_file}/runs/{run_name}"
        mkdir_if_not_exist(out_folder + "/images")

        with open(f"{out_folder}/images/{particle_id}.png", "wb") as pngfile:
            try:    
                pngfile.write(image_data)
            except FileNotFoundError as _:
                mkdir_if_not_exist(out_folder + "/images")
                pngfile.write(image_data)
