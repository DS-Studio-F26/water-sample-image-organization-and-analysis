# Paper Talk: A FlowCam Image Pipeline and What It Means for Our Water Sample Project

**Paper:** Symiakaki K, Walles TJW, Park C, Yalçın G, Siangsano K, Berger SA, Nejstgaard JC. *Pipeline for FlowCam data processing with modular open-source software and optional machine learning classification.* PeerJ, March 24, 2026. DOI: 10.7717/peerj.20754 (PubMed 41907466)

> Note on sources: I could read the paper's title, metadata, keywords and full abstract (via NCBI's API). I could not read the full text, so this talk makes no claims about specific accuracy numbers, dataset sizes, or model architecture details beyond what the abstract states. If you open the full paper, add 1–2 result figures to slides 9–10.

---

## PART 1. ONE-PAGE SUMMARY (paste on a summary slide)

- **Problem:** Imaging instruments (like the FlowCam) produce huge numbers of plankton images, but processing them is hard. The vendor software (VisualSpreadsheet, VSP) costs money, runs only on Windows, supports old versions poorly, and has limited machine learning classification.
- **What they built:** A free, open-source, cross-platform, modular pipeline with three parts:
  1. **Preprocessing Python script**: unifies output from different VSP versions, detects duplicate images, filters particles by a user-defined size threshold, and computes biovolume with a distance-map algorithm. Output is one CSV.
  2. **LabelChecker**: an open-source app that opens that CSV, displays the images without transforming the instrument's output format, and lets you annotate and validate labels.
  3. **Optional machine learning**: a custom shallow, multi-input classifier whose predictions are written back into the same CSV, so a human can validate them in LabelChecker.
- **Evidence:** Demonstrated on two plankton datasets: annotate, train, classify.
- **Why it matters:** Fast, reproducible, accessible, high-throughput image analysis, and the modular design can adapt to other imaging systems.
- **Why it matters to us:** Our project has the same shape: a large image collection, messy folder-based metadata, a need for labels, and a plan to classify. The paper is a blueprint for the part that comes after our catalog and dashboard.

---

## PART 2. THE TALK (~20 minutes, about 2,600 words; slide content in boxes, speaker notes below each)

Timing guide: Slides 1–3 ≈ 3 min, 4–8 ≈ 7 min, 9–11 ≈ 3 min, 12–16 ≈ 6 min, 17–18 ≈ 1 min.

---

### Slide 1: Title
**On the slide**
- Pipeline for FlowCam data processing with modular open-source software and optional machine learning classification
- Symiakaki et al., PeerJ 2026
- What it teaches our water sample image project

**Speaker notes (≈ 1 min)**
Today I'm presenting a recent paper about a very practical problem: what do you do after an instrument has produced a mountain of microscope images? The paper is about plankton and a machine called the FlowCam, but I picked it because the problem is almost identical to ours. We have a large set of water sample images from the city's sampling, taken at multiple sites and dates, and we need to organize them, label them, and eventually classify them. This paper shows one well-designed way to do that, and I'll spend the second half of the talk mapping it onto our own work.

---

### Slide 2: Why imaging instruments are replacing the traditional microscope
**On the slide**
- Process orders of magnitude more samples and organisms per unit time
- Collect quantitative trait data (size, shape) from every organism
- Reduce human bias; images can be re-analysed later
- Avoid deterioration of preserved samples before analysis
- Some imagers work on live organisms, so delicate species are not lost to fixing

**Speaker notes (≈ 2 min)**
The authors open with five advantages of imaging instruments over a person looking through a microscope. First, throughput: a machine can process vastly more samples and individual organisms. Second, you don't just count organisms, you measure every one of them, so you get quantitative traits like size. Third, it reduces human bias, and the key phrase is "the possibility to reanalyse image data." If you keep the images, a different person or a better algorithm can look again in five years. Fourth, you can image quickly, so you avoid the problem where preserved samples degrade while they wait for a human. And fifth, some imagers handle live organisms, so delicate species that would be destroyed by preservatives can still be counted.

The point for us: our dataset exists for the same reason. Photographing water samples gives a permanent, re-examinable record. But the paper's next sentence is the important one.

---

### Slide 3: The catch, and the problem statement
**On the slide**
- Imagers produce *huge* numbers of images
- Processing them "remains challenging"
- Vendor software (VisualSpreadsheet): licensing cost, Windows only, weak support for old versions, limited ML classification
- Third-party alternatives: data-format and cross-system problems

**Speaker notes (≈ 1 min)**
Collecting images is the easy part. The bottleneck is turning them into usable data. The FlowCam's own software does give you images, particle properties and some statistics, but it's commercial, Windows-only, and doesn't support older versions well. Existing third-party tools for sorting and classifying images run into data-format problems or don't work across systems. So labs end up with image archives they can't easily process. Hold that thought, because it's exactly where we were at the start of this project: folders of images with metadata trapped in folder names.

---

### Slide 4: The solution at a glance
**On the slide**
- Free, multi-platform, **modular** pipeline
- Works with data from various FlowCam instruments and VSP versions
- Three modules, one shared CSV:
  1. Preprocessing script (Python)
  2. LabelChecker (annotation and validation)
  3. Machine learning classification (optional)

**Speaker notes (≈ 1 min)**
Their answer is a pipeline of three modules that all communicate through a single CSV file. That design choice, a plain CSV as the contract between modules, is the most transferable idea in the paper. Because the CSV is the common format, you can swap out any module. Use their preprocessing with your own classifier, or their classifier with your own labeling tool. The authors emphasize "modular" and "accessibility" over and over, and you'll see why that matters.

---

### Slide 5: Module 1, Preprocessing
**On the slide**
- Python script
- Unifies output across different VSP versions
- **Detects duplicate images**
- User-defined **size threshold** for target particles
- Per-particle **biovolume** from a distance-map algorithm
- Everything summarized in **one CSV**

**Speaker notes (≈ 2 min)**
The first module is a Python script that does four jobs. One: normalization. Different versions of the vendor software write data in different layouts, and the script makes them look the same. Two: duplicate detection. Flow-based imagers can capture the same particle more than once, and duplicates would inflate counts and contaminate any training data. Three: size filtering. The researcher decides what size range counts as a target particle, which acts as a first filter before any classification. Four: biovolume. Instead of just counting a particle, they estimate its volume using a distance map algorithm, which works from the particle's outline in the image. Biovolume matters in plankton science because a few large organisms can represent more biomass than many small ones.

All of this lands in a CSV: one row per particle with its metadata and measurements. Notice what this is: a manifest. It's the same idea as our own image manifest.

---

### Slide 6: Module 2, LabelChecker
**On the slide**
- Open-source, cross-platform
- Opens the preprocessing CSV
- Displays images **without transforming the original format**
- Annotate new labels *and* validate existing ones
- Writes labels back to the same CSV

**Speaker notes (≈ 2 min)**
The second module is LabelChecker, a desktop program for looking at the images and assigning or checking labels. Two design details stand out. First, it displays the images as the instrument produced them, with no conversion step, which protects data integrity and avoids duplicating gigabytes of files. Second, it handles both annotation, where a human starts from nothing, and validation, where a human reviews labels that a model proposed. That second mode is what makes the whole approach practical, because it lets you bootstrap: label a modest set by hand, train a model, let the model label the rest, then have a human correct the model rather than start from scratch. Correcting is much faster than labeling.

---

### Slide 7: Module 3, Optional machine learning
**On the slide**
- Pairs with ML approaches for automatic classification
- Demonstration: **custom shallow, multi-input classification model**
- Predictions written into the same CSV
- Opened in LabelChecker for human validation

**Speaker notes (≈ 2 min)**
The third module is optional, and the authors are careful about that word. The pipeline is useful even if you never train a model, because preprocessing and labeling alone give you clean, reproducible data. For classification, they demonstrate a "shallow, multi-input" model. Shallow means not a giant deep network, which fits the reality that research labs have small labeled datasets and modest compute. Multi-input means the model uses more than one kind of information. From the abstract I can't say exactly what the inputs are, but the natural reading is that it combines the image with the measured particle properties from the CSV, such as size. That's a good principle: images are not the only signal, and tabular metadata is often cheap and informative.

Crucially, the predictions go back into the same CSV, which closes the loop with LabelChecker.

---

### Slide 8: Design principles worth stealing
**On the slide**
- One **plain CSV** as the shared interface
- **Modular**: replace any piece
- **Open-source and cross-platform**: no license, no OS lock-in
- **Human in the loop**: annotate, then validate
- **Reproducible**: same pipeline, same results
- ML is **optional**, not required

**Speaker notes (≈ 1 min)**
If you remember nothing else, remember these design principles. A plain file format as the interface. Modules you can replace. No cost or platform barriers. A human reviewing machine output. And reproducibility. These are software design choices more than science choices, and they're exactly the choices a student project like ours can adopt.

---

### Slide 9: How they demonstrated it
**On the slide**
- Two plankton datasets
- Workflow: preprocess → annotate → train → classify → validate
- Goal: show the pipeline is fast, reproducible and high-throughput

**Speaker notes (≈ 1.5 min)**
They validated the pipeline by running the full workflow on two plankton datasets: first annotating images, then using those annotations to train their custom model. I only have access to the abstract, so I won't quote numbers. The claim is about workflow rather than record-breaking accuracy: that a lab can go from raw instrument output to validated classified data with free tools. When you read a paper like this, ask whether the contribution is a better model or a better process. This one is a better process, which is arguably more useful to a team like ours.

*(If you read the full text, add one results figure here.)*

---

### Slide 10: Strengths and limitations
**On the slide**
- Strengths: accessible, open, modular, extensible to other imagers, handles messy version differences
- Limitations (from what the abstract implies): built around FlowCam output; "shallow" model is a demonstration, not a state-of-the-art classifier; two datasets is a modest test; labeling still needs human effort and expertise

**Speaker notes (≈ 1.5 min)**
Strengths first: it solves a real adoption barrier, and it is designed to be extended. Limitations, with the caveat that I'm reading from the abstract: it is tied to FlowCam's output formats, even though the authors say the design could adapt to other imagers. The classifier is a demonstration, so you shouldn't expect it to be the final word on accuracy. Two datasets shows the workflow works but doesn't prove it generalizes everywhere. And no tool removes the need for an expert to decide what the categories are and to check labels. That last point is true for our project too.

---

### Slide 11: Transition. Where is our project on this map?
**On the slide**
- Paper: raw output → preprocess → label → classify → validate
- Us: raw folders → **catalog** → **dashboard** → *(next)* labeling → classification

**Speaker notes (≈ 1 min)**
Now let me connect this to our work. Their pipeline has stages, and we've built the first ones already, independently, and ended up with a very similar architecture. Let me walk through the parallels.

---

### Slide 12: Parallel 1, Our catalog script is their preprocessing script
**On the slide**
| FlowCam pipeline | Our project |
|---|---|
| Unify output from different VSP versions | Parse metadata (site, date, sample code, dilution) out of inconsistently named folders |
| Detect duplicate images | Prefer the `-pp` post-processed folder and drop its raw twin |
| One CSV summarizing everything | `image_manifest.csv` plus `folder_summary.csv` |
| Quality checks | Read each image's dimensions, format and readability |

**Speaker notes (≈ 1.5 min)**
Our `catalog_images.py` does what their Python preprocessing script does. It walks the dataset, parses site, date, sample code and dilution out of folder names, classifies capture mode, and reads each image's size and format. And our rule that prefers the `-pp` folder over its raw counterpart is the same idea as their duplicate detection: the same sample shouldn't be counted twice. The output is a manifest CSV with one row per image. The paper validates that this is the right first step, and that we should keep it deterministic and rerunnable, which it is.

---

### Slide 13: Parallel 2, Our manifest already has a `label` column
**On the slide**
- Paper: a CSV that LabelChecker opens, with labels written back
- Us: manifest includes an empty `label` column, "ready for manual labeling or CSV import"
- Image IDs are stable hashes of relative paths, so labels survive re-runs

**Speaker notes (≈ 1.5 min)**
Here's the most direct lesson. Our manifest was designed with an empty label column, and the paper shows the payoff of that decision: one CSV that carries everything from raw metadata through human labels through model predictions. Our stable image IDs, hashes of relative paths, matter here. If we regenerate the manifest, a label attached to an ID doesn't get lost. I'd suggest we adopt their convention explicitly: add columns for model prediction and confidence next to the human label, so human truth and model guesses never overwrite each other.

---

### Slide 14: Parallel 3, Our dashboard is the start of LabelChecker
**On the slide**
- LabelChecker: view images in their original format, annotate and validate
- Our dashboard: filter by site, water body, date, sample code, dilution, processing; click a folder to see its images
- Next step: add label assignment and a review mode

**Speaker notes (≈ 1.5 min)**
Our dashboard already lets us search and filter by site, water body type, date, sample code, dilution and processing status, and load a folder's images on demand. LabelChecker's selling point is that it shows images without transforming them, and our approach is similar: we serve the original images from per-folder JSON files rather than converting everything. What we're missing is the write path. The natural next feature is letting a user click an image, assign a label, and save it to the manifest, plus a validation mode that shows model predictions for a human to accept or correct. That would make our dashboard our own LabelChecker.

---

### Slide 15: Lesson, Build the labeled set the way they did
**On the slide**
1. Define the label categories with Prof. Ahlgren (what do we want to detect?)
2. Hand-label a modest, *diverse* sample across sites, dates and capture modes
3. Train a small model on it
4. Predict on the rest; **humans validate, not relabel**
5. Retrain with the corrected labels

**Speaker notes (≈ 1.5 min)**
The bootstrap loop is the practical heart of the paper. We don't need to hand-label thousands of images. We label a diverse starting set, and diversity matters: our data comes from different sites, dates, and capture modes, autoimage versus trigger, and a model trained on one condition can fail on another. Then a model proposes labels for the rest, and we spend our human time correcting. Each round makes the model better and the correction work smaller. Before any of this, we need agreed categories, and that is a conversation with the professor rather than a coding task.

---

### Slide 16: Lesson, Keep the model small, and use metadata as an input
**On the slide**
- Paper's demo: shallow, multi-input model
- Our dataset has free side information: site, water body type, dilution, capture mode, image dimensions
- Start simple (small CNN or feature-based baseline) before anything heavy
- Hold out *whole sites or dates* when testing, not random images

**Speaker notes (≈ 1.5 min)**
Two takeaways for modeling. First, the paper suggests a small model with multiple inputs is a respectable approach, and the abstract says it was enough to demonstrate the workflow. We already have a CNN reference notebook in our repo, so a small convolutional network is a reasonable baseline. Second, we have metadata the paper's idea says to exploit: dilution and capture mode change how an image looks, so feeding them in could help. One caution that goes beyond the abstract, and is standard practice: images from the same sample are highly similar, so if we split train and test randomly we'll get inflated accuracy. We should split by sample, site or date so the test set simulates genuinely new data.

---

### Slide 17: Proposed next steps for our project
**On the slide**
1. Add `prediction`, `confidence`, `label_source` (human/model) and `validated` columns to the manifest
2. Add a labeling and validation view to the dashboard
3. Agree on a label set with Prof. Ahlgren
4. Label a diverse starter set
5. Train a small baseline; evaluate with site/date-based splits
6. Consider size-based filtering of particles or objects, as in the paper, if relevant to our images

**Speaker notes (≈ 1 min)**
So here's the roadmap. Extend the manifest, add the labeling view, define categories, label a starter set, train a baseline, and evaluate honestly. The size-threshold idea is worth discussing with the professor: if we're only interested in particles above a certain size, filtering early reduces noise before classification. Biovolume itself may or may not matter for us, but the idea of extracting quantitative traits from each image, rather than only classifying, is worth keeping in mind.

---

### Slide 18: Takeaways
**On the slide**
- The bottleneck in imaging science is **data processing**, not data collection
- Winning design: **modular, open, one CSV, human-in-the-loop**
- Our catalog and dashboard are the same first stages; labeling and classification come next
- Process quality (reproducible, validated) matters as much as model quality

**Speaker notes (≈ 30 sec)**
To close: the paper argues the hard part of imaging science is processing what the instruments produce, and its answer is a modular, open pipeline built around a shared CSV with a human checking the machine's work. We've already built the first half of that pipeline for our own data. The paper gives us a credible, published template for the second half. Thank you, and I'm happy to take questions.

---

## PART 3. Likely Q&A

- **Is our water sample data from a FlowCam?** Don't claim it is unless confirmed. The paper's value to us is the pipeline design, not the instrument. Ask Prof. Ahlgren.
- **Why not just use VisualSpreadsheet or LabelChecker directly?** LabelChecker expects the preprocessing CSV format for FlowCam data. We could borrow the idea, or possibly adapt it, but our metadata comes from folder names, so our own catalog and dashboard fit better.
- **Why a shallow model?** Small labeled datasets and limited compute; easier to train, explain and reproduce. (The abstract describes it as a demonstration of the workflow.)
- **How do we trust model labels?** Keep human labels and predictions in separate columns, validate before using predictions as truth, and test on held-out sites or dates.
- **What does "biovolume" mean?** An estimate of a particle's three-dimensional volume computed from its 2D outline using a distance map; it shows biomass better than raw counts.
