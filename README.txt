Xwadda Escrow - GitHub Pages site (2 files: index.html + README.txt)

UPLOAD
1. Put index.html and README.txt in the root of your GitHub repo.
2. Settings > Pages > Deploy from branch > main / (root). Your site goes live on https.

SIGN-IN
- Create account and sign in with email + password (12+ chars, upper, lower, number, symbol).
- Passwords are hashed in the browser (PBKDF2, 210,000 rounds, random salt), never stored as plain text.
- Accounts and the signed-in session are saved in the visitor's own browser (localStorage).
  They survive refresh, but only on that same browser and device.

IMPORTANT LIMITS (GitHub Pages is static, it has no server)
- An account made on one phone will not exist on another phone or for you as the owner.
- Deals, chat rooms and the admin dashboard only see data in the current browser.
- Anyone can open dev tools and edit browser data, so this is NOT secure enough to hold real money
  or to protect the admin dashboard. Admin emails go in the ADMIN_EMAILS list inside index.html,
  but that is only a convenience here, not real protection.
- Email OTP, receipts, live KES/USDT rates and payment confirmation need a real backend.
- The QR code library loads from cdnjs.cloudflare.com, so QR codes need internet.

TO MAKE IT REAL
Use a hosted backend (Supabase, Firebase Auth, or your own Node server) for shared accounts,
email OTP and deals. Ask and I will wire the site to one.
