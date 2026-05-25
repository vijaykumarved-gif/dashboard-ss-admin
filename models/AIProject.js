const mongoose = require('mongoose');

// One-time cost entry (server setup, API charges for a phase, etc.)
const costEntrySchema = new mongoose.Schema({
    category: { type: String, required: true }, // Server, AI/API, Development, Tools, Misc
    description: { type: String, default: '' },
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now }
}, { _id: true });

// Recurring monthly cost (server hosting, API subscriptions)
const recurringCostSchema = new mongoose.Schema({
    name: { type: String, required: true }, // e.g. "AWS Server", "OpenAI API"
    category: { type: String, default: 'Server' }, // Server, AI/API, Tools, Other
    monthlyAmount: { type: Number, required: true },
    startDate: { type: Date, default: Date.now },
    active: { type: Boolean, default: true }
}, { _id: true });

// Revenue/payment received entry
const revenueEntrySchema = new mongoose.Schema({
    description: { type: String, default: 'Payment' }, // e.g. "Advance", "Milestone 1", "Monthly fee"
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now }
}, { _id: true });

const aiProjectSchema = new mongoose.Schema({
    projectName: { type: String, required: true },
    clientName: { type: String, required: true },
    clientMobile: { type: String, default: '' },
    clientEmail: { type: String, default: '' },
    
    projectType: { type: String, default: 'AI Software' }, // AI Software, Chatbot, Automation, etc.
    description: { type: String, default: '' },
    
    // Pricing
    totalQuotedPrice: { type: Number, default: 0 },
    billingType: { type: String, default: 'One-Time' }, // One-Time, Monthly, Milestone
    
    // Tracking
    status: { type: String, default: 'In Progress' }, // Planning, In Progress, Testing, Delivered, On Hold, Cancelled
    startDate: { type: Date, default: Date.now },
    deliveryDate: { type: Date },
    
    // Sub-collections
    costs: [costEntrySchema],
    recurringCosts: [recurringCostSchema],
    revenues: [revenueEntrySchema],
    
    notes: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('AIProject', aiProjectSchema);
