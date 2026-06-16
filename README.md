# pullhelper

A static web app that turns a pasted Magic: The Gathering decklist into a
printable PDF — with card colors, quantities, rarity, USD prices, and every set
each card was printed in. The PDF can be **downloaded** or **emailed** as an
attachment.

Built to be hosted for free on **GitHub Pages** (`*.github.io`).

## Features

- Paste a decklist (one card per line, optional `4 ` / `4x ` quantity prefix).
- Looks up cards via the [Scryfall API](https://scryfall.com/docs/api), entirely
  in your browser. Uses batched, rate-limited, retrying requests
  (`/cards/collection` + combined `oracleid:` searches) so 100+ card decklists
  complete without tripping Scryfall's rate limits.
- Generates one combined PDF with two stitched sections:
  1. **Try Kiosk** — Rares/Mythics priced over $2 (first page).
  2. **I'll help you find...** — everything else (commons, uncommons, and
     Rares/Mythics $2 or under).
  | Color | Qty | Card Name | Rarity | Price (USD) | Printed In Sets |
  |---|---|---|---|---|---|
  - Each row is tinted with the card's color.
  - The **Printed In Sets** column only lists draft-booster sets (those with >1
    `is:booster` card), filtering out Commander-only products etc. Two set
    caches (all sets; booster sets) are persisted in `localStorage`.
- **Download PDF** — saves to your downloads folder (works out of the box).
- **Send PDF** — emails the PDF as an attachment (needs the relay below).

## How it's structured

| File | Purpose |
|---|---|
| `index.html` | UI: name, decklist, email, two buttons |
| `styles.css` | Styling |
| `app.js` | Parsing, Scryfall queries, PDF build, download/send |
| `config.js` | Default email + relay URL + Scryfall delay |
| `apps-script/Code.gs` | Gmail email relay (Google Apps Script) |

## Running locally

It's a static site — just serve the folder:

```powershell
python -m http.server 8080
# then open http://localhost:8080
```

(Opening `index.html` directly via `file://` also works, but a local server
avoids browser quirks.)

## Email sending setup (one-time)

GitHub Pages can't send email on its own. The **Send PDF** button POSTs the PDF
to a tiny Google Apps Script web app that sends it from your Gmail.

1. Open `apps-script/Code.gs` and follow the deploy steps at the top.
2. Copy the deployed web-app URL.
3. Paste it into `config.js` as `RELAY_ENDPOINT`.
4. Commit & push.

Deploy the script under **playersuniongamecoop@gmail.com** so emails come from
that address.

## Deploying to GitHub Pages

Pages serves the repo root. Once enabled, the app lives at
`https://dazeyama.github.io/pullhelper/`.
