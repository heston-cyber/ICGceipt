# ICGceipt

ICG's receipt app: snap a receipt on your phone, check what the AI read, tag the shoot/client and category, send it. It's emailed to the recipients you choose, written to the ICG Sheet and kept in the app's history.

- **Live:** https://icgceipts.hillsbuilds.com (iPhone: Safari › Share › Add to Home Screen)
- **Stack:** React + Vite (GitHub Pages) · Convex (database, files, server functions, sign-in) · Resend (email) · Claude API (receipt reading) · Google Apps Script (ICG Sheet)
- **Sign-in:** emailed 6-digit code (one-tap link in the same email for Safari). Only invited crew and the `ADMIN_EMAILS` admins can get a code.
- **Sending:** from the verified `receipts@hillsbuilds.com`, in the sender's name ("Pat Lee via ICGceipt"). Replies go to the sender, who is CC'd.

## Setup (once)

Keys never go in the repo or chat. Paste them into the dashboards.

1. **GitHub** (`heston-cyber/ICGceipt`):
   - Settings › Pages › Source: **GitHub Actions**; custom domain `icgceipts.hillsbuilds.com`.
   - Settings › Secrets › Actions: `CONVEX_DEPLOY_KEY`.
   - Variable (optional): `TYPEKIT_ID`, an Adobe Fonts web project with Degular.
2. **Convex:** new project `icgceipt` (Hill's Builds team) › Production › Settings › Deploy key → GitHub secret above. Environment variables:
   - `RESEND_API_KEY`
   - `ANTHROPIC_API_KEY` (Phase 3)
   - `ICG_SHEET_URL` and `ICG_SHEET_SECRET` (Phase 4)
3. **Run the "Convex setup" workflow once:** `ADMIN_EMAILS=<your email>;SITE_URL=https://icgceipts.hillsbuilds.com;EMAIL_FROM=ICGceipt <receipts@hillsbuilds.com>`
4. **Resend:** verify `hillsbuilds.com` (DNS records at GoDaddy).
5. **GoDaddy DNS:** `CNAME icgceipts → heston-cyber.github.io`.

## Commands

- `npm ci` — install
- `npx vitest run` — tests
- `npx tsc --noEmit -p convex` — backend type check
- `npm run build` — site build
- `npm run gen` — refresh `convex/_generated/api.d.ts` offline after adding a backend file. `npx convex deploy` regenerates the real files.

Push to `main` → tests → backend deploy → site deploy.
