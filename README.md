# water-sample-image-project
Organize and classify water sample images

Prof. Ahlgren's former student's project repository: https://github.com/KaviFrancis

A jupyter notebook on CNN: https://github.com/ageron/handson-mlp/blob/main/12_deep_computer_vision_with_cnns.ipynb from the collection for this book: https://github.com/ageron/handson-mlp

## Image catalog

`ProjectCode/catalog_images.py` scans the image dataset and outputs a CSV
manifest (one row per image, plus a folder summary) into
`ProjectCode/catalog_output/`. Magnification is assumed to be 10x for every
folder. When a raw folder has a `-pp` counterpart (same site, date, and
sample code), only the `-pp` folder is cataloged -- confirmed with the
professor that `-pp` is the city's standard post-processed output. Nothing on
disk is touched; rerunning the script just recomputes which folders are
included. `sample_code` is also classified into `capture_mode`
(`autoimage` for AI* codes, `trigger` for TR*/TM codes).

```bash
pip3 install Pillow
python3 ProjectCode/catalog_images.py
```

The manifest is gzipped for github (file limit) (`image_manifest.csv.gz`). To unzip it:

```bash
gunzip -k ProjectCode/catalog_output/image_manifest.csv.gz
```
