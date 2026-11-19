# ICGceipt — rules for build sessions

ICG-only receipt app (Heston's day job, Insight Creative Group). **Not Wrangler work:** never share code, data, keys, domains or Convex teams with Wrangler Portal.

- Plan and reports: Heston's vault `AiOS/Builds/ICGceipt/` and the claude.ai Builds project (`claude/icgceipt-*.md`).
- Phases: 2 foundation · 3 snap + AI read · 4 tag + send (email on behalf, ICG Sheet via Apps Script) · 5 history + admin · 6 polish/offline · 7 master test + report + skill. Each phase is tested before the next.
- **Report ambiguity, don't assume.** Heston approves direction; instructions in chat override files.
- **Keys and secrets never go in chat, code or workflow inputs.** The repo is public. Heston pastes them into Convex/GitHub dashboards.
- **No email to real ICG people** without Heston's OK. Use `EMAIL_ONLY_TO` on test deployments.
- Look: ICG brand. Cream `#FFFDE9`, ink `#201F1F`, red `#EF2600`, Degular (Adobe kit via `TYPEKIT_ID`).
- Before committing: `npx vitest run`, `npx tsc --noEmit -p convex`, `npm run build`. After adding a backend file: `npm run gen`.
