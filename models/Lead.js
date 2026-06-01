const mongoose = require('mongoose');

// Follow-up entry
const followUpSchema = new mongoose.Schema({
    date: { type: Date, required: true },
    time: { type: String, default: '10:00' },
    type: { type: String, default: 'Call' },
    
    status: { type: String, default: 'Scheduled' },
    notes: { type: String, default: '' },
    outcome: { type: String, default: '' },
    
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
    venue: { type: String, default: '' },
    attendees: [{ type: String }],
    agenda: { type: String, default: '' },
    minutesOfMeeting: { type: String, default: '' },
    status: { type: String, default: 'Scheduled' },
    outcome: { type: String, default: '' }
}, { _id: true, timestamps: true });

// === NEW: Vendor estimate (agent gets quotes from vendors) ===
const vendorEstimateSchema = new mongoose.Schema({
    vendorName: { type: String, required: true },
    vendorMobile: { type: String, default: '' },
    vendorId: { type: String, default: '' }, // Optional link to Vendor master
    
    productDetails: { type: String, default: '' }, // What's being quoted
    unitPrice: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    totalPrice: { type: Number, default: 0 },
    
    gstPercent: { type: Number, default: 18 },
    warranty: { type: String, default: '' },
    deliveryTime: { type: String, default: '' },
    paymentTerms: { type: String, default: '' },
    
    notes: { type: String, default: '' },
    photo: { type: String, default: '' }, // quotation photo (optional)
    
    // Status
    isSelected: { type: Boolean, default: false }, // Did we pick this vendor?
    receivedDate: { type: Date, default: Date.now },
    addedBy: { type: String, default: '' } // who added (agent/admin)
}, { _id: true, timestamps: true });

// === NEW: Work progress timeline (every action logged) ===
const progressSchema = new mongoose.Schema({
    action: { type: String, required: true }, // 'Called Customer', 'Got Vendor Quote', 'Site Visited', etc.
    description: { type: String, default: '' },
    actor: { type: String, default: '' }, // who did it
    timestamp: { type: Date, default: Date.now },
    photo: { type: String, default: '' }, // optional photo proof
    
    // Status indicator
    statusChange: { type: String, default: '' } // if this action changed lead status
}, { _id: true });

const leadSchema = new mongoose.Schema({
    // Lead info
    leadNumber: { type: String, unique: true },
    leadName: { type: String, required: true },
    companyName: { type: String, default: '' },
    mobile: { type: String, required: true },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    
    // Source
    source: { type: String, default: 'Direct' },
    referredBy: { type: String, default: '' },
    
    // Requirement
    interestedIn: [{ type: String }],
    requirement: { type: String, default: '' },
    estimatedValue: { type: Number, default: 0 },
    timeline: { type: String, default: '' },
    
    // Status pipeline
    status: { type: String, default: 'New' },
    // New → Contacted → Site Visit Done → Vendor Quotes Pending → Quote Sent → Negotiation → Won → Lost
    priority: { type: String, default: 'Medium' },
    
    // Work progress percentage (auto-computed)
    progressPercent: { type: Number, default: 0 },
    
    // Assignment
    assignedTo: { type: String, default: '' },
    assignedAt: { type: Date },
    assignedBy: { type: String, default: '' },
    
    // Notification flags
    agentNotified: { type: Boolean, default: false },
    agentSeenAt: { type: Date }, // when agent first opened this lead
    
    // Activity tracking
    followUps: [followUpSchema],
    meetings: [meetingSchema],
    vendorEstimates: [vendorEstimateSchema], // NEW: vendor quotes
    progress: [progressSchema], // NEW: every action logged
    
    // Our final quote to customer
    finalQuoteAmount: { type: Number, default: 0 },
    finalQuoteSentAt: { type: Date },
    finalQuotePhoto: { type: String, default: '' },
    finalQuoteNotes: { type: String, default: '' },
    
    // Currently working on?
    lastActivityAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    
    // Conversion
    convertedAt: { type: Date },
    convertedTo: { type: String, default: '' },
    convertedRefId: { type: String, default: '' },
    
    // === WON/Billing cycle ===
    wonAmount: { type: Number, default: 0 },
    advancePaid: { type: Number, default: 0 },
    finalAmountReceived: { type: Number, default: 0 },
    billingStatus: { type: String, default: '' }, // Pending, Advance Paid, Fully Paid
    deliveryStatus: { type: String, default: '' }, // Pending, Scheduled, Delivered, Installed
    deliveryDate: { type: Date },
    
    lostReason: { type: String, default: '' },
    notes: { type: String, default: '' }
}, { timestamps: true });

// Helper: compute progress %
leadSchema.methods.computeProgress = function() {
    const milestones = {
        'New': 5,
        'Contacted': 20,
        'Meeting Scheduled': 30,
        'Site Visit Done': 45,
        'Vendor Quotes Pending': 55,
        'Vendor Quotes Received': 70,
        'Quote Sent': 80,
        'Negotiation': 90,
        'Won': 100,
        'Lost': 100,
        'On Hold': this.progressPercent || 30
    };
    return milestones[this.status] || 10;
};

// Performance indexes
leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ mobile: 1 });
leadSchema.index({ assignedTo: 1, status: 1 });
leadSchema.index({ assignedTo: 1, agentSeenAt: 1 });

module.exports = mongoose.model('Lead', leadSchema);
