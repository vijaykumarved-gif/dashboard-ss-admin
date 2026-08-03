const mongoose = require('mongoose');

// PC entry inside a corporate visit
const corporatePcSchema = new mongoose.Schema({
    pcSrNo: { type: String, default: '' }, // PC-01, LAP-05
    pcType: { type: String, default: 'Desktop' }, // Desktop, Laptop, AIO, Server
    pcName: { type: String, default: '' }, // Hostname / Asset Tag
    pcModel: { type: String, default: '' }, // Dell OptiPlex 7090
    serialNumber: { type: String, default: '' }, // Manufacturer SN
    
    user: { type: String, default: '' }, // Employee using it
    department: { type: String, default: '' },
    
    // Component health
    motherboard: { type: String, default: 'Good' },
    cpu: { type: String, default: 'Good' },
    ramStatus: { type: String, default: 'Good' },
    ramSlots: { type: String, default: 'Good' },
    hddHealth: { type: String, default: 'Good' },
    drive: { type: String, default: 'Good' },
    fan: { type: String, default: 'Good' },
    temperature: { type: String, default: 'Normal' },
    connectors: { type: String, default: 'Good' },
    battery: { type: String, default: 'Good' },
    charger: { type: String, default: 'Good' },
    powerCable: { type: String, default: 'Good' },
    monitor: { type: String, default: 'Good' },
    display: { type: String, default: 'Good' }, // Good, In Line, Blur, No Power, Flickering, Dead Pixel, N/A
    keyboard: { type: String, default: 'Good' },
    mouse: { type: String, default: 'Good' },
    smps: { type: String, default: 'Good' }, // Power supply (desktop/server)
    webcam: { type: String, default: 'Good' },
    
    // Service done
    workDone: { type: String, default: '' },
    serviceRate: { type: Number, default: 0 }, // per-PC rate
    
    // Photos (per PC)
    beforePhoto: { type: String, default: '' },
    afterPhoto: { type: String, default: '' },
    
    // Future requirements
    futureRequirements: [{ type: String }], // 'RAM Upgrade', 'SSD', 'Monitor', etc.
    remarks: { type: String, default: '' },
    healthSummary: { type: String, default: '' }, // Auto-generated English diagnostic summary
    overallStatus: { type: String, default: 'Good' } // Good, Needs Attention, Critical
}, { _id: true });

// Edit history entry
const editLogSchema = new mongoose.Schema({
    editedBy: { type: String, required: true },
    editedAt: { type: Date, default: Date.now },
    field: { type: String }, // which field/section changed
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    note: { type: String, default: '' }
}, { _id: true });

const corporateEntrySchema = new mongoose.Schema({
    // Entry meta
    entryNumber: { type: String, unique: true }, // SEA-CORP-0001
    agentName: { type: String, required: true },
    visitDate: { type: Date, default: Date.now },
    visitTime: { type: String, default: '10:00 AM' },
    
    // Customer details (entered ONCE for the whole office)
    customerName: { type: String, required: true }, // Contact person
    companyName: { type: String, default: '' },
    mobileNumber: { type: String, required: true },
    email: { type: String, default: '' },
    location: { type: String, required: true }, // Address
    gstNumber: { type: String, default: '' },
    
    // Multiple PCs
    pcs: [corporatePcSchema],
    
    // Booking source
    bookingRef: { type: String, default: '' }, // If from advance booking
    isAdvanceBooked: { type: Boolean, default: false },
    
    // Service summary
    serviceType: { type: String, default: 'Office Maintenance' },
    overallRemarks: { type: String, default: '' },
    futureRequirementsSummary: { type: String, default: '' }, // text summary
    
    // Billing
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    discountReason: { type: String, default: '' },
    gstPercent: { type: Number, default: 18 },
    gstAmount: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    
    amountReceived: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    paymentMode: { type: String, default: '' }, // Cash, UPI, Bank Transfer, Cheque, Pending
    paymentStatus: { type: String, default: 'Pending' }, // Pending, Partial, Paid
    paymentDate: { type: Date },
    paymentRef: { type: String, default: '' },
    
    // Verification
    gpsLatitude: { type: Number },
    gpsLongitude: { type: Number },
    gpsAccuracy: { type: Number }, // meters
    gpsAddress: { type: String, default: '' },
    gpsCapturedAt: { type: Date },
    
    customerToken: { type: String, default: '' }, // 4-digit token sent via WA
    customerTokenVerified: { type: Boolean, default: false },
    customerTokenVerifiedAt: { type: Date },
    
    // Travel
    kmTraveled: { type: Number, default: 0 },
    travelExpense: { type: Number, default: 0 },
    
    // Job status
    jobStatus: { type: String, default: 'Scheduled' }, // Scheduled, In Progress, Completed, Cancelled
    completedAt: { type: Date },
    
    // Edit history
    editLogs: [editLogSchema],
    
    // Post-payment edit lock + admin override token
    editLocked: { type: Boolean, default: false }, // becomes true after payment marked Paid
    editUnlockToken: { type: String, default: '' }, // 4-digit token admin generates to allow editing
    editUnlockTokenUsed: { type: Boolean, default: false },
    editUnlockedAt: { type: Date }, // when admin last unlocked for editing
    editUnlockedBy: { type: String, default: '' },
    postPaymentEdits: [{ // log of edits done AFTER payment (shown prominently at top)
        editedBy: { type: String },
        editedAt: { type: Date, default: Date.now },
        summary: { type: String },
        authorizedBy: { type: String } // admin who gave the token
    }],
    
    // Created/updated meta
    createdBy: { type: String, default: '' },
    lastModifiedBy: { type: String, default: '' }
}, { timestamps: true });


// Performance indexes
corporateEntrySchema.index({ agentName: 1, createdAt: -1 });
corporateEntrySchema.index({ mobileNumber: 1 });
corporateEntrySchema.index({ createdAt: -1 });
corporateEntrySchema.index({ paymentStatus: 1 });

module.exports = mongoose.model('CorporateEntry', corporateEntrySchema);
