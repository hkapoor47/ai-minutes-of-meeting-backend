const mongoose = require("mongoose");

const memberSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },

    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
    },

    uid: {
        type: Number,
        default: null,
    },

    status: {
        type: String,
        enum: ["invited", "joined", "left"],
        default: "invited",
    },

    joinedAt: {
        type: Date,
        default: null,
    },

    leftAt: {
        type: Date,
        default: null,
    }
}, {
    _id: false
});


const transcriptSchema = new mongoose.Schema(
  {
    uid: {
      type: Number,
      required: true,
    },

    speaker: {
      type: String,
      required: true,
    },

    text: {
      type: String,
      required: true,
    },

    originalText: {
      type: String,
      default: "",
    },

    sentenceId: {
      type: String,
      default: null,
    },

    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);


const meetingSchema = new mongoose.Schema(
    {
       
        meetingId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },


        hostId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },


        meetingLink: {
            type: String,
            required: true,
        },

        members: {
            type: [memberSchema],

            required: true,

            validate: {
                validator: function (members) {
                    return members.length > 0;
                },

                message:
                    "At least one member is required",
            },
        },

        status: {
            type: String,

            enum: [
                "scheduled",
                "active",
                "ended",
            ],

            default: "scheduled",
        },
        agentId: {
            type: String,
            default: null,
        },

        // Source and lifecycle fields for the external-agent mode.
        source: {
            type: String,
            enum: ["native", "external"],
            default: "native",
        },
        provider: {
            type: String,
            enum: ["agora", "google_meet", "teams", "zoom", null],
            default: "agora",
        },
        externalMeetingUrl: { type: String, default: "" },
        externalMeetingId: { type: String, default: "" },
        participantEmails: { type: [String], default: [] },
        agentStatus: {
            type: String,
            enum: ["pending", "joining", "in_meeting", "processing", "completed", "failed"],
            default: "pending",
        },
        transcriptStatus: {
            type: String,
            enum: ["waiting", "ready", "failed"],
            default: "waiting",
        },
        emailStatus: {
            type: String,
            enum: ["pending", "sent", "partial", "failed"],
            default: "pending",
        },

        isRecording: {
            type: Boolean,
            default: false,
        },
       
    
        transcript: {
            type: [transcriptSchema],

            default: [],
        },

        summary: {
            type: String,

            default: "",
        },

        pdfUrl: {
            type: String,

            default: "",
        },

        startedAt: {
            type: Date,

            default: null,
        },

        endedAt: {
            type: Date,

            default: null,
        },
    },

    {
        timestamps: true,
    }
);


module.exports =
    mongoose.model(
        "Meeting",
        meetingSchema
    );