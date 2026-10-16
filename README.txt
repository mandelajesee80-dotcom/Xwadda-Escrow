XWADDA ESCROW

FILES (put all four in the MAIN folder of your GitHub repo)
  index.html   the website
  server.js    the server that connects buyer and seller on different phones
  package.json tells the host how to start the server
  README.txt   this file

HOW THE TWO PEOPLE GET CONNECTED
Buyer and seller each use their own phone. The server keeps accounts, deals, chat and balances in one place, so both see
the same deal room. The person who creates the deal shares the JOIN CODE (XWJ-XXXX-XXXX) or the invite link from the deal
room. The other person opens it, signs in or creates an account, presses "Join deal", and is placed in the opposite role.

PUT IT ONLINE ON RENDER (the website AND the server run together, no separate hosting needed)
1. Upload index.html, server.js, package.json and README.txt to your GitHub repo (replace old copies).
2. Go to render.com, sign in with GitHub, click New > Web Service, pick your Xwadda-Escrow repo.
3. Settings:  Runtime: Node.   Build command: leave empty (or: npm install).   Start command: node server.js
4. Environment variables (Environment tab):
     ADMIN_EMAILS = your-email@example.com        (the email you will sign up with to get the Admin dashboard)
     TRUST_PROXY  = 1
     DATA_FILE    = /var/data/db.json
5. SAVING DATA (important): Render's free plan erases all files every time the server restarts, sleeps or redeploys, so
   accounts and deals would disappear. For real use choose a PAID instance, open the Disks tab, add a disk with Mount path
   /var/data, and keep DATA_FILE=/var/data/db.json. Free is fine for a quick test only.
6. Deploy. Render gives you an address like https://xwadda-escrow.onrender.com . Open it on two phones to test.
7. Your own domain: in Render > Settings > Custom Domains add xwaddaescrow.co.ke and follow the DNS steps it shows.
   Then delete the CNAME file and turn off GitHub Pages (repo Settings > Pages), so the domain points only to Render.

OPTION B: KEEP THE WEBSITE ON GITHUB PAGES AND ONLY THE SERVER ON RENDER
Deploy as above, then in index.html change   window.XW_API='';   to   window.XW_API='https://your-render-address';
and add the variable  ALLOW_ORIGIN = https://your-site-address  on Render. Option A above is simpler.

WITHOUT A SERVER
If index.html cannot reach a server it falls back to demo mode: data stays in that one browser only, so two phones can
NOT see each other. Do not use demo mode for real deals.

ADMIN
Nobody is admin unless their email is in ADMIN_EMAILS on the server. Sign up with that email to see the Admin dashboard.

BACKUPS AND LIMITS
- All data is one file (DATA_FILE). Download a copy regularly.
- M-Pesa and USDT payments are confirmed by hand by an admin ("Confirm funds"). There is no automatic M-Pesa or blockchain
  check yet, and no email sending, so password reset uses the recovery key shown at sign-up.
- Before holding real customer money, have the flows reviewed and add automatic payment verification.
