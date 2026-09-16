# water-sample-image-project
Organize and classify water sample images

Prof. Ahlgren's former student's project repository: https://github.com/KaviFrancis

A jupyter notebook on CNN: https://github.com/ageron/handson-mlp/blob/main/12_deep_computer_vision_with_cnns.ipynb from the collection for this book: https://github.com/ageron/handson-mlp

## Image catalog

`ProjectCode/catalog_images.py` scans the image dataset and outputs a CSV
manifest (one row per image, plus a folder summary) into
`ProjectCode/catalog_output/`. Magnification is assumed to be 10x for every
folder, and raw-side images that duplicate a `-pp` copy are flagged
(`is_duplicate`) rather than removed.

```bash
pip3 install Pillow
python3 ProjectCode/catalog_images.py
```

The manifest is gzipped for github (file limit) (`image_manifest.csv.gz`). To unzip it:

```bash
gunzip -k ProjectCode/catalog_output/image_manifest.csv.gz
```
