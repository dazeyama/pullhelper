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
  status: document.getElementById("status"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),
};

els.email.value = CFG.DEFAULT_EMAIL;

// ---- Set caches -----------------------------------------------------------
// Two persistent caches, per spec:
//   allSets     : code -> {name, type, card_count}, every set in Magic (/sets).
//   boosterSets : code -> bool, true when `set:CODE is:booster` has >1 cards.
// The "Printed In Sets" column only shows sets where boosterSets[code] is true,
// which filters out sets with no real draft-booster presence (e.g. most
// Commander products). boosterSets grows lazily and is remembered across runs.
const SETS_KEY = "PH_ALL_SETS_V2";
const BOOSTER_KEY = "PH_BOOSTER_SETS_V1";
let allSets = {};
let boosterSets = {};

function loadCaches() {
  try { allSets = JSON.parse(localStorage.getItem(SETS_KEY)) || {}; } catch (e) { allSets = {}; }
  try { boosterSets = JSON.parse(localStorage.getItem(BOOSTER_KEY)) || {}; } catch (e) { boosterSets = {}; }
}
loadCaches();

// Cache #1 — every set in Magic. Fetched once, then served from localStorage.
async function ensureAllSets() {
  if (Object.keys(allSets).length) return;
  const res = await scryfallFetch("https://api.scryfall.com/sets");
  if (!res || !res.ok) return;
  const data = await res.json();
  for (const s of data.data || []) {
    allSets[s.code] = { name: s.name, type: s.set_type, card_count: s.card_count };
  }
  try { localStorage.setItem(SETS_KEY, JSON.stringify(allSets)); } catch (e) { /* ignore */ }
}

function setName(code, fallback) {
  return (allSets[code] && allSets[code].name) || fallback || code;
}

// Sets that can't possibly satisfy ">1 draft-booster card" — skip the request.
function cannotHaveBoosters(code) {
  const meta = allSets[code];
  if (!meta) return false;
  if ((meta.card_count || 0) <= 1) return true;
  // Commander products never carry draft boosters (the draftable "Commander"
  // sets like Commander Masters / Commander Legends use other set_types).
  return meta.type === "commander";
}

// Cache #2 — does this set have >1 draft-booster card? Queried once per code.
async function ensureBoosterStatus(code) {
  if (code in boosterSets) return boosterSets[code];
  if (cannotHaveBoosters(code)) {
    boosterSets[code] = false;
    return false;
  }
  let qualifies = false;
  const q = encodeURIComponent(`set:${code} is:booster`);
  const res = await scryfallFetch("https://api.scryfall.com/cards/search?q=" + q + "&unique=cards");
  if (res && res.ok) {
    const data = await res.json();
    qualifies = (data.total_cards || 0) > 1;
  }
  // A 404 (or null after retries) means no booster cards -> stays false.
  boosterSets[code] = qualifies;
  return qualifies;
}

// Resolve (and cache) booster status for a batch of set codes, with progress.
async function resolveBoosterSets(codes) {
  const unknown = codes.filter((c) => !(c in boosterSets));
  const need = unknown.filter((c) => !cannotHaveBoosters(c));
  unknown.forEach((c) => { if (cannotHaveBoosters(c)) boosterSets[c] = false; });
  for (let i = 0; i < need.length; i++) {
    setStatus(`Checking booster sets ${i + 1} of ${need.length}…`);
    showProgress(i / Math.max(need.length, 1));
    await ensureBoosterStatus(need[i]);
  }
  if (unknown.length) {
    try { localStorage.setItem(BOOSTER_KEY, JSON.stringify(boosterSets)); } catch (e) { /* ignore */ }
  }
}

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

    if (line) out.push({ qty, name: line });
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

  // Show only sets with real draft-booster presence.
  const boosterNames = pr.sets.filter((p) => boosterSets[p.code]).map((p) => setName(p.code, p.name));

  return {
    color,
    qty: String(entry.qty),
    name: card.name,
    rarity,
    rareMythic,
    priceNum: usd,
    price: usd !== null ? "$" + usd.toFixed(2) : "—",
    sets: boosterNames.length ? boosterNames.join(", ") : "—",
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

  // Booster status for every set that shows up across those printings.
  const codes = [...new Set([].concat(...[...printsByOracle.values()].map((v) => v.sets.map((s) => s.code))))];
  await resolveBoosterSets(codes);
  hideProgress();

  return entries.map((e) => buildRow(e, cardByName.get(e.name.toLowerCase()), printsByOracle));
}

// ---- PDF generation -------------------------------------------------------
// A card is "high value" if it's a Rare/Mythic priced strictly above $2.
// Everything else (commons, uncommons, and cheap/unpriced rares & mythics)
// goes in the second document.
function isHighValue(r) {
  return r.rareMythic && r.priceNum !== null && r.priceNum > 2;
}

// Renders one titled section (one "document") onto the current page.
function renderSection(doc, title, subtitle, sectionRows) {
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

  if (sectionRows.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(11);
    doc.setTextColor(120, 120, 120);
    doc.text("None.", 14, tableTop + 4);
    doc.setTextColor(20, 20, 20);
    return;
  }

  const body = sectionRows.map((r) => [r.color.label, r.qty, r.name, r.rarity, r.price, r.sets]);

  doc.autoTable({
    head: [["Color", "Qty", "Card Name", "Rarity", "Price (USD)", "Printed In Sets"]],
    body,
    startY: tableTop,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2, overflow: "linebreak", valign: "top", textColor: [20, 20, 20] },
    headStyles: { fillColor: [40, 44, 52], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 12, halign: "center" },
      2: { cellWidth: 48, fontStyle: "bold" },
      3: { cellWidth: 26 },
      4: { cellWidth: 22, halign: "right" },
      5: { cellWidth: "auto" },
    },
    // Tint each row with its card color.
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = sectionRows[data.row.index];
      if (row) data.cell.styles.fillColor = row.color.fill;
    },
  });
}

// Builds one combined PDF: high-value Rares/Mythics first, everything else next.
function buildPdf(name, rows) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "letter" });

  const groupA = rows.filter(isHighValue);
  const groupB = rows.filter((r) => !isHighValue(r));
  const sub = name ? `Decklist — ${name}` : "";

  renderSection(doc, "Try Kiosk", sub, groupA);
  doc.addPage();
  renderSection(doc, "I'll help you find...", sub, groupB);

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
    await ensureAllSets();
    const rows = await gatherRows(entries);
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

  const doc = await generate();
  if (!doc) return;

  setStatus("Sending email…");
  const base64 = doc.output("datauristring").split(",")[1];
  const payload = {
    to,
    name: els.name.value.trim(),
    subject: `Decklist from ${els.name.value.trim()}`,
    body: "Attached PDF for easy printing",
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
    setStatus(`PDF sent to ${to}. ✓`, "ok");
  } catch (err) {
    setStatus("Send failed: " + err.message, "err");
  }
});
