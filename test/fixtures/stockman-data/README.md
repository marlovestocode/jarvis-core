# Recorded fixtures for the StockMan data layer

Captured read-only on 2026-11-17 with plain GET requests to hosts already on jarvis's allowlist (`en.wikipedia.org`, `api.nasdaq.com`, `query1.finance.yahoo.com`). No credentials were involved or are stored.

| File | Real request | What it is |
|---|---|---|
| `wiki-revision-api.json` | `w/api.php?action=query&prop=revisions&titles=List_of_S&P_500_companies&rvlimit=1&rvprop=ids\|timestamp&rvdir=older&rvstart=2022-06-30T00:00:00Z` | whole response |
| `nasdaq-ndx100.json` | `api.nasdaq.com/api/quote/list-type/nasdaq100` | whole response (101 rows) |
| `yahoo-brkb-1mo-1d.json` | `chart/BRK-B?range=1mo&interval=1d` | whole response |
| `sp500-now-excerpt.html` | `wiki/List_of_S&P_500_companies` | the constituents `<table>`: header, first 6 rows, plus the BRK.B and BF.B rows. Rows removed, none edited |
| `ndx-list-now-excerpt.html` | `wiki/List_of_NASDAQ-100_companies` | constituents table: header and first 6 rows |
| `ndx-2023-excerpt.html` | `index.php?oldid=1128627537` (Nasdaq-100, revision before 2023-01-01) | member table: header and first 6 rows (Company column before Ticker) |
| `sp500-changes-2022-excerpt.html` | `index.php?oldid=1095558369` (S&P 500 list, 2022-06) | changes table: two header rows and 4 rows |

Excerpts are cut to a few rows to keep the repo small. Tests that need a full-size list lower the size check (`sane`) explicitly; one test runs the real size check against the excerpt and expects it to be refused.

Added 2026-11-17 for the earnings calendar (vault G23), same conditions:

| File | Real request | What it is |
|---|---|---|
| `nasdaq-earnings-2020-01-28-excerpt.json` | `api.nasdaq.com/api/calendar/earnings?date=2020-01-28` | a past date: rows cut to AAPL, AMD, PFE, LMT, XRX (80 in the full answer); rows have `eps` and `surprise`, every `time` is `time-not-supplied` |
| `nasdaq-earnings-2026-11-19-excerpt.json` | same, `date=2026-11-19` | a future date: rows cut to WMT, INTU, ROST (75 in the full answer); rows have `lastYearRptDt` and `lastYearEPS`, timing tags present |
| `nasdaq-earnings-2026-11-21-saturday.json` | same, `date=2026-11-21` | whole response for a Saturday: `rows` is `null` |
