const express = require('express');
const auth = require('../middleware/authMiddleware');
const {
  startBrowserMeeting,
  getBrowserMeeting,
  stopBrowserMeeting,
  detectPlatform
} = require('../services/browserMeetingBot');

const router = express.Router();

// Authenticated prototype endpoints. Browser sessions are in-memory and will
// be lost when the server restarts; use a persistent job store before production.
router.post('/start', auth, async (req, res) => {
  try {
    const { meetingUrl, botName } = req.body || {};
    if (!meetingUrl) return res.status(400).json({ message: 'meetingUrl is required.' });
    const platform = detectPlatform(meetingUrl);
    const session = await startBrowserMeeting({
      meetingUrl,
      botName: typeof botName === 'string' && botName.trim()
        ? botName.trim().slice(0, 80)
        : 'AI Meeting Assistant'
    });
    return res.status(202).json({
      message: 'Browser session launched. This does not confirm that the bot joined or can capture audio.',
      session,
      next: 'Verify the visible browser, participant name, lobby admission and audio capture in a test meeting.'
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Unable to launch meeting browser.' });
  }
});

router.get('/:id/status', auth, (req, res) => {
  const session = getBrowserMeeting(req.params.id);
  if (!session) return res.status(404).json({ message: 'Browser session not found.' });
  return res.json({ session });
});

router.post('/:id/stop', auth, async (req, res) => {
  const session = await stopBrowserMeeting(req.params.id);
  if (!session) return res.status(404).json({ message: 'Browser session not found.' });
  return res.json({ message: 'Browser session stopped.', session });
});

module.exports = router;
