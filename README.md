# Tbilisi Trans

Live buses, routes, stops, and schedules for Tbilisi.

**[Open Tbilisi Trans](https://tbilisi-trans.samshabrg.org)**

[![Download on the App Store](https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83)](https://apps.apple.com/ge/app/tbilisi-trans/id6758897204)

**[Privacy Policy](https://tbilisi-trans.samshabrg.org/privacy-policy)**

Built by Sasha Berg for Tbilisi commuters. **[Instagram](https://www.instagram.com/samshabrg)**

## Service changes

Open **Service changes** at the top of Settings, or visit `/data-history/`. The page follows the app’s appearance setting. Updates are grouped by observation day and combine changes in English and Georgian.

Route plaques expand details for added, cancelled, changed, renamed, and schedule-only routes. Maps show saved route paths, green additions, red removals, and moved stops with black markers at their former positions. Metro lines use the app’s schematic geometry. Schedule comparisons show complete departure timetables from each direction’s starting stop, with added and removed departures highlighted. Technical source values remain available in collapsed sections.

Run `npm run data:history` to generate history from dated archives and current city data. `npm run data:update` and its city-specific variants generate history before and after each refresh, including with `--skip-archive`. The page checks for new history every minute and when you return to the tab. It does not download new city data itself.

Comparisons ignore whitespace-only name edits, embedded stop renames in route details, calendar rollovers with unchanged timetables, and matched pattern-code replacements. Real changes to stop order, geometry, service days, and departure times remain visible. Dates describe when changes were observed, not when they took effect. Missing source files are excluded from comparisons.

Generated reports and route-map assets live in `public/data-history`. Keep them in version control so history survives deployment. The local comparison snapshot lives in `data-archive/history-state`. Keep that directory for incremental comparisons. Without it, the generator uses available dated archives and preserves existing reports. No upstream requests are made by `data:history`.

To run the local preview, build with `VITE_BASE_URL=/ VITE_OUT_DIR=/tmp/ttc-history-map-preview npm run build`, then run `npm run preview:history`. The preview serves current JSON from `public` without rebuilding the app. Source changes still require a new build.

Run `npm run test:data-history` to verify comparisons, identity matching, map features, and schedule differences.

### Daily server refresh

Route prefetching uses three workers by default. Set `TRANSIT_PREFETCH_CONCURRENCY` to an integer from 1 to 8 to change the limit. Requests within each route remain sequential. Aggregate record keys are sorted so completion order does not create artificial data changes. Run `npm run test:prefetch-concurrency` to check worker limits and error handling.

On `veave-server.local`, `com.veave.transit-data-refresh` runs daily at 06:00 in the Mac’s Asia/Tbilisi timezone. Its template is `scripts/launchd/com.veave.transit-data-refresh.plist.in`. The installed updater lives on the internal disk at `~/.local/share/ttc-updater`, including its verified Node runtime, isolated Git checkouts, persistent data archives, and logs. Its dedicated SSH deploy key has write access to this repository. Private keys are never committed.

`scripts/daily-data-refresh.py` takes an exclusive lock, fetches `origin/main`, creates an isolated checkout, refreshes all cities, and checks data completeness and history tests. Scheduled refreshes enable `TRANSIT_PREFETCH_STRICT=1`. If a listed route’s upstream requests fail, its entire previous snapshot is carried forward, including details that were already unavailable and identified in the log. A failure for a route without any previous snapshot prevents publication. Unexpectedly empty or truncated datasets also fail validation. Successful changes are committed only from `public/data`, `public/data-history`, `ota/files`, and `ota/manifest.json`, then pushed to `main`. GitHub Pages deploys through the existing workflow. A rejected push preserves the checkout for inspection and never overwrites concurrent commits.

Logs are in `~/.local/share/ttc-updater/logs/refresh.log`; `last-success.json` records the last completed run. Run `/usr/local/bin/python3.13 ~/.local/share/ttc-updater/repo/scripts/daily-data-refresh.py --check` on that Mac to verify runtime and GitHub access without refreshing data. To start a refresh immediately, run `launchctl kickstart gui/$(id -u)/com.veave.transit-data-refresh`. To disable the schedule, run `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.veave.transit-data-refresh.plist`.
