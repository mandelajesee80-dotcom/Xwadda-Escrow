Xwadda Escrow - single-file site
Upload index.html to GitHub Pages (or any host) as-is.
Everything (HTML, CSS, JS, logo) is inside index.html.
The QR code library loads from cdnjs.cloudflare.com, so an internet connection is needed for QR codes.
Sign-in uses email + password (12+ chars, upper, lower, number, symbol). This is a demo: accounts, deals and wallets are kept in memory and reset on refresh.
A real backend is needed to store users/deals/wallets, hash passwords server-side, send emails, get live KES/USDT rates and confirm payments.
