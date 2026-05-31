const mongoose = require('mongoose');

// Edit history entry
const editLogSchema = new mongoose.Schema({
    editedBy: { type: String, required: true },
    editedAt: { type: Date, default: Date.now },
    field: { type: String },
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    note: { type: String, default: '' }
}, { _id: true });

const entrySchema = new mongoose.Schema({
    agentName: { type: String, required: true },
    customerName: { type: String, required: true },
    mobileNumber: { type: String, required: true },
    location: { type: String, required: true },
    
    jobStatus: { type: String, default: 'Completed' },
    whatsappSent: { type: Boolean, default: false },
    
    serviceTaken: { type: String, default: '79 System Service' },
    interestedServices: [{ type: String }],
    followUpDate: { type: Date },
    callStatus: { type: String, default: 'Pending' }, 
    conversionStatus: { type: String, default: 'Pending' }, 
    paymentMode: { type: String },
    isCompleted: { type: Boolean, default: false },
    revenue: { type: Number, default: 0 }, 
    
    // Discount + Due
    discount: { type: Number, default: 0 },
    discountReason: { type: String, default: '' },
    amountReceived: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    paymentStatus: { type: String, default: 'Paid' }, // Pending, Partial, Paid
    
    kmTraveled: { type: Number, default: 0 },
    travelExpense: { type: Number, default: 0 },

    pcModel: { type: String, default: 'N/A' },
    pcType: { type: String, default: 'Desktop' }, // PC, Laptop, AIO
    serialNumber: { type: String, default: '' },
    
    cpu: { type: String, default: 'Good' },
    motherboard: { type: String, default: 'Good' },
    ramStatus: { type: String, default: 'Good' },
    ramSlot: { type: String, default: 'Good' },
    hddHealth: { type: String, default: 'Good' },
    drive: { type: String, default: 'Good' },
    fan: { type: String, default: 'Good' },
    temperature: { type: String, default: 'Normal' },
    connectors: { type: String, default: 'Good' },
    battery: { type: String, default: 'Good' },
    charger: { type: String, default: 'Good' },
    powerCable: { type: String, default: 'Good' },
    monitor: { type: String, default: 'Good' },
    webcam: { type: String, default: 'Good' },
    remarks: { type: String, default: 'System running normally.' },
    
    // Photos
    proofPhoto: { type: String, default: '' },
    beforePhoto: { type: String, default: '' },
    afterPhoto: { type: String, default: '' },
    
    // GPS verification
    gpsLatitude: { type: Number },
    gpsLongitude: { type: Number },
    gpsAccuracy: { type: Number },
    gpsAddress: { type: String, default: '' },
    gpsCapturedAt: { type: Date },
    
    // Customer token verification
    customerToken: { type: String, default: '' },
    customerTokenVerified: { type: Boolean, default: false },
    customerTokenVerifiedAt: { type: Date },
    
    // Booking link
    bookingRef: { type: String, default: '' },
    
    // Future requirements
    futureRequirements: [{ type: String }],
    
    // Edit logs
    editLogs: [editLogSchema],
    lastModifiedBy: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Entry', entrySchema);
