const mongoose = require('mongoose');

// Issue/Return log
const issueLogSchema = new mongoose.Schema({
    issuedTo: { type: String, required: true }, // agent username
    issuedDate: { type: Date, default: Date.now },
    quantity: { type: Number, default: 1 },
    purpose: { type: String, default: '' }, // job description, site name
    
    // Return tracking
    expectedReturnDate: { type: Date },
    returnedDate: { type: Date },
    returnedQuantity: { type: Number, default: 0 },
    returnCondition: { type: String, default: '' }, // Good, Damaged, Lost
    
    status: { type: String, default: 'Issued' }, // Issued, Returned, Lost, Damaged
    notes: { type: String, default: '' }
}, { _id: true });

// Maintenance entry
const toolMaintenanceSchema = new mongoose.Schema({
    type: { type: String, default: 'Repair' }, // Repair, Service, Calibration, Replacement
    description: { type: String, default: '' },
    cost: { type: Number, default: 0 },
    date: { type: Date, default: Date.now },
    handledBy: { type: String, default: '' }
}, { _id: true });

const toolSchema = new mongoose.Schema({
    toolName: { type: String, required: true },
    category: { type: String, default: 'General' }, // Hardware Tool, Software, Equipment, Diagnostic, Laptop
    brand: { type: String, default: '' },
    model: { type: String, default: '' },
    serialNumber: { type: String, default: '' },
    
    // Purchase info
    purchaseDate: { type: Date, default: Date.now },
    purchaseCost: { type: Number, default: 0 },
    purchasedFrom: { type: String, default: '' }, // vendor name
    warranty: { type: String, default: '' },
    warrantyExpiry: { type: Date },
    
    // Status
    quantity: { type: Number, default: 1 }, // total owned
    availableQuantity: { type: Number, default: 1 }, // not currently issued
    
    condition: { type: String, default: 'Good' }, // Good, Working, Needs Repair, Damaged, Lost
    location: { type: String, default: 'Office Store' },
    
    // Tracking
    issueLogs: [issueLogSchema],
    maintenanceLogs: [toolMaintenanceSchema],
    
    notes: { type: String, default: '' },
    photo: { type: String, default: '' }
}, { timestamps: true });

// Virtual: total maintenance cost
toolSchema.virtual('totalMaintenanceCost').get(function() {
    return (this.maintenanceLogs || []).reduce((s, m) => s + (m.cost || 0), 0);
});

// Virtual: total investment
toolSchema.virtual('totalInvestment').get(function() {
    return (this.purchaseCost || 0) + this.totalMaintenanceCost;
});

toolSchema.set('toJSON', { virtuals: true });
toolSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Tool', toolSchema);
