const mongoose = require('mongoose');

// Individual PC/System under an AMC office
const amcPcSchema = new mongoose.Schema({
    pcId: { type: String, required: true }, // e.g. "PC-01", "LAP-05"
    pcType: { type: String, default: 'Desktop' }, // Desktop, Laptop, Server, AIO
    pcModel: { type: String, default: '' },
    user: { type: String, default: '' }, // Jis employee ka hai
    department: { type: String, default: '' },
    
    // Pricing
    ratePerPC: { type: Number, default: 0 }, // monthly/yearly rate per PC
    
    // Latest health status
    overallStatus: { type: String, default: 'Healthy' }, // Healthy, Issues, Critical
    
    // Component status (same as Entry)
    motherboard: { type: String, default: 'Good' },
    cpu: { type: String, default: 'Good' },
    ramStatus: { type: String, default: 'Good' },
    hddHealth: { type: String, default: 'Good' },
    fan: { type: String, default: 'Good' },
    temperature: { type: String, default: 'Normal' },
    battery: { type: String, default: 'Good' },
    monitor: { type: String, default: 'Good' },
    
    // Suggested upgrades (auto-determined from status)
    suggestions: [{ type: String }], // e.g. ['RAM Upgrade', 'SSD Upgrade', 'Cooling Fix']
    
    // Photos
    beforePhoto: { type: String, default: '' },
    afterPhoto: { type: String, default: '' },
    
    // Last service
    lastServicedDate: { type: Date },
    lastServicedBy: { type: String, default: '' },
    remarks: { type: String, default: '' }
}, { _id: true, timestamps: true });

// Per-PC service log within a visit
const pcServiceLogSchema = new mongoose.Schema({
    pcId: { type: String, required: true }, // matches amcPcSchema.pcId
    pcDocId: { type: String, default: '' }, // _id reference for lookup
    
    // Was this PC under AMC contract?
    isUnderAMC: { type: Boolean, default: true },
    
    // Service work done
    workDone: { type: String, default: '' }, // e.g. "Cleaned dust, RAM upgrade installed"
    
    // Component status after service (latest snapshot)
    motherboard: { type: String, default: 'Good' },
    cpu: { type: String, default: 'Good' },
    ramStatus: { type: String, default: 'Good' },
    hddHealth: { type: String, default: 'Good' },
    fan: { type: String, default: 'Good' },
    temperature: { type: String, default: 'Normal' },
    battery: { type: String, default: 'Good' },
    monitor: { type: String, default: 'Good' },
    
    // Extra work / out-of-contract charges
    extraWorkDescription: { type: String, default: '' },
    extraWorkAmount: { type: Number, default: 0 },
    
    // Photos
    beforePhoto: { type: String, default: '' },
    afterPhoto: { type: String, default: '' },
    
    serviceComplete: { type: Boolean, default: false },
    servicedAt: { type: Date }
}, { _id: true });

// Visit schedule entry
const amcVisitSchema = new mongoose.Schema({
    visitDate: { type: Date, required: true },
    visitTime: { type: String, default: '10:00 AM' },
    assignedAgent: { type: String, required: true }, // vijay/rahul
    
    purpose: { type: String, default: 'Monthly Maintenance' }, // Monthly, Quarterly, On-Demand, Emergency
    pcsToService: [{ type: String }], // Array of pcId from amcPcSchema (planned)
    
    status: { type: String, default: 'Scheduled' }, // Scheduled, In Progress, Completed, Missed, Rescheduled
    notificationSent: { type: Boolean, default: false }, // WA notification sent
    
    // Per-PC service logs (filled during visit)
    pcServiceLogs: [pcServiceLogSchema],
    
    // Visit billing
    extraBillAmount: { type: Number, default: 0 }, // sum of all extraWorkAmount
    
    // After visit
    startedAt: { type: Date },
    completedAt: { type: Date },
    visitSummary: { type: String, default: '' }, // overall notes by agent
    notes: { type: String, default: '' }
}, { _id: true, timestamps: true });

// Payment received entry
const amcPaymentSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    paidDate: { type: Date, default: Date.now },
    paymentMode: { type: String, default: 'Bank Transfer' },
    invoiceNumber: { type: String, default: '' },
    notes: { type: String, default: '' }
}, { _id: true });

// Expense entry per office
const amcExpenseSchema = new mongoose.Schema({
    category: { type: String, default: 'Misc' }, // Travel, Parts, Tools, Labor, Misc
    description: { type: String, default: '' },
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now }
}, { _id: true });

const amcOfficeSchema = new mongoose.Schema({
    officeName: { type: String, required: true },
    companyName: { type: String, default: '' },
    contactPerson: { type: String, required: true },
    contactMobile: { type: String, required: true },
    contactEmail: { type: String, default: '' },
    address: { type: String, default: '' },
    
    // AMC Contract details
    contractStartDate: { type: Date, default: Date.now },
    contractEndDate: { type: Date },
    contractType: { type: String, default: 'Monthly' }, // Monthly, Quarterly, Annual
    
    // Pricing
    monthlyFee: { type: Number, default: 0 }, // Total monthly fee
    visitsPerMonth: { type: Number, default: 1 }, // Default visits per month
    
    // Tracking
    status: { type: String, default: 'Active' }, // Active, Paused, Expired, Cancelled
    
    // Sub-collections
    pcs: [amcPcSchema],
    visits: [amcVisitSchema],
    payments: [amcPaymentSchema],
    expenses: [amcExpenseSchema],
    
    notes: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('AMCOffice', amcOfficeSchema);
