XWADDA ESCROW v2  (website + server, no npm packages needed)

WHAT CHANGED
- Joining from another device now works. Accounts, deals, chat and balances live on the server, not in the
  browser, so a buyer on one phone and a seller on another see the same deal room. Join with the XWJ code, the
  Deal ID, or the invite link. The code is forgiving: case and dashes do not matter.
- Passwords are hashed on the server (scrypt). Sessions are random tokens. Login, reset, join and message
  rate limits are enforced on the server, and only the buyer/seller of a deal (or an admin) can read it.
- Payment details are only sent to the buyer after BOTH sides confirm. Only admins can confirm received funds.
- Released money goes to the seller's Xwadda balance (Dashboard + Wallet & payouts). Withdrawals, USDT kiosk
  orders, support tickets and scam reports show up in the Admin dashboard.
- The dashboard is full width with a sticky sidebar, and the deal room has a side panel (deal info, progress,
  actions). On phones the sidebar becomes a Menu button.
- The bot understands plain words, typos and commands (with or without "/"): deal id, join code, status, confirm,
  fund, paid, release, cancel deal, refund, dispute, fees, summary, people, rates, balance, human, help.
  Release, cancel and dispute ask "Reply YES to confirm" first so nobody freezes or releases money by accident.
  Long chat between buyer and seller is left alone (the bot only reacts to short messages or when addressed).
- Cancel: before payment either side can cancel. After funding, both sides must say "cancel deal" and the buyer
  is refunded. Otherwise use "dispute".

RUN IT
1. Install Node 18 or newer (nodejs.org).
2. In this folder:   ADMIN_EMAILS=you@example.com node server.js      (Windows PowerShell: $env:ADMIN_EMAILS="you@example.com"; node server.js)
3. Open http://localhost:3000, create your account with the admin email. You now see "Admin dashboard" in the menu.

PUT IT ONLINE (pick one)
A) Render.com / Railway.app (easiest)
   - Push this folder to GitHub, create a "Web Service" from the repo. Build command: (empty). Start command: node server.js
   - Add the environment variables from .env.example (at least ADMIN_EMAILS and TRUST_PROXY=1).
   - IMPORTANT: attach a persistent disk/volume and set DATA_FILE to a path on it (e.g. /var/data/db.json).
     Without one the host wipes the database on every restart.
   - Point xwaddaescrow.co.ke at the service (custom domain) and use https.
B) Your own VPS: install Node, run "node server.js" under pm2 or systemd, put nginx/Caddy in front for https.

KEEPING THE SITE ON GITHUB PAGES
GitHub Pages cannot run the server, so deploy server.js as above (it also serves index.html itself, so you can
simply use the server address as your site). If you still want Pages for the front end, open index.html, set
   window.XW_API='https://your-server-address';
near the top, and set ALLOW_ORIGIN on the server to your Pages address.

BACKUPS AND LIMITS
- All data is one file (DATA_FILE). Copy it regularly.
- This is a single-server JSON store, fine for early traffic. If you grow, move to a real database.
- M-Pesa/USDT payments are still confirmed by hand by an admin ("Confirm funds"), as before. There is no automatic
  M-Pesa (Daraja) or blockchain check yet, and no email sending, so password reset still uses the recovery key.
- Admin is decided by ADMIN_EMAILS on the server, so it cannot be faked from the browser any more.
- Before holding real customer money, have the flows reviewed and add automatic payment verification.
