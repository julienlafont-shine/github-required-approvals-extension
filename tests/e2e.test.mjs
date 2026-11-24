// End-to-end test: the real extension in Chromium, with github.com simulated by fixtures.
// Run with: npm run test:e2e (needs `npm install` and a Playwright Chromium).
// Set CHROMIUM_PATH to use a given Chromium build instead of Playwright's default.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const SECTION = '#tm-required-approvals';

const CODEOWNERS = {
  main: ['*  @org/default', 'libs/a/  @org/team-a', 'libs/b/  @org/team-b @org/team-c', 'libs/d/  @org/team-a @org/team-d'].join('\n'),
  release: '*  @org/release-owners',
  [SHA]: ['*  @org/default', 'libs/a/  @org/team-a', 'libs/b/  @org/team-b @org/team-c', 'libs/c/  @org/team-c', 'libs/d/  @org/team-a @org/team-d'].join('\n'),
};

const PRS = {
  1: { base: 'main', files: ['libs/a/x.ts', 'libs/b/y.ts', 'libs/c/z.ts', 'libs/d/w.ts', '.github/CODEOWNERS'] },
  2: { base: 'release', files: ['libs/a/x.ts'] },
  3: { base: 'main', files: ['libs/a/x.ts', 'libs/b/very/long/path/file.ts'], classic: true },
};

const padding = (size) => `<!-- ${'x'.repeat(size)} -->`;

// New view sidebar: section > h4 > button > span "Reviewers".
const newSidebar = `<section><h4><button><span>Reviewers</span></button></h4>
  <ul><li><span>org/team-a: pending</span></li></ul></section><section><h4>Assignees</h4></section>`;
// Classic sidebar: div.discussion-sidebar-item > form > h3 "Reviewers".
const classicSidebar = `<div class="discussion-sidebar-item"><form><h3>Reviewers</h3>
  <p>org/team-a: pending</p></form></div><div class="discussion-sidebar-item"><h3>Assignees</h3></div>`;

function prPage(n) {
  const pr = PRS[n];
  const data = pr.classic ? '' : `<script type="application/json">{"payload":{"baseBranch":"${pr.base}","headSha":"${SHA}"}}</script>`;
  return `<!doctype html><html><head><title>PR ${n}</title></head><body>
    <main><h1>PR ${n}</h1>${padding(50_000)}<aside id="sidebar">${pr.classic ? classicSidebar : newSidebar}</aside></main>
    ${data}</body></html>`;
}

function changesPage(n) {
  const pr = PRS[n];
  const summaries = JSON.stringify(pr.files.map((p) => ({ path: p, changeType: 'MODIFIED' })));
  return `<!doctype html><html><body>${padding(100_000)}<script type="application/json">` +
    `{"payload":{"baseBranch":"${pr.base}","headSha":"${SHA}","diffSummaries":${summaries},"x":"${'y'.repeat(2_000_000)}"}}` +
    `</script></body></html>`;
}

function classicFilesPage(n) {
  const pr = PRS[n];
  return `<!doctype html><html><body>
    <span title="o/r:${pr.base}" class="commit-ref css-truncate expandable "></span>
    <span title="fork/r:feature" class="commit-ref css-truncate expandable head-ref"></span>
    <a href="/o/r/pull/${n}/show_toc?base_sha=b&amp;sha1=b&amp;sha2=${SHA}">Jump to file</a>
    ${pr.files.map((f) => `<div data-tagsearch-path="${f}"></div>`).join('')}</body></html>`;
}

function tocPage(n) {
  const short = (f) => (f.length > 20 ? '...' + f.slice(-15) : f);
  return PRS[n].files.map((f, i) => `<a href="#diff-${i}"><span class="description">${short(f)}</span></a>`).join('\n');
}

async function launch() {
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const requests = [];
  await context.route('https://github.com/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const html = (body) => route.fulfill({ status: 200, contentType: 'text/html', body });
    let m;
    if ((m = url.pathname.match(/^\/o\/r\/pull\/(\d+)$/))) return html(prPage(m[1]));
    if ((m = url.pathname.match(/^\/o\/r\/pull\/(\d+)\/changes$/))) {
      // Classic view. On github.com, /changes redirects to /files, but Playwright does
      // not route the request that follows a fulfilled redirect: a 404 takes the same
      // fallback (a fetch of /files).
      if (PRS[m[1]].classic) return route.fulfill({ status: 404, body: 'not found' });
      return html(changesPage(m[1]));
    }
    if ((m = url.pathname.match(/^\/o\/r\/pull\/(\d+)\/files$/))) return html(classicFilesPage(m[1]));
    if ((m = url.pathname.match(/^\/o\/r\/pull\/(\d+)\/show_toc$/))) return html(tocPage(m[1]));
    if ((m = url.pathname.match(/^\/o\/r\/raw\/([^/]+)\/\.github\/CODEOWNERS$/)) && CODEOWNERS[m[1]]) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: CODEOWNERS[m[1]] });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  return { context, requests };
}

const sectionText = (page) => page.locator(SECTION).innerText();
async function waitFor(page, text) {
  try {
    await page.waitForFunction(([sel, t]) => document.querySelector(sel)?.innerText.includes(t), [SECTION, text], { timeout: 10_000 });
  } catch (e) {
    const shown = await page.evaluate((sel) => document.querySelector(sel)?.innerText ?? '(no section)', SECTION);
    throw new Error(`"${text}" not shown on ${page.url()}. Section:\n${shown}`);
  }
}

test('new view, live status, navigation, cache and classic view', async () => {
  const { context, requests } = await launch();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    // First visit: result computed from /changes and CODEOWNERS.
    await page.goto('https://github.com/o/r/pull/1');
    await waitFor(page, 'Required approvals: 0 of 4 approved');
    const text = await sectionText(page);
    assert.match(text, /team-a/);
    assert.match(text, /OR/);
    assert.match(text, /also in 1 other card/);
    assert.match(text, /This PR edits CODEOWNERS/);
    assert.match(text, /c default → team-c/);
    // Placed right after the Reviewers block.
    assert.equal(await page.evaluate(() => document.querySelector('#tm-required-approvals').previousElementSibling.textContent.includes('Reviewers')), true);
    assert.deepEqual(requests.slice(1).sort(), [
      '/o/r/pull/1/changes',
      '/o/r/raw/main/.github/CODEOWNERS',
      `/o/r/raw/${SHA}/.github/CODEOWNERS`,
    ].sort());

    // Live status: a team-a member approves. team-a is in 2 cards.
    await page.evaluate(() => {
      document.querySelector('section').insertAdjacentHTML(
        'beforeend',
        '<ul aria-label="Members of org/team-a"><li><span>alice approved these changes</span></li></ul>'
      );
    });
    await waitFor(page, 'Required approvals: 2 of 4 approved');

    // Navigation inside GitHub to PR 2: the page still holds the data of PR 1
    // (base "main"), but PR 2 targets "release".
    requests.length = 0;
    await page.evaluate(() => {
      history.pushState({}, '', '/o/r/pull/2');
      document.querySelector('#sidebar').innerHTML =
        '<section><h4><button><span>Reviewers</span></button></h4></section>';
    });
    await waitFor(page, 'release-owners');
    assert.match(await page.locator(`${SECTION} [title^="From CODEOWNERS"]`).getAttribute('title'), /"release"/);
    assert.deepEqual(requests.sort(), ['/o/r/pull/2/changes', '/o/r/raw/release/.github/CODEOWNERS']);

    // Revisit PR 1 with a full page load: the cache answers, no request.
    requests.length = 0;
    await page.goto('https://github.com/o/r/pull/1');
    await waitFor(page, 'Required approvals: 0 of 4 approved');
    await page.waitForTimeout(500);
    assert.deepEqual(requests, ['/o/r/pull/1']);

    // Classic view.
    requests.length = 0;
    await page.goto('https://github.com/o/r/pull/3');
    await waitFor(page, 'Required approvals: 0 of 2 approved');
    assert.match(await sectionText(page), /team-b/);
    assert.doesNotMatch(await sectionText(page), /Approximate/);
    assert.deepEqual(requests.slice(1).sort(), [
      '/o/r/pull/3/changes',
      '/o/r/pull/3/files',
      `/o/r/pull/3/show_toc?base_sha=b&sha1=b&sha2=${SHA}`,
      // no CODEOWNERS request: the file of "main" is still in the cache
    ].sort());

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
