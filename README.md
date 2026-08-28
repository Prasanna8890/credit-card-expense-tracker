# Credit Card Expense Tracker

This is a lightweight, mobile-friendly shared expense ledger for exactly three credit cards. It uses plain HTML, CSS, and JavaScript, with Google Sheets + Google Apps Script as its shared backend.

## Run locally

Open `index.html` in a browser. Until configured, it runs in clearly marked demo mode using this browser only.

## Enable the shared ledger (about five minutes)

1. Create a blank Google Sheet owned by the person managing the ledger.
2. From that spreadsheet, open **Extensions → Apps Script**.
3. Replace the starter file contents with `Code.gs` from this folder, then save.
4. Click **Deploy → New deployment → Web app**. Set **Execute as** to *Me*. Set access to the specific Google accounts who may use the shared tracker. Copy the Web App URL.
5. In `config.js`, replace the empty `apiUrl` with that URL. Host these four front-end files (`index.html`, `styles.css`, `app.js`, `config.js`) on any static host such as GitHub Pages, Netlify, or Cloudflare Pages, then share that hosted link only with authorized users.

Google Sheets is the single source of truth. Closing or refreshing the browser and opening the shared link from another authorized device loads the same transactions. Apps Script also uses a lock and unique IDs to reject accidental duplicate submissions.

## Notes

- Card names, last four digits, billing-cycle day, and optional monthly limit are editable in **Configure cards**.
- Dashboard card amounts are calendar-month totals. Billing-cycle amounts are shown separately.
- Export CSV downloads the full ledger, including ID and timestamp.
- This app intentionally stores no card numbers or credentials.
