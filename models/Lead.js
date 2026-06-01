const mongoose = require('mongoose');

// Follow-up entry
const followUpSchema = new mongoose.Schema({
    date: { type: Date, required: true },
    time: { type: String, default: '10:00' },
    type: { type: String, default: 'Call' }, // Call, Meeting, Email, WhatsApp, Visit
    
    status: { type: String, default: 'Scheduled' }, // Scheduled, Done, Missed, Rescheduled
    notes: { type: String, default: '' },
    outcome: { type: String, default: '' }, // What happened
    
    scheduledBy: { type: String, default: '' },
    handledBy: { type: String, default: '' },
    
    nextAction: { type: String, default: '' },
    nextActionDate: { type: Date },
    
    notificationSent: { type: Boolean, default: false }
}, { _id: true, timestamps: true });

// Meeting entry
const meetingSchema = new mongoose.Schema({
    meetingDate: { type: Date, required: true },
    meetingTime: { type: String, default: '11:00' },
    venue: { type: String, default: '' }, // Office, Client site, Online, etc.
    
    attendees: [{ type: String }],
    
    agenda: { type: String, default: '' },
    minutesOfMeeting: { type: String, default: '' },
    
    status: { type: String, default: 'Scheduled' },
    outcome: { type: String, default: '' }
}, { _id: true, timestamps: true });

const leadSchema = new mongoose.Schema({
    // Lead info
    leadNumber: { type: String, unique: true }, // SEA-L-0001
    leadName: { type: String, required: true }, // Person/Company name
    companyName: { type: String, default: '' },
    mobile: { type: String, required: true },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    
    // Source
    source: { type: String, default: 'Direct' }, // Direct, Website, Reference, Walk-in, Cold Call, Social Media
    referredBy: { type: String, default: '' },
    
    // Requirement
    interestedIn: [{ type: String }], // CCTV, Hardware, AI Software, AMC, Biometric
    requirement: { type: String, default: '' }, // Detailed requirement
    estimatedValue: { type: Number, default: 0 },
    timeline: { type: String, default: '' }, // Immediate, 1 week, 1 month, etc.
    
    // Status pipeline
    status: { type: String, default: 'New' }, // New, Contacted, Meeting Scheduled, Quote Sent, Negotiation, Won, Lost, On Hold
    priority: { type: String, default: 'Medium' }, // High, Medium, Low
    
    // Assignment
    assignedTo: { type: String, default: '' }, // admin/vijay/rahul
    
    // Activity
    followUps: [followUpSchema],
    meetings: [meetingSchema],
    
    // Conversion
    convertedAt: { type: Date },
    convertedTo: { type: String, default: '' }, // 'Hardware Order', 'AMC Office', 'CCTV Quote', etc.
    convertedRefId: { type: String, default: '' }, // ID of created order/office/quote
    lostReason: { type: String, default: '' },
    
    notes: { type: String, default: '' }
}, { timestamps: true });


// Performance indexes
leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ mobile: 1 });
leadSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('Lead', leadSchema);
