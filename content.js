// GitHub PR - required approvals (Chrome extension content script).
// Adds a short "Required approvals" section under "Reviewers": who must approve,
// and which folders triggered it. Uses the GitHub session of the page, no token.

(function () {
  'use strict';

  const SECTION_ID = 'tm-required-approvals';
  // GitHub uses the first of these files that exists.
  const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  const BASE_RE = /"baseBranch":"((?:[^"\\]|\\.)+)"/;
  const HEAD_RE = /"headSha":"([0-9a-f]{40})"/;

  // ---------------------------------------------------------------------------
  // Pure logic (no DOM): parse CODEOWNERS, group the changed files, parse pages
  // ---------------------------------------------------------------------------

  // Convert a CODEOWNERS pattern (gitignore-like) to a RegExp tested on a file path.
  function patternToRegex(pattern) {
    const dirOnly = pattern.endsWith('/');
    const body = pattern.replace(/^\//, '').replace(/\/$/, '');
    const anchored = pattern.startsWith('/') || body.includes('/');
    // GitHub: "docs/*" matches the files of docs/, not the files of its subfolders.
    const directChildren = anchored && !dirOnly && /(^|\/)\*$/.test(body);

    let re = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '*' && body[i + 1] === '*') {
        // "**/" matches zero or more folders, a trailing "**" matches everything
        if (body[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else if (c === '*') {
        re += '[^/]*';
      } else if (c === '?') {
        re += '[^/]';
      } else {
        re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    const end = dirOnly ? '/' : directChildren ? '$' : '(?:/|$)';
    return new RegExp((anchored ? '^' : '(?:^|/)') + re + end);
  }

  function parseCodeowners(text) {
    const rules = [];
    // Split on "\r\n" too: "." does not match "\r", so a CRLF file would keep its comments.
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
      if (!line) continue;
      // A pattern without owner is kept: it removes the owners of the files it matches.
      const [pattern, ...owners] = line.split(/\s+/);
      rules.push({ pattern, owners, regex: patternToRegex(pattern) });
    }
    return rules;
  }

  // The last matching rule wins, like on GitHub.
  function findRule(rules, path) {
    for (let i = rules.length - 1; i >= 0; i--) {
      if (rules[i].regex.test(path)) return rules[i];
    }
    return null;
  }

  // Owner names are case-insensitive on GitHub.
  const ownerId = (owner) => owner.replace(/^@/, '').toLowerCase();
  const ownersKey = (owners) => owners.map(ownerId).sort().join(' ');

  // Short folder name for a file: the package folder when there is one, else the file itself.
  function folderOf(path) {
    const parts = path.split('/');
    if (parts.length > 2) return parts[1];
    return parts[parts.length - 1];
  }

  // One group per set of owners: one approval from these owners covers all its files.
  // Files without owner need no approval, so they are left out.
  function groupFiles(rules, files) {
    const groups = new Map();
    for (const file of files) {
      const rule = findRule(rules, file);
      if (!rule || rule.owners.length === 0) continue;
      const key = ownersKey(rule.owners);
      if (!groups.has(key)) {
        groups.set(key, { owners: rule.owners, patterns: new Set(), total: 0, folders: new Map() });
      }
      const group = groups.get(key);
      group.patterns.add(rule.pattern);
      group.total += 1;
      const folder = folderOf(file);
      group.folders.set(folder, (group.folders.get(folder) || 0) + 1);
    }
    return [...groups.values()]
      .map((g) => ({
        owners: g.owners,
        total: g.total,
        // "global": only the default rule (*), "folder": only folder rules, "mixed": both
        source: !g.patterns.has('*') ? 'folder' : g.patterns.size === 1 ? 'global' : 'mixed',
        folderRules: [...g.patterns].filter((p) => p !== '*'),
        folders: [...g.folders.entries()].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.total - a.total);
  }

  // Files whose owners differ between two CODEOWNERS versions (for example master and the
  // PR branch, when the PR edits CODEOWNERS), grouped by folder and by owner change.
  function compareOwners(baseRules, headRules, files) {
    const ownersOf = (rules, file) => {
      const rule = findRule(rules, file);
      return rule ? rule.owners : [];
    };
    const changes = new Map();
    for (const file of files) {
      const from = ownersOf(baseRules, file);
      const to = ownersOf(headRules, file);
      if (ownersKey(from) === ownersKey(to)) continue;
      const folder = folderOf(file);
      const key = `${folder}|${ownersKey(from)}|${ownersKey(to)}`;
      if (!changes.has(key)) changes.set(key, { folder, from, to, count: 0 });
      changes.get(key).count += 1;
    }
    return [...changes.values()].sort((a, b) => b.count - a.count);
  }

  // Incremental search for the end of a JSON array or object. Call it with the text
  // that starts with the value, again each time more text arrives. Returns the index
  // right after the value, -1 when more text is needed, or 0 when it is not an array
  // or object. Brackets inside strings are ignored.
  function jsonEndFinder() {
    let pos = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    return (text) => {
      if (pos === 0) {
        const start = text.trimStart()[0];
        if (start === undefined) return -1;
        if (start !== '[' && start !== '{') return 0;
      }
      for (; pos < text.length; pos++) {
        const c = text[pos];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') {
          inString = true;
        } else if (c === '[' || c === '{') {
          depth++;
        } else if ((c === ']' || c === '}') && --depth === 0) {
          return pos + 1;
        }
      }
      return -1;
    };
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };
  const decodeHtml = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, name) => ENTITIES[name]);
  const decodeJsonString = (text) => {
    try {
      return JSON.parse(`"${text}"`);
    } catch (e) {
      return text;
    }
  };

  // Classic "Files changed" page: the base branch is the first ".commit-ref" with a
  // title "owner/repo:branch" (the second one, ".head-ref", is the PR branch).
  function baseRefFromClassicHtml(html) {
    for (const [tag] of html.matchAll(/<span\b[^>]*\bcommit-ref\b[^>]*>/g)) {
      if (/\bhead-ref\b/.test(tag)) continue;
      const title = tag.match(/\btitle="[^":]*:([^"]+)"/);
      if (title) return decodeHtml(title[1]);
    }
    return null;
  }

  // The "Jump to file" list shortens long paths ("...rib/x.ts"). Rebuild them from the
  // full paths known elsewhere. Paths that stay shortened make the result approximate.
  function rebuildShortPaths(paths, known) {
    let approximate = false;
    const files = paths.map((path) => {
      if (!path.startsWith('...')) return path;
      const suffix = path.slice(3);
      const matches = known.filter((full) => full.endsWith(suffix));
      if (matches.length === 1) return matches[0];
      approximate = true;
      return path;
    });
    return { files, approximate };
  }

  // Expose the pure logic for tests when there is no DOM.
  if (typeof document === 'undefined') {
    globalThis.__requiredApprovalsTest = {
      patternToRegex,
      parseCodeowners,
      findRule,
      folderOf,
      groupFiles,
      compareOwners,
      jsonEndFinder,
      decodeHtml,
      baseRefFromClassicHtml,
      rebuildShortPaths,
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Data, read with your GitHub session (no token)
  // ---------------------------------------------------------------------------

  // Same-origin request to github.com: the browser sends your session cookies.
  async function getPage(url) {
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) throw new Error('GitHub error ' + res.status);
    return res.text();
  }

  // Raw files: github.com redirects to raw.githubusercontent.com with a one-time token.
  // Default credentials ("same-origin") send the session cookie to github.com only,
  // which keeps the cross-origin redirect valid for CORS.
  // Returns null when the file does not exist.
  async function getRaw(path) {
    const res = await fetch(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');
  const encodeRef = (ref) => ref.split('/').map(encodeURIComponent).join('/');

  // Data embedded in the current page as JSON (new view and conversation page).
  // Only read the <script> tags: serializing the whole page would cost much more.
  function findInPage(re) {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const m = script.textContent.match(re);
      if (m) return m[1];
    }
    return null;
  }

  // Base branch of the PR, read from the current page.
  function baseRefFromPage() {
    const embedded = findInPage(BASE_RE);
    if (embedded) return decodeJsonString(embedded);
    // Classic header: "owner/repo:branch". The timeline can also contain ".base-ref"
    // elements (an old base branch for example), so they are not used.
    const ref = document.querySelector('.commit-ref[title]:not(.head-ref)');
    const title = ref && ref.getAttribute('title');
    return title && title.includes(':') ? title.slice(title.indexOf(':') + 1).trim() : null;
  }

  // Read a page as a stream and stop as soon as the pattern matches.
  // PR pages weigh several MB: no need to download them in full.
  async function scanPage(url, re) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('GitHub error ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      // Search the new chunk plus the end of the previous one, for matches split between chunks.
      const text = tail + (done ? decoder.decode() : decoder.decode(value, { stream: true }));
      const m = text.match(re);
      if (m) {
        reader.cancel().catch(() => {});
        return m[1];
      }
      if (done) return null;
      tail = text.slice(-500);
    }
  }

  // New view: the "Files changed" page (/changes) embeds "diffSummaries", the full list
  // of changed files with their complete paths, computed from the merge base like GitHub.
  // The page weighs several MB: read it as a stream and stop right after that list.
  // The base branch and head commit are picked up on the way when they come first.
  async function readNewView(res) {
    const MARK = '"diffSummaries":';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const found = { baseRef: null, headSha: null };
    const findEnd = jsonEndFinder();
    let text = '';
    let started = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        text += done ? decoder.decode() : decoder.decode(value, { stream: true });

        if (!started) {
          if (!found.baseRef) found.baseRef = (text.match(BASE_RE) || [])[1] || null;
          if (!found.headSha) found.headSha = (text.match(HEAD_RE) || [])[1] || null;
          const i = text.indexOf(MARK);
          if (i < 0) {
            if (done) return null;
            text = text.slice(-500); // keep a tail for a marker split between chunks
            continue;
          }
          text = text.slice(i + MARK.length);
          started = true;
        }

        const end = findEnd(text);
        if (end === 0) return null; // not an array: unknown format
        if (end > 0) {
          const files = JSON.parse(text.slice(0, end)).map((entry) => entry.path).filter(Boolean);
          return {
            files,
            approximate: false,
            baseRef: found.baseRef && decodeJsonString(found.baseRef),
            headSha: found.headSha,
          };
        }
        if (done) return null;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  // Classic view: the "Jump to file" list (show_toc) uses the right commits, but it
  // shortens long paths. Rebuild them from the full paths of the "Files changed" page.
  async function readClassicView(html) {
    const toc = html.match(/\/[^"'\s]+\/show_toc\?[^"'\s]+/);
    if (!toc) return null;
    const tocUrl = decodeHtml(toc[0]);
    const known = [...new Set([...html.matchAll(/data-tagsearch-path="([^"]+)"/g)].map((m) => decodeHtml(m[1])))];
    const paths = [...parseHtml(await getPage(tocUrl)).querySelectorAll('a[href^="#diff-"] .description')]
      .map((n) => n.textContent.trim().split(' → ').pop()) // renamed file: keep the new path
      .filter(Boolean);
    return {
      ...rebuildShortPaths(paths, known),
      baseRef: baseRefFromClassicHtml(html),
      headSha: new URL(tocUrl, location.origin).searchParams.get('sha2'),
    };
  }

  // Changed files of the PR: { files, approximate, baseRef?, headSha? }.
  // Users of the classic view are redirected from /changes to /files: the response is
  // then already the classic page, so it is used as is.
  async function loadFiles(prPath) {
    const res = await fetch(prPath + '/changes');
    let found = null;
    if (res.ok && !new URL(res.url).pathname.endsWith('/changes')) {
      found = await readClassicView(await res.text());
    } else {
      if (res.ok) found = await readNewView(res).catch(() => null);
      else res.body?.cancel().catch(() => {});
      if (!found || !found.files.length) found = await readClassicView(await getPage(prPath + '/files'));
    }
    if (!found || !found.files.length) throw new Error("couldn't read the changed files");
    return found;
  }

  async function loadCodeowners(pr, ref) {
    for (const p of CODEOWNERS_PATHS) {
      const text = await getRaw(`/${pr.owner}/${pr.repo}/raw/${encodeRef(ref)}/${p}`);
      if (text !== null) return text;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Persistent cache (chrome.storage.local), shared by all tabs
  // ---------------------------------------------------------------------------

  const PR_FRESH_MS = 2 * 60 * 1000; // younger than this: no request at all
  const CODEOWNERS_FRESH_MS = 10 * 60 * 1000;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // older entries are dropped

  // Every access is guarded: after an extension reload, "chrome.storage" throws in
  // the content scripts still running in open tabs.
  async function cacheGet(key) {
    try {
      const item = (await chrome.storage.local.get(key))[key];
      return item && Date.now() - item.at < MAX_AGE_MS ? item : null;
    } catch (e) {
      return null;
    }
  }

  async function cacheSet(key, value) {
    try {
      await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
    } catch (e) {
      // ignore
    }
  }

  // Drop expired entries, so the storage stays small.
  async function pruneCache() {
    try {
      const all = await chrome.storage.local.get(null);
      const expired = Object.keys(all).filter((k) => !all[k] || !(Date.now() - all[k].at < MAX_AGE_MS));
      if (expired.length) await chrome.storage.local.remove(expired);
    } catch (e) {
      // ignore
    }
  }

  async function loadCodeownersCached(pr, baseRef) {
    const key = `codeowners:${pr.owner}/${pr.repo}@${baseRef}`;
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < CODEOWNERS_FRESH_MS) return cached.value;
    const text = await loadCodeowners(pr, baseRef);
    cacheSet(key, text);
    return text;
  }

  const domReady = () =>
    document.readyState !== 'loading'
      ? Promise.resolve()
      : new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));

  // The PR of the full page load. After a navigation inside GitHub, the page can still
  // hold the embedded data of the first PR: it is only trusted until the first
  // navigation to another page than this PR.
  const initialPrKey = (currentPr() || {}).key;
  let pageIsInitial = Boolean(initialPrKey);

  // Compute the required approvals of a PR as plain data (storable in the cache).
  async function loadResult(pr) {
    const prPath = `/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    const trustPage = () => pageIsInitial && pr.key === initialPrKey;
    // Start reading the changed files at once: it does not need the page DOM.
    const filesPromise = loadFiles(prPath);
    filesPromise.catch(() => {}); // handled below

    let baseRef = null;
    if (trustPage()) {
      await domReady();
      if (trustPage()) baseRef = baseRefFromPage();
    }
    if (!baseRef) baseRef = (await filesPromise).baseRef;
    if (!baseRef) baseRef = await scanPage(prPath + '?overview=true', BASE_RE).then((b) => b && decodeJsonString(b));
    if (!baseRef) throw new Error("couldn't read the base branch");

    const [files, codeowners] = await Promise.all([filesPromise, loadCodeownersCached(pr, baseRef)]);
    const changedFiles = [...new Set(files.files)];
    const baseRules = codeowners === null ? [] : parseCodeowners(codeowners);

    // GitHub applies the CODEOWNERS of the base branch. When the PR edits CODEOWNERS,
    // also show how the owners will change once it is merged.
    let ownerChanges = [];
    if (changedFiles.some((f) => CODEOWNERS_PATHS.includes(f))) {
      try {
        const headSha = files.headSha || (trustPage() && findInPage(HEAD_RE)) || (await scanPage(prPath + '?overview=true', HEAD_RE));
        const headCodeowners = headSha ? await loadCodeowners(pr, headSha) : null;
        if (headCodeowners !== null) ownerChanges = compareOwners(baseRules, parseCodeowners(headCodeowners), changedFiles);
      } catch (e) {
        // the note is optional
      }
    }

    return {
      baseRef,
      approximate: files.approximate,
      hasCodeowners: codeowners !== null,
      groups: groupFiles(baseRules, changedFiles),
      ownerChanges,
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // GitHub Primer variables, with light-mode fallbacks. They follow GitHub's dark mode.
  const C = {
    text: 'var(--fgColor-default,#1f2328)',
    muted: 'var(--fgColor-muted,#59636e)',
    border: 'var(--borderColor-default,#d1d9e0)',
    line: 'var(--borderColor-emphasis,#818b98)',
    andBg: 'var(--bgColor-neutral-emphasis,#59636e)',
    andFg: 'var(--fgColor-onEmphasis,#ffffff)',
    globalBg: 'var(--bgColor-attention-muted,#fff8c5)',
    globalFg: 'var(--fgColor-attention,#9a6700)',
    folderBg: 'var(--bgColor-accent-muted,#ddf4ff)',
    folderFg: 'var(--fgColor-accent,#0969da)',
    okBg: 'var(--bgColor-success-muted,#dafbe1)',
    okFg: 'var(--fgColor-success,#1a7f37)',
    okBorder: 'var(--borderColor-success-emphasis,#1f883d)',
    koBg: 'var(--bgColor-danger-muted,#ffebe9)',
    koFg: 'var(--fgColor-danger,#d1242f)',
  };

  // Small static icons (no user data inside, so innerHTML is safe here).
  const ICONS = {
    info:
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7.2" x2="8" y2="11.2"/><circle cx="8" cy="4.9" r="0.4" fill="currentColor"/></svg>',
    global:
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.8" ry="6.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>',
    folder:
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M1.5 3h4.2l1.5 1.6h7.3v8.4h-13z"/></svg>',
  };

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const pill = (text, style) =>
    el('span', `display:inline-block;font-size:11px;font-weight:600;line-height:18px;padding:0 7px;border-radius:9px;${style}`, text);

  const teamName = (owner) => owner.replace(/^@[^/]+\//, '').replace(/^@/, '').replace(/^pt-eng-/, '');

  // Badge that says where the requirement comes from: the global rule (*) or folder rules.
  function sourceBadge(group) {
    const isGlobal = group.source === 'global';
    const text = isGlobal
      ? 'Global rule *'
      : (group.folderRules.length > 1 ? 'Folder rules' : 'Folder rule') + (group.source === 'mixed' ? ' + global *' : '');
    const badge = el(
      'span',
      `display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 7px;border-radius:9px;` +
        `background:${isGlobal ? C.globalBg : C.folderBg};color:${isGlobal ? C.globalFg : C.folderFg};`
    );
    badge.innerHTML = isGlobal ? ICONS.global : ICONS.folder;
    badge.append(document.createTextNode(text));
    badge.title = isGlobal
      ? 'No CODEOWNERS rule matches these files, so the default owner (*) applies.'
      : 'CODEOWNERS rules: ' + group.folderRules.join(', ');
    return badge;
  }

  // `others`: number of other cards this owner is also in. One approval covers them all.
  function teamLine(owner, others) {
    const line = el('div', `font-weight:600;color:${C.text};word-break:break-word;`, teamName(owner));
    line.title = owner;
    if (others > 0) {
      const note = el('span', `font-weight:400;color:${C.muted};`, ` · also in ${others} other card${others > 1 ? 's' : ''}`);
      note.title = 'One approval from this owner counts for every card it is in.';
      line.append(note);
    }
    return line;
  }

  function statusChip(state) {
    const look = {
      approved: { text: '✓ Approved', bg: C.okBg, fg: C.okFg },
      changes: { text: '✕ Changes requested', bg: C.koBg, fg: C.koFg },
      pending: { text: '● Waiting', bg: C.globalBg, fg: C.globalFg },
    }[state.state];
    const chip = pill(look.text, `font-weight:600;background:${look.bg};color:${look.fg};`);
    if (state.by) chip.title = `${state.state === 'approved' ? 'Approved' : 'Changes requested'} by ${state.by}`;
    return chip;
  }

  // One card per required approval.
  function renderCard(group, state, cardsPerOwner) {
    const approved = state.state === 'approved';
    const card = el('div', `border:1px solid ${approved ? C.okBorder : C.border};border-radius:6px;padding:8px;`);
    const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;');
    top.append(sourceBadge(group), statusChip(state));
    card.append(top);

    const line = (owner) => teamLine(owner, cardsPerOwner.get(ownerId(owner)) - 1);
    const who = el('div', 'margin-top:6px;');
    if (group.owners.length === 1) {
      who.append(line(group.owners[0]));
    } else {
      // Several owners: any one of them is enough, shown in a dashed frame with OR.
      const frame = el('div', `border:1px dashed ${C.line};border-radius:6px;padding:4px 6px;`);
      frame.title = 'One approval from any of these owners is enough';
      group.owners.forEach((owner, i) => {
        if (i > 0) {
          const or = el('div', 'margin:2px 0;');
          or.append(pill('OR', `border:1px solid ${C.line};color:${C.muted};`));
          frame.append(or);
        }
        frame.append(line(owner));
      });
      who.append(frame);
    }
    card.append(who);

    // "Why": the top folders, the full list in the tooltip.
    const shown = group.folders.slice(0, 2).map(([f]) => f);
    const hidden = group.folders.length - shown.length;
    const why = el('div', `margin-top:4px;color:${C.muted};word-break:break-word;`, shown.join(', ') + (hidden > 0 ? ` +${hidden}` : ''));
    why.title = group.folders.map(([f, n]) => `${f}: ${n} file${n > 1 ? 's' : ''}`).join('\n');
    card.append(why);
    return card;
  }

  // Vertical link with an AND badge between two cards.
  function andLink() {
    const link = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 2px 14px;');
    link.append(el('div', `width:1px;height:16px;background:${C.line};`));
    link.append(pill('AND', `background:${C.andBg};color:${C.andFg};`));
    return link;
  }

  function message(text) {
    return el('div', `color:${C.muted};`, text);
  }

  function renderResult(result, status) {
    const box = el('div');
    const n = result.groups.length;
    const states = result.groups.map((g) => cardState(g, status));
    const done = states.filter((s) => s.state === 'approved').length;
    const cardsPerOwner = new Map();
    for (const group of result.groups) {
      for (const owner of group.owners) cardsPerOwner.set(ownerId(owner), (cardsPerOwner.get(ownerId(owner)) || 0) + 1);
    }

    let titleText = `Required approvals: ${done} of ${n} approved`;
    if (n === 0) titleText = result.hasCodeowners === false ? 'Required approvals: no CODEOWNERS file' : 'Required approvals: none';
    else if (done === n) titleText = `Required approvals: all ${n} approved`;
    const title = el('div', `font-weight:600;margin-bottom:8px;color:${n && done === n ? C.okFg : C.muted};`, titleText);
    title.title = `From CODEOWNERS on "${result.baseRef}". Every card needs an approval.`;
    box.append(title);

    result.groups.forEach((group, i) => {
      if (i > 0) box.append(andLink());
      box.append(renderCard(group, states[i], cardsPerOwner));
    });
    if (result.ownerChanges && result.ownerChanges.length) box.append(renderOwnerChanges(result.ownerChanges));
    if (result.approximate) {
      box.append(el('div', `margin-top:8px;font-style:italic;color:${C.muted};`, 'Approximate: some file paths could not be read in full.'));
    }
    return box;
  }

  // Note shown when the PR edits CODEOWNERS: which folders change owners after the merge.
  function renderOwnerChanges(changes) {
    const names = (owners) => (owners.length ? owners.map(teamName).join(' or ') : 'no owner');
    const box = el('div', `margin-top:12px;padding:8px;border-radius:6px;background:${C.folderBg};color:${C.text};`);
    const head = el('div', `display:flex;align-items:center;gap:4px;font-weight:600;color:${C.folderFg};`);
    head.innerHTML = ICONS.info;
    head.append(document.createTextNode('This PR edits CODEOWNERS'));
    box.append(head);
    box.append(el('div', `margin:2px 0 4px;color:${C.muted};`, 'After the merge, these folders change owners:'));

    const shown = changes.slice(0, 3);
    for (const change of shown) {
      const line = el('div', 'word-break:break-word;margin-top:2px;');
      line.append(el('span', 'font-weight:600;', change.folder));
      line.append(el('span', `color:${C.muted};`, ` ${names(change.from)} → `));
      line.append(el('span', 'font-weight:600;', names(change.to)));
      line.title = `${change.count} file(s)\nBefore: ${change.from.join(', ') || 'no owner'}\nAfter: ${change.to.join(', ') || 'no owner'}`;
      box.append(line);
    }
    if (changes.length > shown.length) {
      const more = el('div', `margin-top:2px;color:${C.muted};`, `+${changes.length - shown.length} more`);
      more.title = changes
        .slice(shown.length)
        .map((c) => `${c.folder}: ${names(c.from)} → ${names(c.to)}`)
        .join('\n');
      box.append(more);
    }
    return box;
  }

  function renderSection() {
    const section = el('div', 'padding:16px 0;margin-top:8px;border-top:1px solid var(--borderColor-muted,#d8dee4);font-size:12px;line-height:1.5;');
    section.id = SECTION_ID;
    return section;
  }

  // Spinner shown while the data loads.
  function loader() {
    const box = el('div', `display:flex;align-items:center;gap:8px;color:${C.muted};`);
    const spinner = el('span', `flex:none;width:12px;height:12px;box-sizing:border-box;border:2px solid ${C.border};border-top-color:${C.muted};border-radius:50%;`);
    spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity });
    box.append(spinner, document.createTextNode('Loading required approvals…'));
    return box;
  }

  // ---------------------------------------------------------------------------
  // Placement: works on the classic view and the new React view
  // ---------------------------------------------------------------------------

  // Find the "Reviewers" sidebar block from its title, not from hashed class names.
  // New view:     section > h4 > button > span "Reviewers"
  // Classic view: div.discussion-sidebar-item > form > h3 "Reviewers"
  // XPath only visits text nodes, natively: much cheaper than reading the text of
  // every element on a page with a big diff.
  const REVIEWERS_XPATH = "//text()[normalize-space(.)='Reviewers']";
  function findReviewersBlock() {
    const found = document.evaluate(REVIEWERS_XPATH, document.body || document.documentElement, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < found.snapshotLength; i++) {
      // The title: the closest element of these tags whose whole text is "Reviewers".
      let title = found.snapshotItem(i).parentElement;
      while (title && !title.matches('h2, h3, h4, span, button, summary') && title.textContent.trim() === 'Reviewers') {
        title = title.parentElement;
      }
      if (!title || title.textContent.trim() !== 'Reviewers' || title.closest('#' + SECTION_ID)) continue;
      const block = title.closest('.discussion-sidebar-item, section');
      if (block) return block;
    }
    return null;
  }

  // Review state of each requested team or user, read from the Reviewers block.
  // New view: "org/team: pending" (hidden text), and a "Members of org/team" list
  // with "<user> approved these changes". Classic view: "... on behalf of org/team".
  // Returns Map: lower-case "org/team" or "user" -> { state, by }.
  const STATE_RANK = { approved: 3, changes: 2, pending: 1 };
  function readReviewStatus(block) {
    const status = new Map();
    if (!block) return status;
    const stateOf = (text) =>
      /approved/i.test(text) ? 'approved' : /changes/i.test(text) ? 'changes' : /pending|awaiting|requested/i.test(text) ? 'pending' : null;
    const set = (who, state, by) => {
      const key = who.toLowerCase();
      if (!status.has(key) || STATE_RANK[state] > STATE_RANK[status.get(key).state]) status.set(key, { state, by });
    };
    const texts = [...block.querySelectorAll('*')]
      .flatMap((n) => [n.childElementCount ? null : n.textContent, n.getAttribute('aria-label')])
      .filter(Boolean)
      .map((t) => t.trim());

    for (const text of texts) {
      let m = text.match(/^([\w.-]+\/[\w.-]+): (.+)$/); // "org/team: pending"
      if (m && stateOf(m[2])) set(m[1], stateOf(m[2]));
      m = text.match(/^(\S+) (approved these changes|requested changes)(?: on behalf of ([\w.-]+\/[\w.-]+))?/);
      if (m) {
        const state = stateOf(m[2]);
        set(m[1], state, m[1]); // the user themselves
        if (m[3]) set(m[3], state, m[1]); // classic view: team approval
      }
    }
    // New view: a team approval shows as a member approval inside "Members of org/team".
    for (const list of block.querySelectorAll('[aria-label^="Members of "]')) {
      const team = list.getAttribute('aria-label').slice('Members of '.length).trim();
      for (const n of list.querySelectorAll('*')) {
        if (n.childElementCount) continue;
        const m = n.textContent.trim().match(/^(\S+) (approved these changes|requested changes)/);
        if (m) set(team, stateOf(m[2]), m[1]);
      }
    }
    return status;
  }

  // State of one card: approved if any of its owners approved, else changes requested, else pending.
  function cardState(group, status) {
    const states = group.owners.map((o) => status.get(ownerId(o)) || { state: 'pending' });
    return states.find((s) => s.state === 'approved') || states.find((s) => s.state === 'changes') || { state: 'pending' };
  }

  function currentPr() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], number: m[3], key: `${m[1]}/${m[2]}#${m[3]}` } : null;
  }

  // ---------------------------------------------------------------------------
  // State and refresh
  // ---------------------------------------------------------------------------

  // PR key -> { result: data (null while loading), error, version, loading }
  const entries = new Map();

  function getEntry(pr) {
    if (!entries.has(pr.key)) entries.set(pr.key, { result: null, error: null, version: 0, loading: false });
    return entries.get(pr.key);
  }

  function update(entry, change) {
    Object.assign(entry, change);
    entry.version += 1;
    schedule(); // let ensureSection() show the new content
  }

  // Show the cached result at once when there is one, and refresh it in the background
  // when it is old enough. Called on each visit of a PR, including navigations inside
  // GitHub. The display changes only if the result changed.
  async function refresh(pr) {
    const entry = getEntry(pr);
    if (entry.loading) return;
    entry.loading = true;
    const cacheKey = `pr:${pr.key}`;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    try {
      const cached = await cacheGet(cacheKey);
      if (cached && !same(cached.value, entry.result)) update(entry, { result: cached.value });
      if (cached && Date.now() - cached.at < PR_FRESH_MS) return;
      const result = await loadResult(pr);
      cacheSet(cacheKey, result);
      if (!same(result, entry.result)) update(entry, { result, error: null });
    } catch (e) {
      if (!entry.result) update(entry, { error: 'Required approvals: ' + e.message });
    } finally {
      entry.loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Page wiring
  // ---------------------------------------------------------------------------

  // Short signature of the review states, to redraw only when they change.
  const statusKey = (status) => JSON.stringify([...status.entries()].sort());

  function fill(section, entry, status) {
    section.replaceChildren(entry.result ? renderResult(entry.result, status) : entry.error ? message(entry.error) : loader());
    section.dataset.version = String(entry.version);
    section.dataset.status = statusKey(status);
  }

  let visitedPrKey = null;
  let prunedCache = false;
  // When the Reviewers block is not on the page (other tabs of the PR), the search
  // runs at most every SEARCH_INTERVAL_MS instead of on every DOM change.
  const SEARCH_INTERVAL_MS = 250;
  let nextSearchAt = 0;
  let retryTimer = null;

  function ensureSection() {
    const pr = currentPr();
    let section = document.getElementById(SECTION_ID);
    if (!pr || pr.key !== initialPrKey) pageIsInitial = false;
    if (section && (!pr || section.dataset.pr !== pr.key)) {
      section.remove(); // left from another PR
      section = null;
    }
    if (!pr) {
      visitedPrKey = null;
      return;
    }

    // Start loading the data right away, even before the sidebar exists.
    if (pr.key !== visitedPrKey) {
      visitedPrKey = pr.key;
      refresh(pr);
      if (!prunedCache) {
        prunedCache = true;
        pruneCache();
      }
    }
    const entry = getEntry(pr);

    if (section && section.previousElementSibling) {
      // The Reviewers block sits right before the section: read the review states there.
      const status = readReviewStatus(section.previousElementSibling);
      if (section.dataset.version !== String(entry.version) || section.dataset.status !== statusKey(status)) {
        fill(section, entry, status);
      }
      return;
    }

    const now = performance.now();
    if (now < nextSearchAt) {
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          schedule();
        }, nextSearchAt - now);
      }
      return;
    }
    const block = findReviewersBlock();
    if (!block) {
      nextSearchAt = now + SEARCH_INTERVAL_MS;
      return;
    }
    nextSearchAt = 0;

    // Show the section at once: with the result if ready, with a loader otherwise.
    if (section) section.remove();
    section = renderSection();
    section.dataset.pr = pr.key;
    block.after(section);
    fill(section, entry, readReviewStatus(block));
  }

  // Both views render and navigate without full page loads, and the new view
  // re-renders the sidebar often. Re-check after DOM changes, once per frame.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureSection();
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  ensureSection();
})();
