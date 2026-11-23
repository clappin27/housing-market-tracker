// Small dependency-free SVG line chart: hairline grid, 2px lines, end dots with a
// surface ring, sparing end-value labels, and a crosshair tooltip that lists every
// series at the hovered month. Also keyboard-driven (focus the chart, use arrows).

const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthLabel = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;

function svg(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceStep(span, target) {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   series: {name: string, slot: number, points: (number|null)[]}[], // points[i] is month x0+i
 *   x0: number, x1: number,
 *   formatTick: (v:number)=>string, formatValue: (v:number)=>string,
 *   formatEnd?: (v:number)=>string, zero?: boolean, height?: number, label: string
 * }} opts
 */
export function lineChart(host, opts) {
  host._chartOpts = opts;
  if (!host._chartObserved) {
    host._chartObserved = true;
    let lastW = 0;
    new ResizeObserver(() => {
      const w = host.clientWidth;
      if (Math.abs(w - lastW) > 4) {
        lastW = w;
        draw(host, host._chartOpts);
      }
    }).observe(host);
  }
  draw(host, opts);
}

function draw(host, opts) {
  const { series, x0, x1 } = opts;
  host.replaceChildren();
  const W = Math.max(260, host.clientWidth || 600);
  const H = opts.height || 220;
  const m = { t: 10, r: 60, b: 26, l: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (const v of s.points) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo)) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "No data for this period.";
    host.appendChild(empty);
    return;
  }
  if (opts.zero) lo = Math.min(0, lo);
  if (hi === lo) { hi += Math.abs(hi) * 0.05 || 1; lo -= Math.abs(lo) * 0.05 || 1; }
  const step = niceStep(hi - lo, 4);
  const y0 = Math.floor(lo / step) * step;
  const y1 = Math.ceil(hi / step) * step;
  const X = (i) => m.l + (x1 === x0 ? pw / 2 : ((i - x0) / (x1 - x0)) * pw);
  const Y = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;

  const root = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label });
  root.classList.add("lc-svg");

  // grid + y ticks
  const grid = svg("g", { class: "lc-grid" }, root);
  for (let v = y0; v <= y1 + step / 2; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    svg("line", { x1: m.l, x2: m.l + pw, y1: y, y2: y, class: v === y0 ? "lc-base" : "lc-gridline" }, grid);
    const t = svg("text", { x: m.l - 8, y: y + 4, class: "lc-tick", "text-anchor": "end" }, grid);
    t.textContent = opts.formatTick(v, y1); // top tick lets one axis keep one number style
  }

  // x ticks: Januaries, spaced so labels never collide
  const years = (x1 - x0) / 12 || 1;
  const yearStep = [1, 2, 5, 10, 20].find((s) => (pw / years) * s >= 52) || 20;
  for (let i = x0; i <= x1; i++) {
    if (i % 12 !== 0 || (i / 12) % yearStep !== 0) continue;
    const x = Math.round(X(i)) + 0.5;
    svg("line", { x1: x, x2: x, y1: m.t + ph, y2: m.t + ph + 4, class: "lc-base" }, grid);
    const t = svg("text", { x, y: H - 6, class: "lc-tick", "text-anchor": "middle" }, grid);
    t.textContent = String(i / 12);
  }

  // lines
  const ends = [];
  for (const s of series) {
    let d = "";
    let pen = false;
    let last = null;
    s.points.forEach((v, k) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(x0 + k).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
      last = { x: X(x0 + k), y: Y(v), v };
    });
    const path = svg("path", { d, class: "lc-line" }, root);
    path.style.stroke = `var(--s${s.slot})`;
    if (last) ends.push({ ...last, slot: s.slot });
  }

  // end dots + selective end labels (dropped entirely if any two would collide)
  const sorted = [...ends].sort((a, b) => a.y - b.y);
  const labelsFit = sorted.every((e, i) => i === 0 || e.y - sorted[i - 1].y >= 14);
  for (const e of ends) {
    const dot = svg("circle", { cx: e.x, cy: e.y, r: 4, class: "lc-dot" }, root);
    dot.style.fill = `var(--s${e.slot})`;
    if (labelsFit) {
      const t = svg("text", { x: e.x + 8, y: e.y + 4, class: "lc-end" }, root);
      t.textContent = (opts.formatEnd || opts.formatTick)(e.v, y1);
    }
  }

  // crosshair layer
  const hair = svg("g", { class: "lc-hair", visibility: "hidden" }, root);
  const vline = svg("line", { y1: m.t, y2: m.t + ph, class: "lc-crossline" }, hair);
  const hdots = series.map((s) => {
    const c = svg("circle", { r: 4, class: "lc-dot" }, hair);
    c.style.fill = `var(--s${s.slot})`;
    return c;
  });
  const hit = svg("rect", { x: m.l, y: 0, width: pw, height: H, fill: "transparent" }, root);

  const tip = document.createElement("div");
  tip.className = "lc-tip";
  tip.hidden = true;

  let current = null;
  const show = (i) => {
    i = Math.max(x0, Math.min(x1, i));
    current = i;
    const x = X(i);
    vline.setAttribute("x1", x);
    vline.setAttribute("x2", x);
    hair.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "lc-tip-head";
    head.textContent = monthLabel(i);
    tip.appendChild(head);
    series.forEach((s, k) => {
      const v = s.points[i - x0];
      const row = document.createElement("div");
      row.className = "lc-tip-row";
      const key = document.createElement("span");
      key.className = "lc-key";
      key.style.background = `var(--s${s.slot})`;
      const val = document.createElement("strong");
      val.textContent = v == null ? "No data" : opts.formatValue(v);
      const name = document.createElement("span");
      name.className = "lc-tip-name";
      name.textContent = s.name;
      row.append(key, val, name);
      tip.appendChild(row);
      if (v == null) hdots[k].setAttribute("visibility", "hidden");
      else {
        hdots[k].setAttribute("visibility", "visible");
        hdots[k].setAttribute("cx", x);
        hdots[k].setAttribute("cy", Y(v));
      }
    });
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = x + 12 + tw > W ? x - 12 - tw : x + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${m.t}px`;
  };
  const hide = () => {
    current = null;
    hair.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const indexAt = (evt) => {
    const r = root.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    return Math.round(x0 + ((px - m.l) / pw) * (x1 - x0));
  };
  hit.addEventListener("pointermove", (e) => show(indexAt(e)));
  hit.addEventListener("pointerdown", (e) => show(indexAt(e)));
  hit.addEventListener("pointerleave", hide);

  host.tabIndex = 0;
  host.setAttribute("aria-label", `${opts.label}. Use left and right arrow keys to read values.`);
  host.onkeydown = (e) => {
    const jump = e.shiftKey ? 12 : 1;
    if (e.key === "ArrowLeft") show((current ?? x1) - jump);
    else if (e.key === "ArrowRight") show((current ?? x1 - 1) + jump);
    else if (e.key === "Home") show(x0);
    else if (e.key === "End") show(x1);
    else if (e.key === "Escape") hide();
    else return;
    e.preventDefault();
  };
  host.onblur = hide;

  host.append(root, tip);
}
