
# WPAC Dashboard (IBTrACS-powered)

A clean split **frontend + backend** project that turns your local **IBTrACS** spreadsheet into a daily dashboard.  
It also fetches **JTWC b-decks** from the UCAR mirror for the current year.

## Quick start

1. Put your IBTrACS file as `data/ibtracs.xlsx` (you can also set an absolute path via `IBTRACS_PATH` env var).
2. Open a terminal and run:

```bash
cd backend
npm install
npm start
```

3. Visit **http://localhost:4001**.

## What it shows

- **ACE (≥35 kt)** computed as `Σ(v²)/10000` using **USA_WIND**.  
- Filters out records where `NATURE` is `DS` or `ET`.
- **Monthly ACE**, **Category days** (TD/TS/STS/TY/STY), **Monthly PAR entries**, **Storm formation by month**, and a **top-storms table**.
- **Active b-decks** (from UCAR) for the selected year.

## API

- `GET /api/summary?year=2025`
- `GET /api/storms?year=2025`
- `GET /api/storms/WP182025/track?year=2025`
- `GET /api/current/bdecks?year=2025&max=30`

## Notes

- PAR is treated as the rectangle **5–25°N, 115–135°E**.  
- The "Severe TS" bin is approximated using 1‑min winds (48–63 kt) for convenience.
- Category day totals are time‑weighted using the time difference between consecutive track points (6‑hour default for the last point).

## Configure

- `IBTRACS_PATH` – absolute or relative path to your IBTrACS Excel file
- `DEFAULT_YEAR` – defaults to the current UTC year

---

Made to mirror the look of your sample HTML but fully **data‑driven** and reusable day‑to‑day.
