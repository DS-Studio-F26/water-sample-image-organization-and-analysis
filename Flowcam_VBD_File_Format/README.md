# Flowcam File Format

The VBD files are comprised of CSVs, with each individual row stored as a length-prefixed string. This folder contains information that I've determined from their format, as well as code to convert the data into a more usable state.

## Format

Each VBD file starts with the ASCII string "VispBinaryFile", which is the beginning of a 488-byte header. I'm not sure of the meaning of the header, but it appears to contain several 64-bit unsigned integers. More reverse-engineering is required to determine its format and ways that it will differ in the future, but for all examples that we have available, it appears to be of limited use to us and is always exactly 488 bytes long.

After the header follows the contents of the file. Each string is encoded with 2 64-bit unsigned integers before it; the first is the length of the string, in bytes; and the second appears to be for internal program use. The strings can then be processed into tables.

Each table is comprised of a header and zero or more rows. You can tell when a table ends by either the next header, or the end of the file. Headers are formatted like `**table_name**`, where table_name is a lowercase alphanumeric ASCII string, with the only special character being `_`. Rows are simply CSVs; header rows are included for all tables with more than 0 data rows.

Images are stored as hex-encoded strings. Any valid hex string beginning with `0x` can be decoded into bytes (this is used for UUIDs and for image blobs). Images are stored in the `particle_image` table, and are always PNG-encoded.

A particle's position in its run (counting from 0, in particle ID order) is the number VisualSpreadsheet puts in an exported image's name: `<run>_00007.png` is the run's 8th particle. The city's 2023 export in `ProjectCode/WCMC_raw_images_2023_and_others` matches the particle images in our VBD files byte for byte this way.

Some runs mark particles as deleted (`particle.deleted`); in our files, those are whole runs deleted in VisualSpreadsheet. The exporter leaves them out.

## Using the Decoder

To decode a VBD file into a standard SQLite3 database (which will be created if it does not exist):

`python3 ./load_vbd.py <VBD file> <SQLite3 database file>`

To extract information from the aforementioned SQLite3 database into normal, uncompressed CSVs and PNGs in folders:

`python3 ./extract_information.py <SQLite3 database file> [--runs-dir <folder>] [--write-raw-data]`

This writes one folder per run into `--runs-dir` (default: `out/<database>/runs`), replicating as closely as possible a normal Flowcam export: the run's images, named the way VisualSpreadsheet names them (`<run>_<position>.png`), and an `images_details.csv` with one row per particle: its ParticleID (`particle`), `position` and `capture_id`, then every column of the `particle_property` table (size, shape, colour, fluorescence, ...). Run names that Windows can't use as folder names (a leading or trailing space, a `?`) are cleaned up. With `--write-raw-data` it also writes every table as a CSV to `out/<database>/raw`.

To do both steps for every VBD file in a folder or a `.zip`, without unpacking the zip:

`python3 ./export_all.py <folder or .zip> <runs folder> [--sqlite-dir <folder>] [--jobs N]`

It runs `--jobs` files at a time (default 3; each can need a few GB of memory), keeps the SQLite databases in `out/sqlite`, and skips files it has already finished, so an interrupted run carries on where it stopped. For the website, the runs folder is `ProjectCode/vbd_export`, which `ProjectCode/catalog_images.py` reads (see the main README):

`python3 ./export_all.py ~/Downloads/Worcester_FlowCam.zip ../ProjectCode/vbd_export`

To use as a library:

```python

from load_vbd import vbd_tables

with open(vbd_file, "rb") as binary_file:
  for table_name, table_dataframe in vbd_tables(binary_file):
    print(table_name, table_dataframe)
```

`vbd_tables` returns an iterable which yields tuples of `(str, pandas.DataFrame)`, with the first item being the name of the table and the second being the table itself. It also accepts a file opened from inside a zip (`zipfile.ZipFile(...).open(name)`).
