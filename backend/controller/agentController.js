const { v4: uuidv4 } = require('uuid');
const Meeting = require('../models/meeting');
const User = require('../models/user');
const { askLLM } = require('../services/llmService');
const { generatePdf } = require('../services/pdfService');
const { sendPdf } = require('../services/emailService');

const PROVIDERS = new Set(['google_meet', 'teams', 'zoom']);
const ACTIVE_AGENT_STATUSES = new Set(['pending', 'joining', 'in_meeting', 'processing']);

function safeMeeting(meeting) {
  return {
    meetingId: meeting.meetingId,
    title: meeting.title,
    source: meeting.source,
    provider: meeting.provider,
    externalMeetingUrl: meeting.externalMeetingUrl,
    status: meeting.status,
    agentStatus: meeting.agentStatus,
    transcriptStatus: meeting.transcriptStatus,
    emailStatus: meeting.emailStatus,
    summary: meeting.summary,
    pdfUrl: meeting.pdfUrl,
    participantEmails: meeting.participantEmails || [],
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  };
}

function isOwner(meeting, req) {
  return meeting && String(meeting.hostId) === String(req.user?.id || req.user?._id);
}

function normalizeProviderUrl(provider, rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const allowed = {
    google_meet: ['meet.google.com'],
    teams: ['teams.microsoft.com', 'teams.live.com'],
    zoom: ['zoom.us', 'www.zoom.us', 'app.zoom.us'],
  };
  return (allowed[provider] || []).some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url.toString() : null;
}

async function createAgentMeeting(req, res) {
  try {
    const { title, provider, externalMeetingUrl, participantEmails = [] } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Meeting title is required.' });
    }
    if (!PROVIDERS.has(provider)) {
      return res.status(400).json({ message: 'Provider must be google_meet, teams, or zoom.' });
    }
    const safeUrl = normalizeProviderUrl(provider, externalMeetingUrl);
    if (!safeUrl) {
      return res.status(400).json({ message: 'Enter a valid HTTPS meeting URL for the selected platform.' });
    }
    if (!Array.isArray(participantEmails)) {
      return res.status(400).json({ message: 'participantEmails must be an array.' });
    }
    const emails = [...new Set(participantEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (emails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
      return res.status(400).json({ message: 'One or more participant email addresses are invalid.' });
    }

    const userId = req.user?.id || req.user?._id;
    const host = await User.findById(userId);
    if (!host) return res.status(404).json({ message: 'Authenticated user was not found.' });
    const meetingId = uuidv4();
    const allEmails = [...new Set([host.email.toLowerCase(), ...emails])];
    const members = allEmails.map((email) => ({
      name: email === host.email.toLowerCase() ? host.name : email.split('@')[0],
      email,
      status: 'invited',
    }));

    const meeting = await Meeting.create({
      meetingId,
      hostId: host._id,
      title: title.trim(),
      meetingLink: safeUrl,
      members,
      source: 'external',
      provider,
      externalMeetingUrl: safeUrl,
      participantEmails: allEmails,
      agentStatus: 'pending',
      transcriptStatus: 'waiting',
      emailStatus: 'pending',
      status: 'scheduled',
    });

    // Deliberately do not claim the bot joined: this endpoint registers the job only.
    // A provider adapter must be configured and verified before changing agentStatus to joining.
    return res.status(201).json({
      message: 'External meeting registered. A live bot has NOT joined yet; provider integration is required.',
      meetingId: meeting.meetingId,
      agentStatus: meeting.agentStatus,
      provider: meeting.provider,
      source: meeting.source,
      providerIntegrationReady: false,
    });
  } catch (error) {
    console.error('createAgentMeeting:', error);
    return res.status(500).json({ message: 'Could not register external meeting.' });
  }
}

async function getAgentStatus(req, res) {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.id });
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    if (!isOwner(meeting, req)) return res.status(403).json({ message: 'You do not have access to this meeting.' });
    return res.json(safeMeeting(meeting));
  } catch (error) {
    console.error('getAgentStatus:', error);
    return res.status(500).json({ message: 'Could not fetch agent status.' });
  }
}

async function getMeetingHistory(req, res) {
  try {
    const userId = req.user?.id || req.user?._id;
    const meetings = await Meeting.find({ hostId: userId }).sort({ createdAt: -1 }).limit(100);
    return res.json({ meetings: meetings.map(safeMeeting) });
  } catch (error) {
    console.error('getMeetingHistory:', error);
    return res.status(500).json({ message: 'Could not fetch meeting history.' });
  }
}

// Secure authenticated transcript ingestion endpoint for a trusted integration or manual test.
// Do not expose this as an unauthenticated provider webhook; provider signatures need verification.
async function ingestTranscript(req, res) {
  try {
    const { transcript } = req.body || {};
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ message: 'transcript must be a non-empty array.' });
    }
    const meeting = await Meeting.findOne({ meetingId: req.params.id });
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    if (!isOwner(meeting, req)) return res.status(403).json({ message: 'You do not have access to this meeting.' });
    if (meeting.source !== 'external') return res.status(400).json({ message: 'Transcript ingestion is only for external meetings.' });

    const cleaned = transcript.map((entry) => ({
      uid: Number.isFinite(Number(entry?.uid)) ? Number(entry.uid) : 0,
      speaker: String(entry?.speaker || 'Unknown').slice(0, 120),
      text: String(entry?.text || '').trim().slice(0, 10000),
      originalText: String(entry?.originalText || entry?.text || '').trim().slice(0, 10000),
      sentenceId: entry?.sentenceId ? String(entry.sentenceId).slice(0, 120) : null,
      timestamp: entry?.timestamp && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp) : new Date(),
    })).filter((entry) => entry.text);
    if (!cleaned.length) return res.status(400).json({ message: 'No usable transcript text found.' });

    meeting.transcript = cleaned;
    meeting.transcriptStatus = 'ready';
    meeting.agentStatus = 'processing';
    await meeting.save();
    return res.json({ message: 'Transcript saved. Run finalize to generate MoM, PDF, and email.', count: cleaned.length, agentStatus: meeting.agentStatus });
  } catch (error) {
    console.error('ingestTranscript:', error);
    return res.status(500).json({ message: 'Could not save transcript.' });
  }
}

async function finalizeAgentMeeting(req, res) {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.id });
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    if (!isOwner(meeting, req)) return res.status(403).json({ message: 'You do not have access to this meeting.' });
    if (!meeting.transcript?.length) return res.status(400).json({ message: 'No transcript is saved for this meeting yet.' });
    if (meeting.agentStatus === 'completed' && meeting.pdfUrl) {
      return res.json({ message: 'Meeting already finalized.', meeting: safeMeeting(meeting) });
    }

    meeting.agentStatus = 'processing';
    await meeting.save();
    const transcriptText = meeting.transcript.map((t) => `${t.speaker || 'Unknown'}: ${t.text}`).join('\n');
    const summary = await askLLM(transcriptText);
    const pdf = await generatePdf(summary);
    meeting.summary = summary;
    meeting.pdfUrl = pdf.filePath;
    meeting.status = 'ended';
    meeting.endedAt = new Date();
    meeting.transcriptStatus = 'ready';
    await meeting.save();

    const recipients = [...new Set((meeting.participantEmails?.length ? meeting.participantEmails : meeting.members.map((m) => m.email)).map((e) => String(e).toLowerCase()))];
    const failures = [];
    for (const email of recipients) {
      const member = meeting.members.find((m) => m.email.toLowerCase() === email);
      try { await sendPdf(email, member?.name || email.split('@')[0], pdf.filePath); }
      catch (error) { failures.push(email); console.error(`MoM email failed for ${email}:`, error.message); }
    }
    meeting.emailStatus = failures.length ? (failures.length === recipients.length ? 'failed' : 'partial') : 'sent';
    meeting.agentStatus = 'completed';
    await meeting.save();

    return res.json({
      message: failures.length ? 'MoM generated; some emails failed.' : 'MoM generated and emailed.',
      meeting: safeMeeting(meeting),
      emailFailures: failures,
    });
  } catch (error) {
    console.error('finalizeAgentMeeting:', error);
    await Meeting.updateOne({ meetingId: req.params.id, hostId: req.user?.id || req.user?._id }, { $set: { agentStatus: 'failed' } }).catch(() => {});
    return res.status(500).json({ message: 'Could not finalize meeting. Check server logs and API quotas.' });
  }
}

module.exports = { createAgentMeeting, getAgentStatus, getMeetingHistory, ingestTranscript, finalizeAgentMeeting };
