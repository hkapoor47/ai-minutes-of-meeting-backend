const { chromium } = require('playwright');
const { randomUUID } = require('crypto');

const sessions = new Map();

function detectPlatform(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Enter a valid meeting URL.'); }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS meeting URLs are allowed.');
  const host = url.hostname.toLowerCase();
  if (host === 'meet.google.com' || host.endsWith('.meet.google.com')) return 'google_meet';
  if (host === 'teams.microsoft.com' || host.endsWith('.teams.microsoft.com') || host === 'teams.live.com') return 'teams';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  throw new Error('Unsupported meeting URL. Use Google Meet, Microsoft Teams, or Zoom.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickFirst(page, selectors, timeout = 1200) {
  for (const selector of selectors) {
    try {
      const locator = selector.kind === 'text'
        ? page.getByText(selector.value, { exact: false }).first()
        : page.getByRole('button', { name: selector.value, exact: false }).first();
      if (await locator.isVisible({ timeout: 300 }).catch(() => false)) {
        await locator.click({ timeout });
        return selector.value;
      }
    } catch (_) {}
  }
  return null;
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 300 }).catch(() => false)) {
        await locator.fill(value, { timeout: 1500 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function turnOffMediaIfOn(page) {
  // Click only controls whose accessible name indicates media is currently ON.
  const mic = await clickFirst(page, [
    { kind: 'button', value: /turn off microphone/i },
    { kind: 'button', value: /mute microphone/i },
    { kind: 'button', value: /mute my microphone/i }
  ], 900);
  const camera = await clickFirst(page, [
    { kind: 'button', value: /turn off camera/i },
    { kind: 'button', value: /turn off video/i },
    { kind: 'button', value: /stop video/i }
  ], 900);
  return { microphoneMuteAttempted: Boolean(mic), cameraOffAttempted: Boolean(camera) };
}

async function joinGoogleMeet(page, botName) {
  await clickFirst(page, [
    { kind: 'button', value: /continue without microphone and camera/i },
    { kind: 'button', value: /use without microphone and camera/i }
  ]);
  await fillFirst(page, [
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]'
  ], botName);
  await turnOffMediaIfOn(page);
  const clicked = await clickFirst(page, [
    { kind: 'button', value: /^ask to join$/i },
    { kind: 'button', value: /^join now$/i },
    { kind: 'button', value: /join meeting/i }
  ], 2500);
  return clicked ? 'join_requested' : 'join_control_not_found';
}

async function joinTeams(page, botName) {
  // Teams UI differs by tenant, account type, and guest policy. Never bypass login/lobby.
  await clickFirst(page, [
    { kind: 'button', value: /continue on this browser/i },
    { kind: 'button', value: /join on the web instead/i },
    { kind: 'button', value: /join on the web/i }
  ], 1800);
  await fillFirst(page, [
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[data-tid*="display-name" i]'
  ], botName);
  await turnOffMediaIfOn(page);
  const clicked = await clickFirst(page, [
    { kind: 'button', value: /^join now$/i },
    { kind: 'button', value: /^join meeting$/i },
    { kind: 'button', value: /^join$/i }
  ], 2500);
  return clicked ? 'join_requested' : 'join_control_not_found';
}

async function joinZoom(page, botName) {
  // Zoom may redirect to the installed client or require browser-join to be enabled by host.
  await clickFirst(page, [
    { kind: 'text', value: /join from your browser/i },
    { kind: 'button', value: /join from your browser/i }
  ], 2200);
  await fillFirst(page, [
    'input#inputname',
    'input[name="inputname"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]'
  ], botName);
  await fillFirst(page, [
    'input#inputemail',
    'input[name="inputemail"]',
    'input[type="email"]'
  ], process.env.BOT_GUEST_EMAIL || 'ai-meeting-assistant@example.com');
  await turnOffMediaIfOn(page);
  const clicked = await clickFirst(page, [
    { kind: 'button', value: /^join$/i },
    { kind: 'button', value: /join meeting/i },
    { kind: 'button', value: /join audio by computer/i }
  ], 2500);
  return clicked ? 'join_requested' : 'join_control_not_found';
}

async function inferMeetingState(page, session) {
  if (page.isClosed()) return 'browser_closed';
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const text = body.toLowerCase();
  if (/you'll be able to join when someone lets you in|waiting for the organizer|someone will let you in|waiting in the lobby|waiting for someone to let you in/.test(text)) {
    return 'waiting_for_admission';
  }
  if (/you have been removed|meeting has ended|this meeting has ended|host ended the meeting/.test(text)) {
    return 'meeting_ended';
  }
  const leaveVisible = await page.getByRole('button', { name: /leave (call|meeting)|hang up/i }).first().isVisible().catch(() => false);
  if (leaveVisible) return 'in_meeting';
  if (session.joinAttempt === 'join_requested') return 'join_requested';
  return 'meeting_page_opened';
}

async function startBrowserMeeting({ meetingUrl, botName = 'AI Meeting Assistant', appMeetingId, emailRecipients = [] }) {
  const platform = detectPlatform(meetingUrl);
  const id = randomUUID();
  const headless = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
  const browser = await chromium.launch({
    headless,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream'
    ]
  });
  const context = await browser.newContext({
    permissions: ['microphone'],
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  const session = {
    id, appMeetingId, platform, meetingUrl, botName,
    emailRecipients: Array.isArray(emailRecipients) ? emailRecipients : [],
    status: 'opening_meeting', joinAttempt: null,
    createdAt: new Date().toISOString(),
    note: 'Platform-specific join attempt is best-effort. Audio capture/transcription is not implemented by this browser adapter.',
    browser, context, page
  };
  sessions.set(id, session);
  page.on('crash', () => { session.status = 'browser_crashed'; });
  page.on('close', () => {
    if (!['stopped', 'completed', 'meeting_ended'].includes(session.status)) session.status = 'browser_closed';
  });

  try {
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    if (platform === 'google_meet') session.joinAttempt = await joinGoogleMeet(page, botName);
    else if (platform === 'teams') session.joinAttempt = await joinTeams(page, botName);
    else session.joinAttempt = await joinZoom(page, botName);
    await sleep(1800);
    session.status = await inferMeetingState(page, session);
    session.note = session.status === 'in_meeting'
      ? 'A meeting control was detected. Audio capture/transcription is still not implemented.'
      : `Join attempt: ${session.joinAttempt}. Check the visible browser for login, guest policy, consent, or lobby prompts.`;
  } catch (err) {
    session.status = 'navigation_error';
    session.note = err.message;
  }
  return publicSession(session);
}

function publicSession(session) {
  return {
    id: session.id, appMeetingId: session.appMeetingId,
    platform: session.platform, meetingUrl: session.meetingUrl,
    botName: session.botName, status: session.status,
    joinAttempt: session.joinAttempt, createdAt: session.createdAt,
    note: session.note
  };
}

async function getBrowserMeeting(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (!session.page.isClosed()) session.status = await inferMeetingState(session.page, session);
  return publicSession(session);
}

function getSession(id) { return sessions.get(id) || null; }

async function stopBrowserMeeting(id) {
  const session = sessions.get(id);
  if (!session) return null;
  session.status = 'stopped';
  try { await session.context.close(); } catch (_) {}
  try { await session.browser.close(); } catch (_) {}
  return publicSession(session);
}

module.exports = { startBrowserMeeting, getBrowserMeeting, getSession, stopBrowserMeeting, detectPlatform };
