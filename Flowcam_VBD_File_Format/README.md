# Flowcam File Format

The VBD files are comprised of CSVs, with each individual row placed as a run-length-encoded string. This folder contains information that I've determined from their format, as well as code to convert the data into a more usable state.

## Format

Each VBD file starts with the ASCII string "VispBinaryFile", which is the beginning of a 488-byte header. I'm not sure of the meaning of the header, but it appears to contain several 64-bit unsigned integers. More reverse-engineering is required to determine its format and ways that it will differ in the future, but for all examples that we have available, it appears to be of limited use to us and is always exactly 488 bytes long.

After the header follows the contents of the file. Each string is encoded with 2 64-bit unsigned integers before it; the first is the length of the string, in bytes; and the second appears to be for internal program use. The strings can then be processed into tables.

Each table is comprised of a header and zero or more rows. You can tell when a table ends by either the next header, or the end of the file. Headers are formatted like `**table_name**`, where table_name is a lowercase alphanumeric ASCII string, with the only special character being `_`. Rows are simply CSVs; header rows are included for all tables with more than 0 data rows.

Images are stored as hex-encoded strings. Any valid hex string beginning with `0x` can be decoded into bytes (this is used for UUIDs and for image blobs). Images are stored in the `particle_image` table, and are always PNG-encoded.

## Using the Decoder

To decode a VBD file into a standard SQLite3 database (which will be created if it does not exist):

`python3 ./load_vbd.py <VBD file> <SQLite3 database file>`

To extract information from the aforementioned SQLite3 database into normal, uncompressed CSVs and PNGs in folders:

`python3 ./extract_information.py <SQLite3 database file>`

This will create a folder named `out` in the current directory, with subfolders for each SQLite3 database file; within that, it will write a folder `raw` with all of the CSVs from the original VBD file. It will also create a folder `runs`, which replicates as closely as possible the structure of a normal Flowcam export (i.e. folders for each run, with images in folders). Images are named with their internal VBD ParticleID to aid in joining the image data with the sensor data from other tables.

To use as a library:

```python

from load_vbd import vbd_tables

with open(vbd_file, "rb") as binary_file:
  for table_name, table_dataframe in vbd_tables(binary_file):
    print(table_name, table_dataframe)
```

`vbd_tables` returns an iterable which yields tuples of `(str, pandas.DataFrame)`, with the first item being the name of the table and the second being the table itself.