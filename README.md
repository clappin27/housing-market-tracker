# Housing Market Tracker

A website and data repository with typical home values, rents, listings and days on market
for every U.S. metro area. It updates itself from Zillow Research's public data.

- **Data repo:** a GitHub Action checks Zillow Research every day. When Zillow publishes a new
  month (usually mid-month), the Action downloads it, saves it under [`site/data/`](site/data),
  and commits the change. The git history becomes a month-by-month record.
- **Website:** the same Action publishes [`site/`](site) to GitHub Pages. It has national
  figures, photo cards for featured metros, a sortable table of every metro, and a page per
  metro with charts you can compare against up to three other areas.
- **Photos:** each metro shows the lead photo from its main city's Wikipedia article. Only
  free-licensed images are used, each with its author and license credited.

Nothing to install: the update script uses only built-in Python, and the site is plain
HTML, CSS and JavaScript.

## One-time setup on GitHub

1. Push this folder to a GitHub repository. Free GitHub Pages needs a **public** repo.
2. In the repo, open **Settings → Pages**, then under **Build and deployment** set
   **Source** to **GitHub Actions**.
3. Open the **Actions** tab, choose **Update data and publish site**, and click
   **Run workflow**. A few minutes later the site is live at
   `https://<your-username>.github.io/<repo-name>/`.

After that, it runs daily on its own.

## Customizing

Edit [`config.json`](config.json) and push. The site republishes on every push.

| Setting | What it does |
|---|---|
| `site_title` | Name shown in the header and browser tab. |
| `featured_metros` | Metro names to feature on the home page, exactly as the site shows them, e.g. `["Boston, MA", "Providence, RI", "Worcester, MA"]`. Leave empty to feature the largest metros. |
| `featured_count` | How many of the largest metros to feature when `featured_metros` is empty. |
| `photos.enabled` | Set to `false` to turn photos off. |
| `contact_url` | Optional. Wikipedia requires a contact link on automated requests; on GitHub the repo URL is used automatically. Only needed for local runs outside a GitHub clone. |

New featured metros take effect on the next data run. Run the workflow by hand to see them
right away.

## Running it locally

```bash
python3 scripts/update_data.py
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000.

## Data and licensing

- **Housing figures:** [Zillow Research](https://www.zillow.com/research/data/), metro-level
  files: ZHVI (typical home value), ZORI (typical rent), median list and sale price, for-sale
  inventory, and median days to pending. Zillow offers these downloads for use in your own
  analyses. Keep the attribution on the site. If you plan commercial use, read Zillow's Terms
  of Use first.
- **Photos:** hosted by Wikimedia Commons under each file's own license (mostly Creative
  Commons). The credit line beside each photo links to its file page and license. Keep those
  credits if you change the design.
- **Why no listing photos:** photos on Zillow listings belong to the agents and photographers
  who took them, and Zillow's terms don't allow reusing them. Showing listing photos legally
  needs a licensed feed, such as an MLS IDX feed through a broker or Zillow's Bridge API,
  which requires approval.

## How it fits together

```
config.json                          settings you edit
scripts/update_data.py               downloads data and photos, writes site/data/
.github/workflows/update-and-publish.yml   daily run + publish to GitHub Pages
site/index.html, app.js, linechart.js, styles.css   the website
site/data/meta.json                  data month, dataset notes, featured list
site/data/metros.json                latest figures and photo credits for every metro
site/data/series/<id>.json           monthly history for one metro
site/data/latest.csv                 spreadsheet-friendly latest figures
site/data/photos.json                photo lookup cache
```

GitHub turns off scheduled workflows in public repos after 60 days without activity. The
monthly data commits normally count as activity. If the daily run ever stops, re-enable it
from the Actions tab.
