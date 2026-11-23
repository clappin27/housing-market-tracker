import { lineChart, monthLabel } from "./linechart.js";

const US_ID = "102001";
const CHART_KEYS = ["zhvi", "zori", "inventory", "days_pending"];
const COMPARE_SLOTS = [2, 3, 4];
const RANGES = [["5y", "5 yrs", 60], ["10y", "10 yrs", 120], ["all", "All", null]];

const app = document.getElementById("app");
const S = {
  meta: null,
  alerts: null,
  metros: [],
  byId: new Map(),
  datasets: {},
  series: new Map(),
  range: "10y",
  compare: [], // [{id, slot}]
  compareFor: null,
  token: 0,
  table: { sort: "rank", dir: 1, q: "", st: "", limit: 50 },
};

// ------------------------------------------------------------------ formatting

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdShort = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumSignificantDigits: 3 });
const num = new Intl.NumberFormat("en-US");
const numShort = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });

/** style: "full" (tooltips, tables), "short" (tiles, axis ticks, end labels) */
function fmt(unit, v, style = "full") {
  if (v == null) return "—";
  if (unit === "usd") return style === "full" ? usd.format(v) : usdShort.format(v);
  if (unit === "usd_month") return style === "short" && v >= 10000 ? usdShort.format(v) : usd.format(v);
  if (unit === "count") return style === "short" && v >= 10000 ? numShort.format(v) : num.format(v);
  if (unit === "days") return style === "full" ? `${num.format(v)} days` : num.format(v);
  return num.format(v);
}
const signed = (p) => `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`;
const mIdx = (s) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

// ------------------------------------------------------------------ DOM helpers

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}

function icon(kind, size = 18) {
  const paths = {
    house: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    search: "M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.43 1.06-1.06-4.43-4.43A6.5 6.5 0 0 0 10.5 4zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
    download: "M12 3v11m0 0-4.5-4.5M12 14l4.5-4.5M4 17v3h16v-3",
  };
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", paths[kind]);
  if (kind === "search") p.setAttribute("fill", "currentColor");
  else {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.7");
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-linecap", "round");
  }
  s.appendChild(p);
  return s;
}

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json();
}

function loadSeries(id) {
  if (!S.series.has(id)) {
    const p = getJSON(`data/series/${id}.json`).catch((e) => {
      S.series.delete(id);
      throw e;
    });
    S.series.set(id, p);
  }
  return S.series.get(id);
}

// ------------------------------------------------------------------ search combobox

let comboCount = 0;
function combobox(root, { placeholder, label, onPick, exclude = () => false }) {
  const listId = `combo-list-${++comboCount}`;
  const input = h("input", {
    type: "search", placeholder, "aria-label": label, autocomplete: "off", spellcheck: "false",
    role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": listId,
  });
  const list = h("ul", { role: "listbox", id: listId, hidden: true });
  const ic = icon("search", 16);
  ic.classList.add("combo-icon");
  root.append(ic, input, list);

  let items = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const paint = () => {
    if (!input.value.trim()) return close();
    list.replaceChildren(
      ...(items.length
        ? items.map((m, i) =>
            h("li", {
              role: "option", id: `${listId}-${i}`, "aria-selected": i === active ? "true" : "false",
              onmousedown: (e) => { e.preventDefault(); pick(m); },
            },
            h("span", { text: m.name }),
            h("span", { class: "combo-meta", text: m.latest.zhvi ? usdShort.format(m.latest.zhvi[0]) : "" })))
        : [h("li", { class: "combo-empty", text: "No matching metro areas" })]),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const search = () => {
    const q = input.value.trim().toLowerCase();
    const toks = q.split(/[\s,]+/).filter(Boolean);
    items = toks.length
      ? S.metros
          .filter((m) => !exclude(m) && toks.every((t) => m.name.toLowerCase().includes(t)))
          .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.rank - b.rank)
          .slice(0, 8)
      : [];
    active = items.length ? 0 : -1;
    paint();
  };
  const pick = (m) => {
    input.value = "";
    close();
    onPick(m);
  };
  input.addEventListener("input", search);
  input.addEventListener("focus", () => input.value.trim() && search());
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === "Enter") {
      if (items[active]) pick(items[active]);
    } else if (e.key === "Escape") {
      input.value = "";
      close();
    } else return;
    e.preventDefault();
  });
  return input;
}

// ------------------------------------------------------------------ shared pieces

function tile(metro, key) {
  if (key === "yield") {
    if (metro.yield == null) return null;
    return h("div", { class: "tile" },
      h("div", { class: "tile-label", text: "Gross rent yield" }),
      h("div", { class: "tile-value", text: `${metro.yield.toFixed(1)}%` }),
      h("div", { class: "tile-delta", text: "Yearly rent ÷ home value" }));
  }
  const ds = S.datasets[key];
  const L = metro.latest[key];
  if (!ds || !L) return null;
  const [v, ch] = L;
  const value = h("div", { class: "tile-value" }, fmt(ds.unit, v, "short"));
  if (ds.unit === "usd_month") value.append(h("small", { text: " /mo" }));
  if (ds.unit === "days") value.append(h("small", { text: " days" }));
  const label = ds.latest_month !== S.meta.latest_month ? `${ds.label} (${monthLabel(mIdx(ds.latest_month))})` : ds.label;
  return h("div", { class: "tile", title: ds.note },
    h("div", { class: "tile-label", text: label }),
    value,
    h("div", { class: "tile-delta" },
      ch == null ? "No year-ago figure" : [h("strong", { text: `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${signed(ch)}` }), " vs a year ago"]));
}

function tiles(metro, keys) {
  return h("div", { class: "tiles" }, keys.map((k) => tile(metro, k)));
}

function photoTitle(photo) {
  try {
    return decodeURIComponent(photo.wiki_page.split("/wiki/")[1]).replace(/_/g, " ");
  } catch {
    return "";
  }
}

function credit(photo, cls, long) {
  const file = safeUrl(photo.file_page);
  const lic = safeUrl(photo.license_url);
  const ext = { target: "_blank", rel: "noopener" };
  return h("p", { class: cls, title: `Photo: ${photo.credit}, ${photo.license}` },
    "Photo: ",
    file ? h("a", { href: file, ...ext, text: photo.credit }) : photo.credit,
    " · ",
    lic ? h("a", { href: lic, ...ext, text: photo.license }) : photo.license,
    long ? ", via Wikimedia Commons" : null);
}

function fallbackArt(size) {
  return h("div", { class: "photo-fallback" }, icon("house", size));
}

// ------------------------------------------------------------------ home view

const ALERT_TAGS = {
  streak: "Losing streak", turn: "Turning point", big: "Big move",
  extreme: "Multi-year high/low", record: "Record", mover: "Top mover",
};
const ALERTS_SHOWN = 6;

function alertRow(a) {
  const isUS = a.id === US_ID;
  return h("li", { class: "alert" },
    h("span", { class: "alert-dir", text: a.dir === "up" ? "▲" : "▼", "aria-label": a.dir === "up" ? "Up" : "Down" }),
    h("div", { class: "alert-body" },
      h("a", { class: "alert-area", href: `#/metro/${a.id}`, text: isUS ? "United States" : a.name }),
      h("p", { class: "alert-text", text: a.text })),
    h("span", { class: "alert-tag", text: ALERT_TAGS[a.kind] || "" }));
}

function alertsSection() {
  const A = S.alerts;
  if (!A || !Array.isArray(A.alerts)) return null;
  const month = monthLabel(mIdx(A.month));
  const followed = Math.max(0, (A.watching || 1) - 1);
  const head = h("div", { class: "section-head" },
    h("h2", { id: "alerts-h", text: "Market alerts" }),
    h("p", { text: `What stood out in the ${month} data for the U.S., ${followed} watched metro areas, and the biggest movers among the ${A.mover_pool} largest.` }));
  if (!A.alerts.length) {
    return h("section", { "aria-labelledby": "alerts-h" }, head,
      h("p", { class: "alerts-empty", text: `Nothing unusual in the ${month} data for the watched areas.` }));
  }
  const list = h("ul", { class: "alert-list" });
  let open = false;
  const toggle = h("button", {
    class: "btn", type: "button", "aria-expanded": "false",
    onclick: () => { open = !open; toggle.setAttribute("aria-expanded", String(open)); paint(); },
  });
  const paint = () => {
    list.replaceChildren(...(open ? A.alerts : A.alerts.slice(0, ALERTS_SHOWN)).map(alertRow));
    toggle.textContent = open ? "Show fewer" : `Show all ${A.alerts.length} alerts`;
  };
  paint();
  return h("section", { "aria-labelledby": "alerts-h" }, head, list,
    A.alerts.length > ALERTS_SHOWN ? h("div", { class: "more" }, toggle) : null);
}

function card(m) {
  const L = m.latest;
  const p = m.photo && safeUrl(m.photo.card) ? m.photo : null;
  const stats = [
    L.zhvi && L.zhvi[1] != null ? `${signed(L.zhvi[1])} in a year` : null,
    L.zori ? `rent ${usd.format(L.zori[0])}/mo` : null,
  ].filter(Boolean).join(" · ");
  return h("article", { class: "card" },
    h("a", { class: "card-link", href: `#/metro/${m.id}` },
      h("div", { class: "card-photo" },
        p ? h("img", { src: p.card, alt: `View of ${photoTitle(p) || m.name}`, loading: "lazy", decoding: "async" }) : fallbackArt(36)),
      h("div", { class: "card-body" },
        h("span", { class: "card-name", text: m.name }),
        h("span", { class: "card-value", text: L.zhvi ? usd.format(L.zhvi[0]) : "—" }),
        h("span", { class: "card-stats", text: stats || " " }))),
    p ? credit(p, "photo-credit", false) : null);
}

const COLS = [
  { key: "rank", label: "#", get: (m) => m.rank, cell: (v) => String(v) },
  { key: "name", label: "Metro area", get: (m) => m.name },
  { key: "zhvi", label: "Home value", get: (m) => m.latest.zhvi?.[0], cell: (v) => usd.format(v) },
  { key: "zhvi_ch", label: "1-yr", get: (m) => m.latest.zhvi?.[1], cell: signed },
  { key: "zori", label: "Rent /mo", get: (m) => m.latest.zori?.[0], cell: (v) => usd.format(v) },
  { key: "zori_ch", label: "1-yr", get: (m) => m.latest.zori?.[1], cell: signed },
  { key: "yield", label: "Gross yield", get: (m) => m.yield, cell: (v) => `${v.toFixed(1)}%` },
  { key: "inventory", label: "For sale", get: (m) => m.latest.inventory?.[0], cell: (v) => num.format(v) },
  { key: "days_pending", label: "Days to pending", get: (m) => m.latest.days_pending?.[0], cell: (v) => num.format(v) },
];

function rankingSection() {
  const T = S.table;
  const states = [...new Set(S.metros.filter((m) => m.state).map((m) => m.state))].sort();
  const body = h("tbody");
  const count = h("span", { class: "table-count" });
  const more = h("div", { class: "more" });
  const headRow = h("tr");
  const thead = h("thead", {}, headRow);

  const paintHead = () => {
    headRow.replaceChildren(...COLS.map((c) => {
      const activeSort = T.sort === c.key;
      return h("th", { scope: "col", "aria-sort": activeSort ? (T.dir > 0 ? "ascending" : "descending") : "none" },
        h("button", {
          class: "sort-btn", type: "button", "aria-sort-active": activeSort ? "true" : "false",
          onclick: () => {
            if (T.sort === c.key) T.dir = -T.dir;
            else { T.sort = c.key; T.dir = c.key === "name" || c.key === "rank" ? 1 : -1; }
            paintHead();
            paintBody();
          },
        }, c.label, activeSort ? (T.dir > 0 ? " ↑" : " ↓") : ""));
    }));
  };

  const paintBody = () => {
    const q = T.q.trim().toLowerCase();
    const col = COLS.find((c) => c.key === T.sort);
    const rows = S.metros
      .filter((m) => m.type === "metro" && (!T.st || m.state === T.st) && (!q || m.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = col.get(a);
        const vb = col.get(b);
        if (va == null && vb == null) return a.rank - b.rank;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * T.dir || a.rank - b.rank;
      });
    const shown = rows.slice(0, T.limit);
    body.replaceChildren(...shown.map((m) => {
      const href = `#/metro/${m.id}`;
      return h("tr", { onclick: (e) => { if (!e.target.closest("a")) location.hash = href; } },
        COLS.map((c) => {
          if (c.key === "name") return h("td", {}, h("a", { href, text: m.name }));
          const v = c.get(m);
          return v == null ? h("td", { class: "dim", text: "—" }) : h("td", { class: c.key === "rank" ? "dim" : null, text: c.cell(v) });
        }));
    }));
    count.textContent = rows.length ? `Showing ${num.format(shown.length)} of ${num.format(rows.length)}` : "No metro areas match.";
    more.replaceChildren(rows.length > shown.length
      ? h("button", { class: "btn", type: "button", onclick: () => { T.limit += 100; paintBody(); } }, `Show ${Math.min(100, rows.length - shown.length)} more`)
      : "");
  };

  const filter = h("input", {
    type: "search", placeholder: "Filter by name", "aria-label": "Filter metro areas by name", value: T.q,
    oninput: (e) => { T.q = e.target.value; T.limit = 50; paintBody(); },
  });
  const stateSel = h("select", {
    "aria-label": "Filter by state",
    onchange: (e) => { T.st = e.target.value; T.limit = 50; paintBody(); },
  }, h("option", { value: "", text: "All states" }), states.map((s) => h("option", { value: s, text: s, selected: s === T.st })));

  paintHead();
  paintBody();
  return h("section", {},
    h("div", { class: "section-head" },
      h("h2", { text: "All metro areas" }),
      h("p", { text: `Latest month: ${monthLabel(mIdx(S.meta.latest_month))}. Select a row for charts.` })),
    h("div", { class: "controls" },
      filter, stateSel, count, h("span", { class: "spacer" }),
      h("a", { class: "btn", href: "data/latest.csv", download: "housing-market-latest.csv" }, icon("download", 16), "Download CSV")),
    h("div", { class: "table-wrap" }, h("table", { class: "rank-table" }, thead, body)),
    more);
}

function renderHome() {
  document.title = S.meta.site_title;
  const us = S.byId.get(US_ID);
  const latest = monthLabel(mIdx(S.meta.latest_month));
  app.replaceChildren(
    h("section", {},
      h("h1", { text: "U.S. housing market" }),
      h("p", {
        class: "lede",
        text: `Typical home values, rents and listings for ${num.format(S.meta.metro_count)} metro areas, from Zillow Research. Data through ${latest}. The site checks for new numbers every day.`,
      }),
      us ? tiles(us, ["zhvi", "zori", "yield", "inventory", "days_pending"]) : null,
      us ? h("p", { style: { marginTop: "12px" } }, h("a", { href: `#/metro/${US_ID}`, text: "National trends →" })) : null),
    alertsSection(),
    h("section", {},
      h("div", { class: "section-head" }, h("h2", { text: "Featured metro areas" })),
      h("div", { class: "card-grid" }, S.meta.featured.map((id) => S.byId.get(id)).filter(Boolean).map(card))),
    rankingSection(),
  );
}

// ------------------------------------------------------------------ metro view

function sliceSeries(s, x0, x1) {
  const start = mIdx(s.start);
  const out = new Array(x1 - x0 + 1);
  for (let i = x0; i <= x1; i++) {
    const v = s.values[i - start];
    out[i - x0] = v === undefined ? null : v;
  }
  return out;
}

function chartCard(key, entities) {
  const ds = S.datasets[key];
  const last = mIdx(ds.latest_month);
  const main = entities[0];
  let shown = entities.filter((e) => e.s && e.s[key]);
  const notes = [];
  if (key === "inventory" && main.id !== US_ID && shown.some((e) => e.id === US_ID)) {
    shown = shown.filter((e) => e.id !== US_ID);
    notes.push("United States isn't shown here: its national total would flatten every metro line.");
  }
  const missing = entities.filter((e) => !(e.s && e.s[key])).map((e) => e.name);
  if (missing.length) notes.push(`Zillow has no ${ds.label.toLowerCase()} figures for ${missing.join(", ")}.`);

  const months = RANGES.find((r) => r[0] === S.range)[2];
  const x1 = last;
  const x0 = months ? last - months + 1 : Math.min(...shown.map((e) => mIdx(e.s[key].start)));
  const series = shown.map((e) => ({ id: e.id, name: e.name, slot: e.slot, points: sliceSeries(e.s[key], x0, x1) }));

  const mainNow = main.s && main.s[key] ? sliceSeries(main.s[key], x1, x1)[0] : null;
  const chartHost = h("div", { class: "chart" });
  const tableHost = h("div", { class: "table-wrap", hidden: true });
  const toggle = h("button", {
    class: "ghost", type: "button", "aria-expanded": "false",
    onclick: () => {
      const open = tableHost.hidden;
      tableHost.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide table" : "Table";
      if (open && !tableHost.firstChild) tableHost.append(seriesTable(series, x0, x1, ds.unit));
    },
  }, "Table");

  const cardEl = h("article", { class: "chart-card" },
    h("header", {},
      h("div", {},
        h("h3", { text: ds.label }),
        h("p", { class: "chart-sub" },
          `${main.name}, ${monthLabel(x1)}: `,
          h("span", { class: "now", text: fmt(ds.unit, mainNow) }))),
      toggle),
    series.length > 1
      ? h("div", { class: "legend" }, series.map((s) => h("span", {}, h("i", { class: "key", style: { background: `var(--s${s.slot})` } }), s.name)))
      : null,
    chartHost,
    tableHost,
    notes.map((n) => h("p", { class: "chart-note", text: n })));

  requestAnimationFrame(() =>
    lineChart(chartHost, {
      series, x0, x1,
      label: `${ds.label}, ${monthLabel(x0)} to ${monthLabel(x1)}: ${series.map((s) => s.name).join(", ")}`,
      formatTick: (v, top) => fmt(ds.unit, v, ds.unit === "usd" || top >= 10000 ? "short" : "full").replace(" days", ""),
      formatValue: (v) => fmt(ds.unit, v, "full"),
    }));
  return cardEl;
}

function seriesTable(series, x0, x1, unit) {
  const rows = [];
  for (let i = x1; i >= x0; i--) {
    if (series.every((s) => s.points[i - x0] == null)) continue;
    rows.push(h("tr", {}, h("td", { text: monthLabel(i) }), series.map((s) => h("td", { text: fmt(unit, s.points[i - x0]) }))));
  }
  return h("table", {},
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Month" }), series.map((s) => h("th", { scope: "col", text: s.name })))),
    h("tbody", {}, rows));
}

async function drawCharts(metro, grid, token) {
  grid.classList.add("refreshing");
  const ids = [metro.id, ...S.compare.map((c) => c.id)];
  let data;
  try {
    data = await Promise.all(ids.map(loadSeries));
  } catch (e) {
    if (token === S.token) grid.replaceChildren(h("p", { class: "error", text: `Chart data didn't load (${e.message}).` }));
    return;
  }
  if (token !== S.token) return;
  const entities = ids.map((id, i) => ({
    id, name: S.byId.get(id).name, slot: i === 0 ? 1 : S.compare[i - 1].slot, s: data[i],
  }));
  grid.replaceChildren(...CHART_KEYS.map((k) => chartCard(k, entities)));
  grid.classList.remove("refreshing");
}

function renderMetro(metro) {
  const token = ++S.token;
  document.title = `${metro.name} · ${S.meta.site_title}`;
  const isUS = metro.type === "country";
  if (S.compareFor !== metro.id) {
    S.compare = isUS ? [] : [{ id: US_ID, slot: 2 }];
    S.compareFor = metro.id;
  }
  const p = metro.photo && safeUrl(metro.photo.src) ? metro.photo : null;
  const ds0 = S.datasets.zhvi;
  const sub = isUS
    ? `National figures · data through ${monthLabel(mIdx(ds0.latest_month))}`
    : `Metro area · #${metro.rank} by population · data through ${monthLabel(mIdx(ds0.latest_month))}`;

  const grid = h("div", { class: "chart-grid" }, h("p", { class: "loading", text: "Loading charts…" }));
  const redraw = () => drawCharts(metro, grid, S.token);

  const rangeSeg = h("div", { class: "seg", role: "group", "aria-label": "Time range" },
    RANGES.map(([key, label]) =>
      h("button", {
        type: "button", "aria-pressed": S.range === key ? "true" : "false",
        onclick: (e) => {
          S.range = key;
          rangeSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
          redraw();
        },
      }, label)));

  const compareBox = h("div", { class: "compare" });
  const paintCompare = () => {
    const chips = S.compare.map((c) => {
      const m = S.byId.get(c.id);
      return h("span", { class: "chip" },
        h("i", { class: "key", style: { background: `var(--s${c.slot})` } }),
        m.name,
        h("button", {
          type: "button", "aria-label": `Remove ${m.name} from comparison`,
          onclick: () => { S.compare = S.compare.filter((x) => x.id !== c.id); paintCompare(); redraw(); },
        }, "×"));
    });
    compareBox.replaceChildren(h("span", { class: "filter-label", text: "Compare with" }), ...chips);
    if (S.compare.length < COMPARE_SLOTS.length) {
      const box = h("div", { class: "combo" });
      compareBox.append(box);
      combobox(box, {
        placeholder: S.compare.length ? "Add another" : "Add a metro area",
        label: "Add a metro area to compare",
        exclude: (m) => m.id === metro.id || S.compare.some((c) => c.id === m.id),
        onPick: (m) => {
          const used = new Set(S.compare.map((c) => c.slot));
          S.compare.push({ id: m.id, slot: COMPARE_SLOTS.find((s) => !used.has(s)) });
          paintCompare();
          redraw();
          compareBox.querySelector("input")?.focus();
        },
      });
    }
  };
  paintCompare();

  const notes = h("dl", { class: "notes" },
    CHART_KEYS.concat(["list_price", "sale_price"]).map((k) => S.datasets[k]).filter(Boolean)
      .map((d) => [h("dt", { text: d.label }), h("dd", { text: d.note })]),
    h("dt", { text: "Gross rent yield" }),
    h("dd", { text: "Typical yearly rent divided by typical home value. A quick screen only: it ignores vacancy, taxes, insurance and upkeep, and Zillow's rent and value indexes cover slightly different sets of homes." }));

  app.replaceChildren(
    h("a", { class: "back", href: "#/" }, "← All metro areas"),
    h("section", { class: p ? "metro-head" : "metro-head no-photo" },
      h("div", {},
        h("h1", { text: metro.name }),
        h("p", { class: "metro-sub", text: sub }),
        tiles(metro, ["zhvi", "zori", "yield", "list_price", "sale_price", "inventory", "days_pending"])),
      p
        ? h("figure", { class: "metro-photo" },
            h("div", { class: "frame" }, h("img", { src: p.src, alt: `View of ${photoTitle(p) || metro.name}`, decoding: "async" })),
            h("figcaption", {}, credit(p, "", true)))
        : null),
    h("div", { class: "filter-row" }, h("div", {}, h("span", { class: "filter-label", text: "Range" }), rangeSeg), compareBox),
    grid,
    notes,
  );
  drawCharts(metro, grid, token);
}

// ------------------------------------------------------------------ boot

function route() {
  const match = location.hash.match(/^#\/metro\/(\d+)/);
  const metro = match && S.byId.get(match[1]);
  if (metro) renderMetro(metro);
  else {
    S.token++;
    renderHome();
  }
  window.scrollTo(0, 0);
}

function renderFooter() {
  const f = document.getElementById("footer");
  const updated = S.meta.updated_at ? new Date(S.meta.updated_at).toLocaleDateString("en-US", { dateStyle: "long" }) : null;
  const ext = { target: "_blank", rel: "noopener" };
  f.replaceChildren(
    h("p", {},
      "Data: ",
      h("a", { href: safeUrl(S.meta.source_page) || "https://www.zillow.com/research/data/", ...ext, text: "Zillow Research" }),
      " public housing data. Figures are Zillow's indexes and estimates, not appraisals."),
    S.meta.photos_enabled
      ? h("p", {}, "Photos: Wikipedia lead images from Wikimedia Commons. Each photo's author and license is credited beside it.")
      : null,
    h("p", {}, `Refreshed automatically with GitHub Actions${updated ? `. Last data change: ${updated}` : ""}. `,
      h("a", { href: "data/latest.csv", download: "housing-market-latest.csv", text: "Download the latest figures (CSV)" }), "."));
}

async function init() {
  try {
    const [meta, metros] = await Promise.all([getJSON("data/meta.json"), getJSON("data/metros.json")]);
    S.meta = meta;
    S.metros = metros;
    for (const m of metros) S.byId.set(m.id, m);
    for (const d of meta.datasets) S.datasets[d.key] = d;
    S.alerts = await getJSON("data/alerts.json").catch(() => null); // optional: older data has none
  } catch (e) {
    app.replaceChildren(h("p", { class: "error", text: `The housing data didn't load (${e.message}). If you just set up the site, run the "Update data and publish site" workflow once from the Actions tab.` }));
    return;
  }
  document.getElementById("site-title").textContent = S.meta.site_title;
  combobox(document.getElementById("search"), {
    placeholder: "Search metro areas",
    label: "Search metro areas",
    onPick: (m) => { location.hash = `#/metro/${m.id}`; },
  });
  renderFooter();
  window.addEventListener("hashchange", route);
  route();
}

init();
