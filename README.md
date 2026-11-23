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
- **Market alerts:** the home page lists what stood out in the latest month for the U.S. and
  the metros you watch. When a new month arrives, the Action also posts the alerts as an
  issue in this repo, and GitHub notifies you about it, by email if your GitHub notification
  settings allow.
- **Property cards:** list specific homes in [`site/properties.json`](site/properties.json).
  Each one gets a card with a **See Zestimate on Zillow** button, on the home page and on its
  metro's page.

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
| `alerts.metros` | Metro names to watch for alerts, written like `featured_metros`. Leave empty to watch the featured metros. The U.S. is always included. |
| `alerts.notify` | `true` posts each new month's alerts as an issue in this repo, so GitHub notifies you. `false` keeps the alerts on the site only. |
| `alerts.site_url` | Optional. The site link used in alert issues. Only needed with a custom domain. |
| `contact_url` | Optional. Wikipedia requires a contact link on automated requests; on GitHub the repo URL is used automatically. Only needed for local runs outside a GitHub clone. |

New featured metros take effect on the next data run. Run the workflow by hand to see them
right away.

## Property cards

Add homes to [`site/properties.json`](site/properties.json) (on GitHub: open the file, click
the pencil, edit, then **Commit changes**). The site updates a minute or two after you commit.
Pages may be cached for up to 10 minutes.

```json
{
  "title": "Properties",
  "properties": [
    {
      "address": "12 Elm St, Boston, MA 02118",
      "label": "For sale",
      "beds": 3,
      "baths": 2,
      "sqft": 1650,
      "note": "Renovated kitchen, close to the T.",
      "photo": "photos/12-elm-st.jpg",
      "photo_credit": "Your name"
    }
  ]
}
```

| Field | What it does |
|---|---|
| `address` | Required. Street, city, state and ZIP, separated by commas. |
| `label` | Optional tag on the photo, e.g. "For sale", "Sold", "Coming soon". |
| `beds`, `baths`, `sqft` | Optional numbers. |
| `note` | Optional short description. |
| `photo` | Optional. A photo you own or have permission to use, uploaded to [`site/photos/`](site/photos), e.g. `photos/12-elm-st.jpg`. Links to other websites aren't accepted. |
| `photo_credit`, `photo_alt` | Optional photographer credit and a description of the photo for screen readers. |
| `metro` | Optional. The metro area exactly as the site names it, e.g. `"Boston, MA"`. Without it, the card is matched to the metro named after the address's city, so a Cambridge address needs `"metro": "Boston, MA"`. |
| `zillow_url` | Optional. The home's own Zillow link. Without it, the button runs a Zillow search for the address. That usually opens the right home, but in a building with several units it can open the wrong one. |
| `title` | Optional, at the top of the file: the section heading. |

Keep in mind:

- **This site and repo are public.** List only addresses you're comfortable publishing, such as
  your own listings, not clients' private homes.
- **Zestimates stay on Zillow.** The cards link to each home's Zillow page, where its Zestimate
  is shown. Zillow's terms don't allow copying Zestimates or listing photos onto another site.
  Showing the number directly needs Zillow's Bridge API, which requires Zillow's approval.

## How alerts are chosen

Each month, for the U.S. and each watched metro, the update script checks six figures: home value,
rent, list price, sale price, homes for sale and days to pending. It flags:

- **Big move:** a yearly change of at least 5% for home values and rents, 8% for list and
  sale prices, 20% for homes for sale, or 25% for days to pending.
- **Multi-year high or low:** the highest or lowest value in at least 3 years, or a record
  with at least 5 years of data. A high or low that continues last month's is ranked lower.
- **Turning point:** the yearly change flips from up to down, or down to up, after holding
  for at least 6 months.
- **Losing streak:** home values falling 3 or more months in a row. Rents aren't checked
  for streaks, because Zillow's rent index isn't seasonally adjusted and dips every fall.
- **Top mover:** the biggest yearly gain and drop in home values and rents among the
  100 largest metros. A mover is shown only if the change is at least 1%.

Each area shows its 3 strongest alerts at most, and one per figure. To test the
notification, open the **Actions** tab, choose **Update data and publish site**, click
**Run workflow**, and tick **Also post this month's market alerts as an issue now**.

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
site/data/alerts.json                this month's market alerts
site/properties.json                 homes shown as property cards (you edit this)
site/photos/                         your own photos for property cards
```

GitHub turns off scheduled workflows in public repos after 60 days without activity. The
monthly data commits normally count as activity. If the daily run ever stops, re-enable it
from the Actions tab.
