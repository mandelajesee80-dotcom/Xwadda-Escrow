XWADDA ESCROW  (works with ONLY these two files: index.html + README.txt)

HOW TO GET THE SITE BACK UP (GitHub Pages)
1. Open your repo Xwadda-Escrow on GitHub.
2. Click index.html > pencil icon (or Add file > Upload files) and replace it with the new index.html. Commit.
3. Repo > Settings > Pages > Source: "Deploy from a branch", Branch: main, folder: / (root). Save.
4. Wait about 1 minute, then open  https://YOUR-USERNAME.github.io/Xwadda-Escrow/
   Press Ctrl+Shift+R (hard refresh) if you still see the old page.

WHY IT WENT DOWN BEFORE
The old index.html needed a Node server (server.js) for accounts, deals and chat. GitHub Pages cannot run a server, so
every button failed. This new index.html contains its own built-in engine and runs by itself, with no server.

DEMO MODE (what you get on GitHub Pages)
- Everything works: sign up, deals, join codes, chat bot, fees, wallet, USDT kiosk, scam check, admin dashboard.
- Data is saved in THAT browser only (localStorage). A buyer on one phone will NOT see a seller on another phone.
  To test a full deal, use one browser: create account A, create a deal, sign out, create account B, join with the code.
- In demo mode the FIRST account created in a browser becomes admin so you can try "Confirm funds".
- Do not use demo mode for real customer money. Anyone can clear or change their own browser data.

OPTIONAL SETTINGS (top of index.html, before the first <script>)
  window.XW_LOCAL={admins:['you@example.com'], rate:129, spread:1.5, payName:'Joshua', payPhone:'0745090132'};
  Add this line inside the first <script> tag if you want to change the rate, spread, payment name/number or admin emails.

REAL MULTI-DEVICE MODE (later, when you are ready)
Run the server version (server.js, package.json) on Render/Railway/a VPS, then in index.html set
  window.XW_API='https://your-server-address';
The page automatically uses the server when it can reach it, and falls back to demo mode when it cannot.
Real money also needs automatic payment checks (M-Pesa Daraja / blockchain) and a security review first.
