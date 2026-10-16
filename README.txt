Xwadda Escrow - GitHub Pages site (2 files: index.html + README.txt)

UPLOAD
1. Put index.html and README.txt in the root of your GitHub repo.
2. Settings > Pages > Deploy from branch > main / (root). Your site goes live on https.

SIGN-IN AND PASSWORD RESET
- Create account and sign in with email + password (12+ chars, upper, lower, number, symbol).
- Passwords are hashed in the browser (PBKDF2, 210,000 rounds, random salt), never stored as plain text.
- When an account is created the client gets a RECOVERY KEY (shown once). "Forgot password?" on the
  sign-in page resets the password with email + recovery key, then issues a new key.
- Accounts made before this update have no recovery key and cannot be reset. Re-register them.

DEAL ROOM, DEAL ID AND JOINING FROM ANOTHER DEVICE
- Every deal gets a unique Deal ID (XW-XXXXXXXX). Share it (or tap "Invite link" in the room).
- The other party signs in on THEIR OWN device, opens My deals > Join a deal, enters the Deal ID and is
  added as the opposite role. Chat, confirmations, funding status and payouts then sync between both
  devices every few seconds.
- If the creator typed the other party's email, only that email can join.
- Deal summary and welcome show as neat cards on a patterned chat background.
- Only the buyer can fund or release. Each person sees only their own confirm button.

ONE-TIME SETUP FOR SHARED DEALS (free, about 3 minutes, needed for joining across devices)
Without this step deals only exist in one browser and joining only works on that same device.
1. Go to console.firebase.google.com > Add project (any name; turn Google Analytics off).
2. Build > Realtime Database > Create database (any location) > start in LOCKED mode.
3. Open the Rules tab, paste this, press Publish:
   { "rules": { ".read": false, ".write": false, "deals": { "$id": { ".read": true, ".write": true } } } }
   This lets someone open a deal only if they know its Deal ID. Nobody can list all deals.
4. Copy the database URL from the Data tab (looks like https://NAME-default-rtdb.firebaseio.com).
5. In index.html find   var BACKEND='',   and put your URL between the quotes. Commit. Done.

ACCOUNTS ARE STILL PER DEVICE
Sign-in accounts are saved in each browser, so each person creates their own account on their own
device (that is how the other party joins). Signing in to the SAME account from two devices is not
possible until you move accounts to a real auth service (Firebase Auth or Supabase).

IMPORTANT LIMITS (GitHub Pages is static)
- Anyone who knows a Deal ID can read and edit that deal in the database, so keep Deal IDs private.
  This is NOT secure enough to hold real money, or to protect the admin dashboard. Admin emails go in
  ADMIN_EMAILS inside index.html (convenience only).
- The admin dashboard only lists deals this browser has seen.
- Email OTP, receipts, live KES/USDT rates and payment confirmation need a real backend.
- The QR code library loads from cdnjs.cloudflare.com, so QR codes need internet.

DASHBOARD (left menu, blue and white theme)
- Dashboard: balance card with Withdraw, Create escrow and Join with a code buttons, quick stats, your deals.
- Deals: Create escrow, Join with a code, USDT kiosk.
- Account tools: My numbers (rooms, active, completed buyer/seller split, cancelled, completed value in
  KES and USDT, deal activity history), Wallet & payouts (balances, withdraw, withdrawal history,
  payout and refund details), Profile, and Admin (admin emails only).
- Discover: Market scan (indicative rates + converter), Scam watch (safety checklist).
- Help: Support. Also Dark mode and Log out at the bottom of the menu. On phones the menu opens from the Menu button.

BALANCE AND WITHDRAWALS
- When a deal is released, the seller's net amount is added to their balance (KES, or USDT if they chose
  USDT payout). A refund adds the amount to the buyer's balance.
- Withdraw sends a request to the saved payout details. It shows as Processing until an admin marks it
  Paid (Admin > Withdrawal requests) or Rejected (the money returns to the balance).
- This is a record-keeping demo. NO real money moves: sending M-Pesa or USDT payouts needs a real backend
  (M-Pesa B2C / Daraja and a crypto wallet service) and the balance must be kept on a server.

TO MAKE IT REAL (joins across devices, email reset, shared deals)
Use a hosted backend (Supabase, Firebase, or your own Node server). Ask and I will wire the site to one.
