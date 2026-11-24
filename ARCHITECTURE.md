# Architecture

This document explains how the extension works, why it is built this way, and what is
still unverified. Read it before changing `content.js`.

## Purpose

On a GitHub pull request, the "Reviewers" block lists the requested teams, but it does not
say which approvals are required together (AND) and which are alternatives (OR), nor which
files triggered each team.

The extension adds a "Required approvals" section right under the "Reviewers" block:

- one card per required approval (AND between cards)
- several owners in one card when any of them is enough (OR, in a dashed frame)
- a badge with the source of the rule: "Global rule *" (default owner) or "Folder rule(s)"
- the folders that triggered the card (top 2, full list with file counts in a tooltip)
- a live state per card: "Approved", "Changes requested" or "Waiting"
- "also in N other cards" next to an owner present in several cards (one approval covers them all)
- a note when the pull request edits CODEOWNERS: which folders change owners after the merge

Target: `shinetools/shine` (monorepo, teams like `@shinetools/pt-eng-<team>`),
but nothing is specific to that repository except the `pt-eng-` prefix hidden by `teamName`.

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3. One content script on `https://github.com/*`, `run_at: document_start`. Only permission: `storage`. |
| `content.js` | All the logic, in one IIFE. No build step, no dependency. |
| `README.md` | User documentation (install, behavior, dev commands). |
| `tests/logic.test.js` | Unit tests of the pure logic (plain Node). |
| `tests/e2e.test.mjs` | End-to-end test: the real extension in Chromium, github.com simulated. |
| `package.json` | Dev scripts (`test`, `test:e2e`, `zip`) and the dev dependency `playwright-core`. |
| `github-required-approvals-extension.zip` | `manifest.json`, `content.js`, `README.md`, for distribution. Rebuild it after any change. |

The content script must stay on `https://github.com/*`, not only on pull request URLs:
GitHub navigates without full page loads, so a script limited to `/pull/` URLs would not
run when the user opens a PR from a list.

There is no background script: every request is a same-origin `fetch` from the content
script, with the user's GitHub session. No token, no external host.

## Code layout (`content.js`, top to bottom)

1. **Pure logic** (no DOM, tested in Node)
   - `patternToRegex`, `parseCodeowners`, `findRule`: CODEOWNERS parsing. The last matching
     rule wins, like on GitHub. Patterns follow gitignore rules (`*`, `**`, anchored when the
     pattern contains a `/`, `dir/` matches folders only), with one GitHub difference:
     `docs/*` matches the files of `docs/` but not the files of its subfolders.
     A pattern without owner is kept: it removes the owners of its files.
   - `ownerId`, `ownersKey`: owners compared in lower case, without `@`, order ignored.
   - `folderOf`: short folder name for display (`libraries/x/...` gives `x`; a root file gives its name).
   - `groupFiles`: groups changed files by owner set. One group is one required approval.
     Files without owner are left out. Each group has `source`: `global` (only `*`),
     `folder`, or `mixed`.
   - `compareOwners`: owner changes per file between two CODEOWNERS versions.
   - Page parsing helpers: `jsonEndFinder` (end of a JSON array in a stream),
     `baseRefFromClassicHtml`, `rebuildShortPaths`, `decodeHtml`.
   - When `document` is undefined, these functions are exposed on
     `globalThis.__requiredApprovalsTest` and the script stops (Node tests).
2. **Data loading** (`getPage`, `getRaw`, `findInPage`, `baseRefFromPage`, `scanPage`,
   `readNewView`, `readClassicView`, `loadFiles`, `loadCodeowners`)
3. **Persistent cache** (`cacheGet`, `cacheSet`, `pruneCache`, `loadCodeownersCached`)
4. **`loadResult(pr)`**: computes the result as plain JSON (cacheable).
5. **Rendering** (`renderResult`, `renderCard`, `statusChip`, `renderOwnerChanges`, `loader`).
   Colors use GitHub Primer CSS variables with light-mode fallbacks, so dark mode works.
   Icons are small static SVG strings (the only `innerHTML` use; user data always goes
   through `textContent`).
6. **Placement and live status** (`findReviewersBlock`, `readReviewStatus`, `cardState`).
7. **State and refresh** (`getEntry`, `refresh`) and **page wiring** (`fill`,
   `ensureSection`, a `MutationObserver` throttled to one check per animation frame).

## Data flow

```
document_start
  └─ ensureSection() ── new PR key? → refresh(pr) ──┬─ cache hit → show at once
                                                    └─ loadResult(pr) (no cache, or older than 2 min)
                                                         ├─ loadFiles(prPath)          starts at once, no DOM needed;
                                                         │                             also returns baseRef / headSha when seen
                                                         ├─ base branch: current page (first page only),
                                                         │               else loadFiles, else ?overview=true
                                                         ├─ loadCodeownersCached(base) (10 min cache)
                                                         ├─ groupFiles
                                                         └─ if a CODEOWNERS file changed:
                                                              head commit → loadCodeowners(head) → compareOwners
MutationObserver (once per frame) → ensureSection()
  ├─ removes a section left from another PR
  ├─ finds the "Reviewers" block, inserts the section right after it
  ├─ shows a loader until the result arrives
  └─ re-renders when the result version or the review states change
```

`refresh` runs on each visit of a PR, including navigations inside GitHub, so coming back
to a PR after more than 2 minutes reloads it in the background. It does not run again
while the user stays on the same PR.

### Where the data comes from (and why)

All of this was found by trial and error. Each choice below fixes a real bug.

**Changed files** (`loadFiles`)

1. **New view** (`/pull/N/changes`, the default for the author's account): the HTML embeds a
   JSON array `"diffSummaries":[{ "path": ..., "changeType": ..., ... }]` with **all**
   changed files and **full** paths, computed from the merge base like GitHub. It starts
   around 100 KB into a page of several MB (2.6 MB for a 270-file PR).
   `readNewView` reads the response as a stream, finds the marker, finds the end of the
   array with `jsonEndFinder`, parses it, and cancels the download (about 140 KB read).
   On the way, it picks up `"baseBranch"` and `"headSha"` if they come before the list.
2. **Classic view**: users of the classic view are redirected from `/changes` to `/files`.
   That response is already the classic "Files changed" page, so it is used as is (no
   second download). If `/changes` fails, `/files` is fetched. The page contains:
   - a link to `/pull/N/show_toc?base_sha=..&sha1=..&sha2=..` (the "Jump to file" menu),
     with the right commits. `show_toc` returns a light HTML list
     (`a[href^="#diff-"] .description`), **but it shortens long paths** (`...rib/layout/x.ts`).
     Shortened paths are rebuilt by suffix from the `data-tagsearch-path` attributes of the
     `/files` page. If a path stays shortened, the result is flagged `approximate`.
   - the base branch: first `span.commit-ref` with `title="owner/repo:branch"` that is
     not `.head-ref` (checked on a public PR, signed out).
   - the head commit: `sha2` of the `show_toc` link.

Dead ends, do not retry:

- `/pull/N.diff` and the REST diff: refused above 20,000 lines (the reference PR has 25,000).
- `show_toc?sha1=<baseSha>&sha2=<headSha>` with `baseSha` from the page data: `baseSha` is
  the tip of the base branch at the last PR update, not the merge base. When the PR is
  behind the base branch, the list includes unrelated files (bug seen: 8 approvals instead
  of 3). Always use the merge base (`diffSummaries`, or the `show_toc` link of `/files`).
- `oldCommitOid` in the `/changes` data is the merge base, but `diffSummaries` makes it
  unnecessary.

**Base branch and head commit**

- The current page is only trusted for the PR of the full page load, and only until the
  first navigation to another page. After a navigation inside GitHub, the page can still
  hold the embedded JSON of the first PR (bug: a PR targeting `release` was checked
  against the CODEOWNERS of `main`). The end-to-end test covers this case.
- On the page, `"baseBranch":"..."` and `"headSha":"..."` are read from the
  `<script type="application/json">` tags (React embedded data, also present on the
  conversation page). Do not search `document.documentElement.innerHTML`: it serializes
  the whole page, several MB on a big PR.
- Do not use `.base-ref` to find the base branch: the timeline also uses that class
  ("merged commit into trunk", and possibly an old base branch).
- Fallback: stream `?overview=true` until the pattern matches.

**CODEOWNERS**

- GitHub applies the CODEOWNERS of the **base branch**, not the one of the PR branch.
  A rule added by the PR itself does not count until it is merged.
- Read with `fetch('/<owner>/<repo>/raw/<ref>/<path>')`, default credentials. github.com
  redirects to `raw.githubusercontent.com` with a one-time token; the default
  `same-origin` credentials keep CORS valid. Do not use `credentials: 'include'` here
  (it fails on the cross-origin redirect).
- Locations tried in order: `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`. Only a 404
  moves to the next location; another error stops the load (so a network error is not
  shown as "no CODEOWNERS file").
- The ref is encoded segment by segment (`release/1.0` stays a path, `#` is encoded).
- Lines are split on `\r?\n`: with `\n` only, a CRLF file kept its trailing comments as owners.

### Cache (`chrome.storage.local`, shared by all tabs)

| Key | Value | Fresh for |
|---|---|---|
| `pr:<owner>/<repo>#<n>` | result of `loadResult` | 2 min (no request at all); older: shown at once, then refreshed in the background |
| `codeowners:<owner>/<repo>@<ref>` | CODEOWNERS text | 10 min |

Entries older than 24 h are deleted once per tab, on the first PR visited. The review
state is **never** cached: it is read from the page at each render. Every storage access is
guarded: after an extension reload, `chrome.storage` throws in the tabs still open.

## Placement on the page

`findReviewersBlock` looks for a text node whose normalized text is `Reviewers` (an XPath
query, run natively), climbs to the closest `h2, h3, h4, span, button, summary` whose whole
text is `Reviewers`, then takes the closest block:

- new view: `section > h4 > button > span "Reviewers"` → the `section`
- classic view: `div.discussion-sidebar-item > form > h3 "Reviewers"` → the `div`

Do not rely on class names of the new view: they are hashed (`sectionTitle__QwlXiE`).

Both views navigate without full page loads and the new view re-renders the sidebar
often, so a `MutationObserver` on `document.documentElement` calls `ensureSection` once per
animation frame. `ensureSection` has a fast path (section already in place) that only
compares the result version and the review states. When the Reviewers block is not on the
page (for example on "Files changed", where the diff changes the DOM all the time), the
search runs at most every 250 ms, with a timer for the last change.

## Live review state (`readReviewStatus`)

Read from the Reviewers block (the element right before the section). Observed in the new
view, signed in:

- pending team: hidden text `shinetools/<team>: pending`
- team approved by a member: `ul[aria-label="Members of shinetools/<team>"]` containing
  `<user> approved these changes`
- user review: `<user> approved these changes`, `<user> left review comments`
- code owner team: an `octicon-shield` icon and the text `... is a code owner`

A card is "Approved" if any of its owners approved, else "Changes requested" if any
requested changes, else "Waiting".

## Testing

```sh
npm test            # tests/logic.test.js, plain Node
npm install         # once: playwright-core
npm run test:e2e    # tests/e2e.test.mjs
```

### Pure logic (`tests/logic.test.js`)

Loads `content.js` in a `vm` context without `document` and tests the exposed functions:
CODEOWNERS patterns (including the GitHub examples), last rule wins, rules without owner,
CRLF files, grouping, owner changes, JSON array end in a stream, classic page parsing.

The extension was checked by hand on a real PR of the target repository (270 files).
Its data is private, so it is not in the tests, and team and folder names are replaced
here. The expected result is 3 cards:

1. Global rule `*`: the default team (153 files of a new library, `.github/CODEOWNERS`,
   `tsconfig.json`)
2. Folder rules: one team, for 5 folders
3. Folder rule: two teams, OR, for one folder

The PR adds the new library to CODEOWNERS, so the note must say that this folder moves
from the default team to another team (153 files).

### End to end (`tests/e2e.test.mjs`)

The real extension in Chromium, with `context.route('https://github.com/**')` serving
fixtures. It checks: placement after Reviewers, card text, OR, "also in", the CODEOWNERS
note, the exact requests of a first visit, a live approval injected into the Reviewers
block, a navigation inside GitHub to a PR with another base branch, a revisit served by
the cache with no request, and the classic view. It also fails on any page error.

Notes:

- Extensions only load in a persistent context, with
  `args: ['--disable-extensions-except=<dir>', '--load-extension=<dir>']` and
  `channel: 'chromium'` (or a full Chromium build in `CHROMIUM_PATH`). Without that, the
  content script silently does not run.
- Playwright does not route the request that follows a fulfilled redirect (it goes to the
  real github.com). So the `/changes` → `/files` redirect of the classic view is not
  simulated; the test uses a 404 on `/changes`, which takes the `/files` fallback.

### Diagnostics on the real page

GitHub's signed-in DOM differs from the signed-out one, and an agent usually cannot sign
in. The approach that worked: give the user a short console snippet that collects the
structure (texts, `aria-label`, `data-testid`, octicon classes, matching JSON keys), copies
it with `copy(...)`, and ask them to paste the result. Signed-out pages of a public PR
(`curl -L https://github.com/cli/cli/pull/9000/changes`) are useful for the classic view.

## Unverified assumptions

- "Changes requested" text in the new view (assumed to contain `requested changes`).
- Team approvals in the **classic** view (assumed `... on behalf of org/team`).
- `"baseBranch"` / `"headSha"` before `diffSummaries` in the `/changes` page. Not required:
  without them, the base comes from the current page or `?overview=true`.
- `diffSummaries` completeness for very large PRs (seen complete at 270 files; GitHub may
  page it above some size).
- Reading CODEOWNERS of a **private** repo through the `raw` redirect from an extension
  content script (works for public repos; not confirmed yet on a private repo). If it
  fails, the section shows an error: move this request to a background service worker
  with `host_permissions` for `github.com` and `raw.githubusercontent.com`.
- `/*` (root files only) follows the GitHub rule for `docs/*`; GitHub's docs do not show
  this exact case.

## Known limits

- Teams are shown without the `pt-eng-` prefix (`teamName`); full names are in tooltips.
- `folderOf` is tuned for a monorepo (`<kind>/<package>/...`). In other layouts it shows
  the second path segment.
- The result is not refreshed while the user stays on the same PR (new pushes show after
  a navigation or a reload).
- Users must load the extension unpacked; private Chrome Web Store publishing would give
  automatic updates.

## Conventions

- Code, comments and docs in English. Short, plain sentences.
- No runtime dependency and no build step. `playwright-core` is a dev dependency for tests only.
- After any change: run both tests, bump `version` in `manifest.json`, update `README.md`
  if behavior changes, rebuild the zip (`npm run zip`).
