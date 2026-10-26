const { chromium } = require('playwright');
const { randomUUID } = require('crypto');

// Prototype launcher only. It opens a real browser page and tracks the session.
// Platform UI automation and reliable system-audio capture are intentionally not
// represented as completed: they require per-platform selectors and live tests.
const sessions = new Map();

function detectPlatform(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Enter a valid meeting URL.'); }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS meeting URLs are allowed.');
  const host = url.hostname.toLowerCase();
  if (host === 'meet.google.com' || host.endsWith('.meet.google.com')) return 'google-meet';
  if (host === 'teams.microsoft.com' || host.endsWith('.teams.microsoft.com') || host === 'teams.live.com') return 'microsoft-teams';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  throw new Error('Unsupported meeting URL. Use Google Meet, Microsoft Teams, or Zoom.');
}

async function startBrowserMeeting({ meetingUrl, botName = 'AI Meeting Assistant' }) {
  const platform = detectPlatform(meetingUrl);
  const id = randomUUID();
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
  const headless = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';

  const browser = await chromium.launch({
    headless,
    executablePath,
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    acceptDownloads: true
  });
  const page = await context.newPage();
  const session = {
    id, platform, meetingUrl, botName,
    status: 'opening_meeting',
    createdAt: new Date().toISOString(),
    note: 'Browser opened only. Join UI and audio capture are not yet verified.',
    browser, context, page
  };
  sessions.set(id, session);

  page.on('domcontentloaded', () => {
    if (sessions.has(id) && session.status === 'opening_meeting') {
      session.status = 'meeting_page_opened';
    }
  });
  page.on('crash', () => { session.status = 'browser_crashed'; });
  page.on('close', () => {
    if (sessions.has(id) && !['stopped', 'completed'].includes(session.status)) {
      session.status = 'browser_closed';
    }
  });

  try {
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    session.status = 'navigation_error';
    session.note = err.message;
  }

  return publicSession(session);
}

function publicSession(session) {
  return {
    id: session.id,
    platform: session.platform,
    meetingUrl: session.meetingUrl,
    botName: session.botName,
    status: session.status,
    createdAt: session.createdAt,
    note: session.note
  };
}

function getBrowserMeeting(id) {
  const session = sessions.get(id);
  return session ? publicSession(session) : null;
}

async function stopBrowserMeeting(id) {
  const session = sessions.get(id);
  if (!session) return null;
  session.status = 'stopped';
  try { await session.context.close(); } catch {}
  try { await session.browser.close(); } catch {}
  return publicSession(session);
}

module.exports = { startBrowserMeeting, getBrowserMeeting, stopBrowserMeeting, detectPlatform };
