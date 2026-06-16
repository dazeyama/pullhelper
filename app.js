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

// Walks every printing of a card. Returns the unique set names (in Scryfall's
// order) plus the cheapest non-null USD price seen across printings.
async function fetchAllPrints(printsUri) {
  const names = [];
  let cheapestUsd = null;
  let url = printsUri;
  let guard = 0;
  while (url && guard < 20) {
    guard++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    const data = await res.json();
    for (const p of data.data || []) {
      names.push(p.set_name);
      const usd = p.prices && p.prices.usd ? parseFloat(p.prices.usd) : null;
      if (usd !== null && (cheapestUsd === null || usd < cheapestUsd)) cheapestUsd = usd;
    }
    url = data.has_more ? data.next_page : null;
    if (url) await sleep(CFG.SCRYFALL_DELAY_MS);
  }
  return { sets: [...new Set(names)], cheapestUsd };
}

// Returns a row object for one input card.
async function lookupCard(entry) {
  try {
    const res = await fetch(
      "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(entry.name),
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) {
      return notFoundRow(entry);
    }
    const card = await res.json();
    await sleep(CFG.SCRYFALL_DELAY_MS);

    const prints = card.prints_search_uri
      ? await fetchAllPrints(card.prints_search_uri)
      : { sets: [], cheapestUsd: null };
    const color = colorInfoFromCard(card);
    const rarity = (card.rarity || "").replace(/^\w/, (c) => c.toUpperCase());
    const kiosk = card.rarity === "rare" || card.rarity === "mythic";

    // Prefer the named printing's price; fall back to the cheapest printing.
    let usd = card.prices && card.prices.usd ? parseFloat(card.prices.usd) : null;
    if (usd === null) usd = prints.cheapestUsd;

    return {
      color,
      qty: String(entry.qty),
      name: card.name,
      rarity,
      kiosk,
      price: usd !== null ? "$" + usd.toFixed(2) : "—",
      sets: prints.sets.length ? prints.sets.join(", ") : "—",
    };
  } catch (err) {
    return notFoundRow(entry);
  }
}

function notFoundRow(entry) {
  return {
    color: COLOR_STYLES.Unknown,
    qty: String(entry.qty),
    name: entry.name,
    rarity: "—",
    kiosk: false,
    price: "—",
    sets: "Not found on Scryfall",
  };
}

// Query every card sequentially (respects Scryfall rate limits).
async function gatherRows(entries) {
  const rows = [];
  for (let i = 0; i < entries.length; i++) {
    setStatus(`Looking up ${i + 1} of ${entries.length}: ${entries[i].name}…`);
    showProgress((i) / entries.length);
    rows.push(await lookupCard(entries[i]));
    showProgress((i + 1) / entries.length);
    await sleep(CFG.SCRYFALL_DELAY_MS);
  }
  return rows;
}

// ---- PDF generation -------------------------------------------------------
function buildPdf(name, rows) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "letter" });

  const title = name ? `Decklist — ${name}` : "Decklist";
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title, 14, 16);

  const body = rows.map((r) => [
    r.color.label,
    r.qty,
    r.name,
    r.rarity,
    r.price,
    r.sets,
  ]);

  doc.autoTable({
    head: [["Color", "Qty", "Card Name", "Rarity", "Price (USD)", "Printed In Sets"]],
    body,
    startY: 22,
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
    // Tint each row with its card color, and reserve height for "Try Kiosk".
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = rows[data.row.index];
      if (!row) return;
      data.cell.styles.fillColor = row.color.fill;
      if (row.kiosk && data.column.index === 3) {
        data.cell.styles.minCellHeight = 11;
      }
    },
    // Draw the italic "Try Kiosk" note under the rarity for rares/mythics.
    didDrawCell: (data) => {
      if (data.section !== "body" || data.column.index !== 3) return;
      const row = rows[data.row.index];
      if (!row || !row.kiosk) return;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(6.5);
      doc.setTextColor(90, 90, 90);
      doc.text("Try Kiosk", data.cell.x + 2, data.cell.y + data.cell.height - 2.5);
      doc.setTextColor(20, 20, 20);
    },
  });

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
