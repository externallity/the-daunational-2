# THE DAUNATIONAL 2

Initial frontend scaffold for the friends-only Dota 2 tournament.

## Current status
- Responsive lobby, nickname entry, demo organizer controls, manual test-player creation, leaderboard and match-history placeholders.
- Data currently lives in this browser only (localStorage); it is not shared between players/devices.
- Admin detection by nickname containing `admin` is demo-only and is not secure authorization.
- Match start currently previews random captains; snake draft, hero draft, match results/MVP and the full 15-match flow remain to be implemented.

## Deployment
Connect this repository's `main` branch to Cloudflare Pages. No build command is required; use `/` as the output directory.

## Next step
Configure Supabase and server-side authorization for shared tournament state before using this with the full group.
