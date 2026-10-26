const express = require('express');
const { randomUUID } = require('crypto');
const auth = require('../middleware/authMiddleware');
const Meeting = require('../models/meeting');
const User = require('../models/user');
const { askLLM } = require('../services/llmService');
const { generatePdf } = require('../services/pdfService');
const { sendPdf } = require('../services/emailService');
const {
  startBrowserMeeting, getBrowserMeeting, getSession,
  stopBrowserMeeting, detectPlatform
} = require('../services/browserMeetingBot');

const router = express.Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/start', auth, async (req, res) => {
  let meeting = null;
  try {
    const { meetingUrl, botName, title, emailRecipients } = req.body || {};
    if (!meetingUrl) return res.status(400).json({ message: 'meetingUrl is required.' });
    const platform = detectPlatform(meetingUrl);
    const host = await User.findById(req.user?.id);
    if (!host) return res.status(401).json({ message: 'Authenticated user not found.' });
    const recipients = Array.isArray(emailRecipients)
      ? [...new Set(emailRecipients.map((x) => String(x).trim().toLowerCase()).filter((x) => emailPattern.test(x)))]
      : [];
    const appMeetingId = randomUUID();
    const safeTitle = String(title || `${platform.replace('_', ' ')} meeting`).trim().slice(0, 160);

    meeting = await Meeting.create({
      meetingId: appMeetingId,
      hostId: host._id,
      title: safeTitle,
      meetingLink: meetingUrl,
      members: [{ name: host.name || host.email, email: host.email, status: 'joined', joinedAt: new Date() }],
      status: 'active',
      source: 'external',
      provider: platform,
      externalMeetingUrl: meetingUrl,
      externalMeetingId: new URL(meetingUrl).pathname,
      participantEmails: recipients,
      agentStatus: 'joining',
      transcriptStatus: 'waiting',
      emailStatus: 'pending',
      startedAt: new Date()
    });

    const session = await startBrowserMeeting({
      meetingUrl,
      botName: typeof botName === 'string' && botName.trim() ? botName.trim().slice(0, 80) : 'AI Meeting Assistant',
      appMeetingId,
      emailRecipients: recipients
    });
    meeting.agentId = session.id;
    meeting.agentStatus = session.status === 'in_meeting' ? 'in_meeting' : 'joining';
    if (session.status === 'navigation_error' || session.status === 'browser_crashed') meeting.agentStatus = 'failed';
    await meeting.save();

    return res.status(202).json({
      message: 'Browser session started and platform-specific join was attempted. This does not confirm audio capture or transcription.',
      meetingId: appMeetingId,
      session
    });
  } catch (error) {
    if (meeting) {
      meeting.agentStatus = 'failed';
      await meeting.save().catch(() => {});
    }
    return res.status(400).json({ message: error.message || 'Unable to start browser meeting.' });
  }
});

router.get('/:id/status', auth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.id, hostId: req.user?.id });
    if (!meeting) return res.status(404).json({ message: 'External meeting not found.' });
    const session = meeting.agentId ? await getBrowserMeeting(meeting.agentId) : null;
    if (session) {
      if (session.status === 'in_meeting') meeting.agentStatus = 'in_meeting';
      else if (session.status === 'meeting_ended') meeting.agentStatus = 'processing';
      else if (['browser_crashed', 'navigation_error'].includes(session.status)) meeting.agentStatus = 'failed';
      await meeting.save();
    }
    return res.json({ meetingId: meeting.meetingId, agentStatus: meeting.agentStatus, transcriptStatus: meeting.transcriptStatus, emailStatus: meeting.emailStatus, session });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to read agent status.', error: error.message });
  }
});

// Call after a separate, consented audio/STT component has produced the transcript.
// This endpoint does not itself capture meeting audio or generate speech-to-text.
router.post('/:id/complete', auth, async (req, res) => {
  try {
    const { transcript, emailRecipients } = req.body || {};
    const meeting = await Meeting.findOne({ meetingId: req.params.id, hostId: req.user?.id });
    if (!meeting || meeting.source !== 'external') return res.status(404).json({ message: 'External meeting not found.' });
    const text = Array.isArray(transcript)
      ? transcript.map((item) => typeof item === 'string' ? item : `${item?.speaker || 'Unknown'}: ${item?.text || ''}`).filter(Boolean).join('\n')
      : String(transcript || '').trim();
    if (!text.trim()) return res.status(400).json({ message: 'A non-empty transcript is required.' });

    meeting.agentStatus = 'processing';
    await meeting.save();
    const summary = await askLLM(text);
    const pdf = await generatePdf(summary);

    meeting.summary = summary;
    meeting.pdfUrl = pdf.filePath;
    meeting.transcriptStatus = 'ready';
    meeting.status = 'ended';
    meeting.endedAt = new Date();
    meeting.agentStatus = 'completed';
    meeting.transcript = text.split(/\r?\n/).map((line) => {
      const match = line.match(/^([^:]{1,80}):\s*(.*)$/);
      return { uid: 1, speaker: match ? match[1].trim() : 'Unknown', text: match ? match[2].trim() : line.trim(), originalText: match ? match[2].trim() : line.trim(), timestamp: new Date() };
    }).filter((item) => item.text);

    const supplied = Array.isArray(emailRecipients) ? emailRecipients : meeting.participantEmails;
    const recipients = [...new Set(supplied.map((x) => String(x).trim().toLowerCase()).filter((x) => emailPattern.test(x)))];
    const host = await User.findById(meeting.hostId);
    if (recipients.length === 0 && host?.email) recipients.push(host.email.toLowerCase());
    await meeting.save();

    const results = await Promise.allSettled(recipients.map((email) => sendPdf(email, email === host?.email ? (host.name || email) : email, pdf.filePath)));
    const sent = results.filter((r) => r.status === 'fulfilled').length;
    meeting.emailStatus = sent === results.length && sent > 0 ? 'sent' : sent > 0 ? 'partial' : 'failed';
    await meeting.save();
    return res.json({ message: 'Transcript processed into MoM and PDF; email delivery results recorded.', meetingId: meeting.meetingId, summary, pdfFileName: pdf.fileName, emailStatus: meeting.emailStatus, emailsSent: sent, emailFailures: results.length - sent });
  } catch (error) {
    await Meeting.findOneAndUpdate({ meetingId: req.params.id }, { $set: { agentStatus: 'failed' } }).catch(() => {});
    return res.status(500).json({ message: 'Failed to process transcript into MoM/PDF/email.', error: error.message });
  }
});

router.post('/:id/stop', auth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.id, hostId: req.user?.id });
    if (!meeting) return res.status(404).json({ message: 'External meeting not found.' });
    const session = meeting.agentId ? await stopBrowserMeeting(meeting.agentId) : null;
    meeting.agentStatus = meeting.agentStatus === 'completed' ? 'completed' : 'failed';
    await meeting.save();
    return res.json({ message: 'Browser session stopped.', session, meetingId: meeting.meetingId });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to stop browser session.', error: error.message });
  }
});

module.exports = router;
