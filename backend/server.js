require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const auth = require("./middleware/authMiddleware");
const Meeting = require("./models/meeting");
const User = require("./models/user");

const app = express();
const PORT = process.env.PORT || 5000;

const speech = require("./routes/speech");
const agora = require("./routes/agora");
const testRoute = require("./routes/test");
const llmRoute = require("./routes/llm");
const meetingRoute = require("./routes/meeting");
const pdfRoute = require("./routes/pdf");
const translate = require("./routes/translation");
const { translateTranscript } = require("./services/translationService");

app.use(express.json());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use("/api/llm", llmRoute);
app.use("/api/test", testRoute);
app.use("/api/agora", agora);
app.use("/api/meeting", meetingRoute);
app.use("/api/pdf", pdfRoute);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/speech", speech);
app.use("/api/translate", translate);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

const meetingParticipants = new Map();
const transcriptHistory = new Map();

io.on("connection", (socket) => {
  console.log("Client Connected:", socket.id);

  socket.on("join-meeting", (data) => {
    try {
      const { meetingId, name, email, role, uid } = data || {};

      if (!meetingId) {
        console.log("Meeting ID missing");
        return;
      }

      socket.join(meetingId);
      socket.meetingId = meetingId;

      if (!meetingParticipants.has(meetingId)) {
        meetingParticipants.set(meetingId, new Map());
      }

      const roomParticipants = meetingParticipants.get(meetingId);
      const participant = {
        socketId: socket.id,
        name: name || "Unknown",
        email: email || "",
        role: role || "participant",
        uid: uid === undefined || uid === null ? null : Number(uid),
      };

      roomParticipants.set(socket.id, participant);

      console.log("Participant joined:", participant);
      io.to(meetingId).emit(
        "participants-updated",
        Array.from(roomParticipants.values())
      );
    } catch (error) {
      console.error("join-meeting error:", error);
    }
  });

  socket.on("participant-uid", (data) => {
    try {
      const { meetingId, uid, name, email, role } = data || {};

      if (!meetingId || uid === undefined || uid === null) {
        console.log("Invalid participant UID:", data);
        return;
      }

      const roomParticipants = meetingParticipants.get(meetingId);

      if (!roomParticipants) {
        console.log("Meeting room not found:", meetingId);
        return;
      }

      const participant = roomParticipants.get(socket.id) || {
        socketId: socket.id,
        name: name || email || "Unknown",
        email: email || "",
        role: role || "participant",
        uid: null,
      };

      participant.uid = Number(uid);
      participant.name = name || participant.name;
      participant.email = email || participant.email;
      participant.role = role || participant.role;

      roomParticipants.set(socket.id, participant);

      console.log("Agora UID mapped successfully:", participant);
      io.to(meetingId).emit(
        "participants-updated",
        Array.from(roomParticipants.values())
      );
    } catch (error) {
      console.error("participant-uid error:", error);
    }
  });

  socket.on("recording-started", (meetingId) => {
    if (!meetingId) {
      return;
    }

    console.log("Recording started:", meetingId);
    socket.to(meetingId).emit("recording-started");
  });

  socket.on("recording-stopped", (meetingId) => {
    if (!meetingId) {
      return;
    }

    console.log("Recording stopped:", meetingId);
    socket.to(meetingId).emit("recording-stopped");
  });

  socket.on("end-meeting", (meetingId) => {
    if (!meetingId) {
      return;
    }

    console.log("Meeting ended by host:", meetingId);
    socket.to(meetingId).emit("meeting-ended");
  });

socket.on("transcript", async (data) => {
  try {
    console.log("🎤 TRANSCRIPT FROM CLIENT:", data);

    const {
      meetingId,
      uid,
      name,
      email,
      text,
      sentenceId,
    } = data || {};

    if (!meetingId || !text) {
      console.log("⚠️ Missing meetingId or text");
      return;
    }

    const originalText = String(text).trim();

    if (!originalText) {
      return;
    }

    const meeting = await Meeting.findOne({
      meetingId,
    });

    if (!meeting) {
      console.log(
        "❌ Meeting not found:",
        meetingId
      );
      return;
    }

    // =====================================================
    // FIND SPEAKER
    // =====================================================

    const roomParticipants =
      meetingParticipants.get(meetingId);

    const socketParticipant =
      roomParticipants
        ? Array.from(
            roomParticipants.values()
          ).find(
            (participant) =>
              Number(participant.uid) ===
              Number(uid)
          )
        : null;

    const mongoParticipant =
      meeting.members?.find(
        (member) =>
          Number(member.uid) ===
          Number(uid)
      );

    const speaker =
      name ||
      socketParticipant?.name ||
      mongoParticipant?.name ||
      (Number(uid) === 1
        ? "Host"
        : "Unknown");

    // =====================================================
    // HINDI / HINGLISH -> ENGLISH
    // =====================================================

    let translatedText = originalText;

    try {
      console.log(
        "🌐 Translating transcript:",
        originalText
      );

      translatedText =
        await translateTranscript(
          originalText
        );

      translatedText =
        String(translatedText || originalText)
          .trim();

      console.log(
        "✅ TRANSLATED ENGLISH:",
        translatedText
      );
    } catch (translationError) {
      console.error(
        "❌ Translation failed:",
        translationError
      );

      // If translation fails,
      // keep original text instead of losing transcript.
      translatedText = originalText;
    }

    // =====================================================
    // SAVE TO MONGODB
    // =====================================================

    const transcriptItem = {
      uid: Number(uid),
      speaker,

      // English transcript
      text: translatedText,

      // Original Agora STT text
      originalText,

      sentenceId:
        sentenceId || null,

      timestamp: new Date(),
    };

    meeting.transcript.push(
      transcriptItem
    );

    await meeting.save();

    console.log(
      "💾 Transcript saved to MongoDB:",
      transcriptItem
    );

    // =====================================================
    // SEND ENGLISH TRANSCRIPT TO EVERYONE
    // =====================================================

    io.to(meetingId).emit(
      "transcript",
      {
        meetingId,
        uid: Number(uid),
        speaker,

        // UI receives English
        text: translatedText,

        // Original Hindi/Hinglish is also available
        originalText,

        timestamp:
          transcriptItem.timestamp,

        sentenceId:
          sentenceId || null,
      }
    ); s

    console.log(
      "📤 English transcript emitted:",
      translatedText
    );

  } catch (error) {
    console.error(
      "❌ Transcript socket error:",
      error
    );
  }
});

  socket.on("disconnect", () => {
    console.log("Client Disconnected:", socket.id);

    const meetingId = socket.meetingId;

    if (!meetingId) {
      return;
    }

    const roomParticipants = meetingParticipants.get(meetingId);

    if (!roomParticipants) {
      return;
    }

    roomParticipants.delete(socket.id);
    io.to(meetingId).emit(
      "participants-updated",
      Array.from(roomParticipants.values())
    );

    if (roomParticipants.size === 0) {
      meetingParticipants.delete(meetingId);
      console.log("Meeting room cleaned:", meetingId);
    }
  });
});

app.post("/test-callback", (req, res) => {
  console.log("TEST CALLBACK HIT:", req.body);
  
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Backend is running successfully");
});

app.get("/profile", auth, (req, res) => {
  res.json({
    message: "This is a protected route",
    user: req.user,
  });
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected successfully");
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  })