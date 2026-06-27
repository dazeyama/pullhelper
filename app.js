/* ===========================================================================
 * pullhelper — client-side decklist -> PDF
 * ---------------------------------------------------------------------------
 * Flow: parse textarea -> query Scryfall per card -> build a colored PDF table
 *       -> Download (browser) or Send (POST PDF to Apps Script email relay).
 * ======================================================================== */

const CFG = window.PULLHELPER_CONFIG;

// ---- DOM ------------------------------------------------------------------
const els = {
  name: document.getElementById("name"),
  decklist: document.getElementById("decklist"),
  email: document.getElementById("email"),
  download: document.getElementById("downloadBtn"),
  send: document.getElementById("sendBtn"),
  bulkSearch: document.getElementById("bulkSearchBtn"),
  status: document.getElementById("status"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),
};

els.email.value = CFG.DEFAULT_EMAIL;

// ---- Booster-set list (precomputed, local) --------------------------------
// boosterSets: code -> set name, for every set with >1 `is:booster` card.
// This is loaded ONCE from the static booster-sets.json shipped with the app —
// NOT queried per set at runtime. The "Printed In Sets" column shows only the
// sets present here, filtering out Commander-only products etc. Refresh the
// data by running tools/build_booster_sets.py (only when you want to update).
let boosterSets = {};
let boosterLoaded = false;

const boosterReady = (async () => {
  try {
    const res = await fetch("./booster-sets.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      boosterSets = data.sets || {};
      boosterLoaded = true;
    }
  } catch (e) {
    // If the file is missing/unreadable we fall back to showing all sets.
  }
})();

// ---- Color palette (light tints so black text stays readable) -------------
const COLOR_STYLES = {
  White:      { label: "White",      fill: [249, 246, 224] },
  Blue:       { label: "Blue",       fill: [205, 229, 247] },
  Black:      { label: "Black",      fill: [214, 214, 214] },
  Red:        { label: "Red",        fill: [247, 207, 207] },
  Green:      { label: "Green",      fill: [207, 232, 207] },
  Multicolor: { label: "Multicolor", fill: [245, 232, 176] },
  Colorless:  { label: "Colorless",  fill: [224, 224, 232] },
  Land:       { label: "Land",       fill: [230, 222, 210] },
  Unknown:    { label: "—",          fill: [245, 220, 220] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- Rate-limited, retrying fetch -----------------------------------------
// Scryfall asks for ~50-100ms between requests and returns HTTP 429 when you
// go too fast. This wrapper serializes calls with a minimum spacing and retries
// 429/503/network errors with backoff, so a 100+ card decklist never produces
// false "not found" rows. Returns the Response (including 404), or null if it
// keeps failing after all retries.
let _lastRequestAt = 0;
async function scryfallFetch(url, opts = {}, tries = 5) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const since = Date.now() - _lastRequestAt;
    if (since < CFG.SCRYFALL_DELAY_MS) await sleep(CFG.SCRYFALL_DELAY_MS - since);
    _lastRequestAt = Date.now();

    let res;
    try {
      res = await fetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
    } catch (e) {
      await sleep(400 * (attempt + 1)); // network hiccup -> back off and retry
      continue;
    }

    if (res.status === 429 || res.status === 503) {
      const retryAfter = parseFloat(res.headers.get("Retry-After"));
      const waitMs = (isNaN(retryAfter) ? 0.5 * (attempt + 1) : retryAfter) * 1000 + 250;
      await sleep(waitMs);
      continue;
    }
    return res; // 200, 404, etc. — caller decides
  }
  return null;
}

// ---- Status helpers -------------------------------------------------------
function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}
function showProgress(frac) {
  els.progressWrap.hidden = false;
  els.progressBar.style.width = Math.round(frac * 100) + "%";
}
function hideProgress() {
  els.progressWrap.hidden = true;
  els.progressBar.style.width = "0%";
}

// ---- Decklist parsing -----------------------------------------------------
// Basic lands are banned from the output entirely.
const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest"]);

function isBasicLandName(name) {
  const n = name.toLowerCase();
  return BASIC_LANDS.has(n) || n.startsWith("snow-covered ") || n === "wastes";
}

// Accepts lines like "4 Lightning Bolt", "4x Bolt", "Sol Ring",
// "1 Fire // Ice", "2 Llanowar Elves (M19) 314" (set/collector stripped).
function parseDecklist(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(\/\/|sideboard\b|deck\b|commander\b)/i.test(line)) continue;

    let qty = 1;
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/);
    if (m) {
      qty = parseInt(m[1], 10) || 1;
      line = m[2].trim();
    }
    // Strip trailing "(SET) 123" / "[SET]" collector annotations and foil tags.
    line = line.replace(/\s*[\(\[][A-Za-z0-9]{2,6}[\)\]].*$/, "").trim();
    line = line.replace(/\s*\*[FfeE]\*\s*$/, "").trim();

    if (line && !isBasicLandName(line)) out.push({ qty, name: line });
  }
  return out;
}

// ---- Scryfall lookups -----------------------------------------------------
function colorInfoFromCard(card) {
  let colors = card.colors;
  if (!colors && card.card_faces && card.card_faces[0]) {
    colors = card.card_faces[0].colors;
  }
  colors = colors || [];
  const typeLine = card.type_line || "";

  if (colors.length === 0) {
    if (typeLine.includes("Land")) return COLOR_STYLES.Land;
    return COLOR_STYLES.Colorless;
  }
  if (colors.length > 1) return COLOR_STYLES.Multicolor;
  const single = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[colors[0]];
  return COLOR_STYLES[single] || COLOR_STYLES.Unknown;
}

// Index a card under its lowercased name (and each face name, for DFCs/splits)
// so decklist entries can be matched back to it.
function indexCard(map, card) {
  map.set(card.name.toLowerCase(), card);
  if (card.card_faces) {
    for (const f of card.card_faces) {
      if (f.name && !map.has(f.name.toLowerCase())) map.set(f.name.toLowerCase(), card);
    }
  }
}

// Batch card lookup via POST /cards/collection (75 names/request). Returns a
// Map of lowercased name -> card object. Names Scryfall can't match exactly are
// retried individually through the fuzzy `named` endpoint (catches typos).
async function fetchCardData(names) {
  const byName = new Map();
  const missing = [];

  const chunks = chunkArray(names, 75);
  for (let ci = 0; ci < chunks.length; ci++) {
    setStatus(`Looking up cards (batch ${ci + 1} of ${chunks.length})…`);
    showProgress(ci / chunks.length);
    const res = await scryfallFetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunks[ci].map((n) => ({ name: n })) }),
    });
    if (res && res.ok) {
      const data = await res.json();
      for (const card of data.data || []) indexCard(byName, card);
      for (const nf of data.not_found || []) missing.push(nf.name);
    } else {
      missing.push(...chunks[ci]);
    }
  }

  for (let i = 0; i < missing.length; i++) {
    setStatus(`Resolving unmatched names ${i + 1} of ${missing.length}…`);
    const res = await scryfallFetch(
      "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(missing[i])
    );
    if (res && res.ok) {
      const card = await res.json();
      indexCard(byName, card);
      // Also index under the original (possibly misspelled) query so the entry
      // can be matched back to this card.
      byName.set(missing[i].toLowerCase(), card);
    }
  }
  return byName;
}

// Fetch every printing of many cards at once via combined `oracleid:` searches
// (chunked to stay under Scryfall's query-complexity limit). Returns a Map of
// oracle_id -> {sets: [{code, name}], cheapestUsd}.
async function fetchPrintsByOracle(oracleIds) {
  const out = new Map();
  for (const id of oracleIds) out.set(id, { sets: [], seen: new Set(), cheapestUsd: null });

  const chunks = chunkArray(oracleIds, 15);
  for (let ci = 0; ci < chunks.length; ci++) {
    const q = "(" + chunks[ci].map((id) => "oracleid:" + id).join(" or ") + ")";
    let url =
      "https://api.scryfall.com/cards/search?q=" +
      encodeURIComponent(q) +
      "&unique=prints&order=released&dir=asc";
    let guard = 0;
    while (url && guard < 40) {
      guard++;
      setStatus(`Fetching printings (batch ${ci + 1} of ${chunks.length})…`);
      const res = await scryfallFetch(url);
      if (!res || !res.ok) break;
      const data = await res.json();
      for (const p of data.data || []) {
        const e = out.get(p.oracle_id);
        if (!e) continue;
        if (!e.seen.has(p.set)) {
          e.seen.add(p.set);
          e.sets.push({ code: p.set, name: p.set_name });
        }
        const usd = p.prices && p.prices.usd ? parseFloat(p.prices.usd) : null;
        if (usd !== null && (e.cheapestUsd === null || usd < e.cheapestUsd)) e.cheapestUsd = usd;
      }
      url = data.has_more ? data.next_page : null;
    }
  }
  return out;
}

// Assemble a table row for one decklist entry from the fetched card + printings.
function buildRow(entry, card, printsByOracle) {
  if (!card) return notFoundRow(entry);

  const color = colorInfoFromCard(card);
  const rarity = (card.rarity || "").replace(/^\w/, (c) => c.toUpperCase());
  const rareMythic = card.rarity === "rare" || card.rarity === "mythic";
  const pr = printsByOracle.get(card.oracle_id) || { sets: [], cheapestUsd: null };

  // Prefer the card's own USD price; fall back to the cheapest printing.
  let usd = card.prices && card.prices.usd ? parseFloat(card.prices.usd) : null;
  if (usd === null) usd = pr.cheapestUsd;

  // Show only sets with real draft-booster presence (from the local list). If
  // the list failed to load, fall back to showing every printing's set.
  const boosterNames = pr.sets
    .filter((p) => !boosterLoaded || boosterSets[p.code])
    .map((p) => boosterSets[p.code] || p.name);

  return {
    color,
    qty: String(entry.qty),
    name: card.name,
    rarity,
    rareMythic,
    priceNum: usd,
    price: usd !== null ? "~$" + usd.toFixed(2) : "—",
    setList: boosterNames,
    sets: boosterNames.length ? boosterNames.join(", ") : "[Supplementary set only]",
  };
}

function notFoundRow(entry) {
  return {
    color: COLOR_STYLES.Unknown,
    qty: String(entry.qty),
    name: entry.name,
    rarity: "—",
    rareMythic: false,
    priceNum: null,
    setList: [],
    sets: "Not found on Scryfall",
  };
}

// Turn parsed entries into table rows using batched, rate-limited Scryfall
// calls: collection lookup -> combined printings search -> booster filtering.
async function gatherRows(entries) {
  // Unique names (preserve first original casing) for the collection lookup.
  const nameMap = new Map();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (!nameMap.has(key)) nameMap.set(key, e.name);
  }
  const cardByName = await fetchCardData([...nameMap.values()]);

  // All printings for the matched cards, in one batched search per ~15 cards.
  const cards = [...new Set([...cardByName.values()])];
  const oracleIds = [...new Set(cards.map((c) => c.oracle_id).filter(Boolean))];
  const printsByOracle = await fetchPrintsByOracle(oracleIds);
  hideProgress();

  const rows = [];
  for (const e of entries) {
    const card = cardByName.get(e.name.toLowerCase());
    // Catch-all: drop any basic land the name filter missed (e.g. odd casings).
    if (card && /\bBasic Land\b/.test(card.type_line || "")) continue;
    rows.push(buildRow(e, card, printsByOracle));
  }
  return rows;
}

// ---- PDF generation -------------------------------------------------------
// "Try Kiosk" = Rare/Mythic priced above $2.50. Everything else (commons,
// uncommons, and cheaper/unpriced rares & mythics) goes on the find page,
// which is split into bins below.
function isHighValue(r) {
  return r.rareMythic && r.priceNum !== null && r.priceNum > 2.5;
}

// Numeric price with null/undefined treated as 0 (for bin thresholds).
function priceOf(r) {
  return r.priceNum ?? 0;
}

// Find-page bin definitions (each find-page card lands in exactly one).
const FIND_BINS = [
  { title: "$1 Rare Bin", test: (r) => r.rareMythic && priceOf(r) <= 1.5 },
  { title: "$2 Rare Bin", test: (r) => r.rareMythic && priceOf(r) > 1.5 },
  { title: "Commons by set", test: (r) => !r.rareMythic && priceOf(r) < 1.35 },
  { title: "Commons by color in the back", test: (r) => !r.rareMythic && priceOf(r) >= 1.35 },
];

// Sort within a bin: WUBRG, then Multicolor, Artifact (colorless), Land;
// alphabetical by name as a tiebreak.
const BIN_COLOR_ORDER = { White: 0, Blue: 1, Black: 2, Red: 3, Green: 4, Multicolor: 5, Colorless: 6, Land: 7 };
function binSort(a, b) {
  const ca = BIN_COLOR_ORDER[a.color.label] ?? 99;
  const cb = BIN_COLOR_ORDER[b.color.label] ?? 99;
  if (ca !== cb) return ca - cb;
  return a.name.localeCompare(b.name);
}

// "Try Kiosk" pricing: drop the cents off the number and add $1.
function kioskPrice(priceNum) {
  if (priceNum === null || priceNum === undefined) return "—";
  return "~$" + (Math.floor(priceNum) + 1);
}

// "I'll help you find..." pricing: the Scryfall price plus a flat $0.35.
function findPrice(priceNum) {
  if (priceNum === null || priceNum === undefined) return "—";
  return "~$" + (priceNum + 0.35).toFixed(2);
}

const SETS_FONT = 7;     // pt, for the set list
const SETS_LINE_H = 3.0; // mm, vertical spacing between set lines

// Draws the big page title + optional subtitle. Returns the Y to start content.
function drawPageTitle(doc, title, subtitle) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text(title, 14, 16);

  let tableTop = 22;
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110, 110, 110);
    doc.text(subtitle, 14, 22);
    doc.setTextColor(20, 20, 20);
    tableTop = 27;
  }
  return tableTop;
}

// Draws the card table starting at startY; returns the Y just below it.
// kioskPricing=true rounds prices up to whole dollars + $1 (Try Kiosk sheet).
function drawCardTable(doc, sectionRows, startY, kioskPricing) {
  const body = sectionRows.map((r) => [
    r.color.label,
    r.qty,
    r.name,
    r.rarity,
    kioskPricing ? kioskPrice(r.priceNum) : findPrice(r.priceNum),
    "", // "Printed In Sets" is custom-drawn (2 columns) in didDrawCell
  ]);

  doc.autoTable({
    head: [["Color", "Qty", "Card Name", "Rarity", "Price (USD)", "Printed In Sets"]],
    body,
    startY,
    margin: { left: 14, right: 14 },
    rowPageBreak: "avoid", // keep each row whole; move it to the next page rather than splitting
    styles: {
      fontSize: 8,
      cellPadding: 2,
      overflow: "linebreak",
      valign: "top",
      textColor: [20, 20, 20],
      lineWidth: 0.2,
      lineColor: [60, 60, 60],
    },
    headStyles: { fillColor: [40, 44, 52], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { cellWidth: 10, halign: "center" },
      2: { cellWidth: 40, fontStyle: "bold" },
      3: { cellWidth: 18 },
      4: { cellWidth: 20, halign: "right" },
      5: { cellWidth: "auto" },
    },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = sectionRows[data.row.index];
      if (!row) return;
      data.cell.styles.fillColor = row.color.fill;
      // On the "I'll help you find..." sheet, highlight sub-$1 prices yellow
      // and reserve room for the "[Bulk Bins]" note drawn in didDrawCell.
      if (!kioskPricing && data.column.index === 4 && row.priceNum !== null && row.priceNum < 1) {
        data.cell.styles.fillColor = [255, 240, 130];
        data.cell.styles.minCellHeight = Math.max(data.cell.styles.minCellHeight || 0, 9);
      }
      // Reserve height for the 2-column set list drawn in didDrawCell.
      if (data.column.index === 5) {
        const n = (row.setList || []).length;
        const lines = n > 0 ? Math.ceil(n / 2) : 1;
        data.cell.styles.minCellHeight = 4 + lines * SETS_LINE_H + 1.5;
      }
    },
    // Custom drawing: "[Bulk Bins]" under sub-$1 prices, and the 2-column sets.
    didDrawCell: (data) => {
      if (data.section !== "body") return;
      const row = sectionRows[data.row.index];
      if (!row) return;

      // "[Bulk Bins]" note under the highlighted sub-$1 price (find sheet only).
      if (data.column.index === 4 && !kioskPricing && row.priceNum !== null && row.priceNum < 1) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6);
        doc.setTextColor(20, 20, 20);
        doc.text("[Bulk Bins]", data.cell.x + data.cell.width - 2, data.cell.y + 7.5, { align: "right" });
        return;
      }

      if (data.column.index !== 5) return;
      const list = row.setList || [];
      doc.setFont("helvetica", "normal");
      doc.setFontSize(SETS_FONT);
      doc.setTextColor(20, 20, 20);

      if (list.length === 0) {
        doc.text(row.sets || "—", data.cell.x + 1.5, data.cell.y + 4);
        return;
      }
      const colW = data.cell.width / 2;
      const maxW = colW - 2.5;
      for (let i = 0; i < list.length; i++) {
        const lineIdx = Math.floor(i / 2); // line within the cell
        const colIdx = i % 2;              // 0 = left column, 1 = right column
        let nm = list[i];
        while (nm.length > 1 && doc.getTextWidth(nm) > maxW) nm = nm.slice(0, -2) + "…";
        const x = data.cell.x + 1.5 + colIdx * colW;
        const y = data.cell.y + 4 + lineIdx * SETS_LINE_H;
        doc.text(nm, x, y);
      }
    },
  });

  return doc.lastAutoTable.finalY;
}

// Renders a single-table titled page (used for the Try Kiosk sheet).
function renderSection(doc, title, subtitle, sectionRows, kioskPricing) {
  const tableTop = drawPageTitle(doc, title, subtitle);
  if (sectionRows.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(11);
    doc.setTextColor(120, 120, 120);
    doc.text("None.", 14, tableTop + 4);
    doc.setTextColor(20, 20, 20);
    return;
  }
  drawCardTable(doc, sectionRows, tableTop, kioskPricing);
}

// Renders the "I'll help you find..." page as the four labeled bins, each
// sorted WUBRG > Multicolor > Artifact > Land, then alphabetically.
function renderFindPage(doc, subtitle, findRows) {
  let y = drawPageTitle(doc, "I'll help you find...", subtitle);
  const pageH = doc.internal.pageSize.getHeight();

  for (const bin of FIND_BINS) {
    const binRows = findRows.filter(bin.test).sort(binSort);

    // Don't orphan a bin heading at the very bottom of a page.
    if (y > pageH - 36) {
      doc.addPage();
      y = 16;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(20, 20, 20);
    doc.text(bin.title, 14, y + 5);

    if (binRows.length) {
      y = drawCardTable(doc, binRows, y + 8, false);
    } else {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.text("(none)", 16, y + 11);
      doc.setTextColor(20, 20, 20);
      y += 13;
    }
    y += 6; // gap before the next bin
  }
}

// Builds the combined PDF: Try Kiosk page, then the binned find page.
function buildPdf(name, rows) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
  const sub = name ? `Decklist — ${name}` : "";

  const kiosk = rows.filter(isHighValue).sort((a, b) => b.priceNum - a.priceNum);
  renderSection(doc, "Try Kiosk", sub, kiosk, true);

  doc.addPage();
  renderFindPage(doc, sub, rows.filter((r) => !isHighValue(r)));

  return doc;
}

// ---- Shared: validate + build -------------------------------------------
async function generate() {
  const entries = parseDecklist(els.decklist.value);
  if (entries.length === 0) {
    setStatus("Add at least one card to the decklist.", "err");
    return null;
  }
  els.download.disabled = true;
  els.send.disabled = true;
  try {
    await boosterReady; // ensure the local booster-set list is loaded
    const rows = await gatherRows(entries);
    cacheKioskNames(rows); // stash Try Kiosk card names for the bulk-search button
    setStatus("Building PDF…");
    const doc = buildPdf(els.name.value.trim(), rows);
    return doc;
  } finally {
    els.download.disabled = false;
    els.send.disabled = false;
    hideProgress();
  }
}

function safeFilename(name) {
  const base = name ? `Decklist - ${name}` : "Decklist";
  return base.replace(/[^a-z0-9 \-_]/gi, "").trim() + ".pdf";
}

// ---- Button: Download -----------------------------------------------------
els.download.addEventListener("click", async () => {
  const doc = await generate();
  if (!doc) return;
  doc.save(safeFilename(els.name.value.trim()));
  setStatus("PDF downloaded. ✓", "ok");
});

// ---- Button: Send ---------------------------------------------------------
const SEND_COOLDOWN_MS = 1 * 60 * 1000; // one send per minute
const LAST_SEND_KEY = "PH_LAST_SEND";

els.send.addEventListener("click", async () => {
  const to = els.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    setStatus("Enter a valid email address to send to.", "err");
    return;
  }
  if (!CFG.RELAY_ENDPOINT) {
    setStatus(
      "Email sending isn't set up yet. Deploy the Google Apps Script relay (see apps-script/Code.gs) and paste its URL into config.js.",
      "err"
    );
    return;
  }

  // Rate limit: one send per 30 minutes (persisted so a reload can't bypass it).
  const lastSend = parseInt(localStorage.getItem(LAST_SEND_KEY) || "0", 10) || 0;
  const remaining = SEND_COOLDOWN_MS - (Date.now() - lastSend);
  if (lastSend && remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    setStatus(`Send is limited to once per minute — try again in ${mins} minute${mins === 1 ? "" : "s"}.`, "err");
    return;
  }

  const doc = await generate();
  if (!doc) return;

  setStatus("Sending email…");
  const base64 = doc.output("datauristring").split(",")[1];
  const payload = {
    to,
    name: els.name.value.trim(),
    subject: `Decklist from ${els.name.value.trim()}`,
    body: "Attached PDF for easy printing\n\nMade with pullhelper — https://dazeyama.github.io/pullhelper/",
    filename: safeFilename(els.name.value.trim()),
    pdf_base64: base64,
  };

  try {
    // Apps Script web apps don't send CORS headers, so we fire-and-forget.
    await fetch(CFG.RELAY_ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    localStorage.setItem(LAST_SEND_KEY, String(Date.now())); // start the 30-min cooldown
    setStatus(`PDF sent to ${to}. ✓`, "ok");
  } catch (err) {
    setStatus("Send failed: " + err.message, "err");
  }
});

// ---- Bulk search (Try Kiosk cards on the store) ---------------------------
const KIOSK_NAMES_KEY = "PH_KIOSK_NAMES";
const MULTI_SEARCH_URL = "https://playersuniongames.crystalcommerce.com/products/multi_search";

// Cache just the plaintext names from the Try Kiosk page (Rares/Mythics > $2),
// in the same price-desc order, and reveal the bulk-search button.
function cacheKioskNames(rows) {
  const names = rows.filter(isHighValue).sort((a, b) => b.priceNum - a.priceNum).map((r) => r.name);
  try { localStorage.setItem(KIOSK_NAMES_KEY, JSON.stringify(names)); } catch (e) { /* ignore */ }
  els.bulkSearch.hidden = names.length === 0;
}

function loadKioskNames() {
  try { return JSON.parse(localStorage.getItem(KIOSK_NAMES_KEY)) || []; } catch (e) { return []; }
}

// Drop the cached names and hide the button (the cache is tied to a specific
// generated PDF, so editing the decklist or reloading invalidates it).
function clearKioskNames() {
  try { localStorage.removeItem(KIOSK_NAMES_KEY); } catch (e) { /* ignore */ }
  els.bulkSearch.hidden = true;
}

// Start every page load with the button hidden and no stale cache, and clear it
// whenever the decklist text changes.
clearKioskNames();
els.decklist.addEventListener("input", clearKioskNames);

els.bulkSearch.addEventListener("click", () => {
  const names = loadKioskNames();
  if (!names.length) {
    setStatus("No Rares/Mythics cached yet — generate a PDF first.", "err");
    return;
  }
  const url = MULTI_SEARCH_URL + "?query=" + encodeURIComponent(names.join("\n"));
  window.open(url, "_blank", "noopener");
});
