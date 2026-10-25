const express = require("express");

const router = express.Router();

const {
  createMeeting,
  startMeeting,
  leaveMeeting,
  joinMeeting,
} = require("../controller/meetingController");

const auth = require("../middleware/authMiddleware");
const { getMeetingHistory } = require("../controller/agentController");

// Must be declared before any dynamic meeting-id routes.
router.get("/history", auth, getMeetingHistory);

router.post("/", auth, createMeeting);

router.post("/:meetingId/start", auth, startMeeting);

router.post("/:meetingId/join", auth, joinMeeting);

router.post("/:meetingId/leave", auth, leaveMeeting);

module.exports = router;