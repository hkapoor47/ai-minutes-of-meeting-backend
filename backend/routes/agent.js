const express = require('express');
const auth = require('../middleware/authMiddleware');
const {
  createAgentMeeting,
  getAgentStatus,
  ingestTranscript,
  finalizeAgentMeeting,
} = require('../controller/agentController');

const router = express.Router();
router.post('/', auth, createAgentMeeting);
router.get('/:id/status', auth, getAgentStatus);
router.post('/:id/transcript', auth, ingestTranscript);
router.post('/:id/finalize', auth, finalizeAgentMeeting);
module.exports = router;
