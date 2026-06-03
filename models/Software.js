const mongoose = require('mongoose');

// Pricing rules for this software
const pricingRuleSchema = new mongoose.Schema({
    label: { type: String, required: true }, // 'Per Report', 'Monthly Maintenance', 'Per User License'
    unit: { type: String, default: 'unit' },
    rate: { type: Number, required: true },
    section: { type: String, default: 'A' }, // grouping in invoice
    isRecurring: { type: Boolean, default: false } // monthly fixed?
}, { _id: true });

// Clients using this software
const clientUsageSchema = new mongoose.Schema({
    clientName: { type: String, required: true },
    clientCompany: { type: String, default: '' },
    clientId: { type: String, default: '' },
    clientMobile: { type: String, default: '' },
    clientEmail: { type: String, default: '' },
    activatedDate: { type: Date, default: Date.now },
    
    // Custom pricing override?
    customRates: [pricingRuleSchema],
    
    status: { type: String, default: 'Active' }, // Active, Paused, Cancelled
    notes: { type: String, default: '' }
}, { _id: true, timestamps: true });

const softwareSchema = new mongoose.Schema({
    code: { type: String, unique: true, required: true }, // NAV, INV, POS, ERP
    name: { type: String, required: true }, // 'Navigene Genetic Reports System'
    description: { type: String, default: '' },
    category: { type: String, default: 'Custom Software' }, // Reports, Inventory, ERP, etc.
    
    // Default pricing for this software
    defaultPricing: [pricingRuleSchema],
    
    // Clients using this software
    clients: [clientUsageSchema],
    
    // Default invoice template settings
    invoiceTemplate: {
        primaryColor: { type: String, default: '#0f172a' },
        accentColor: { type: String, default: '#3b82f6' },
        showLogo: { type: Boolean, default: true },
        notesTemplate: { type: String, default: '' },
        termsTemplate: { type: String, default: '' }
    },
    
    // Stats
    totalInvoicesGenerated: { type: Number, default: 0 },
    totalRevenueEarned: { type: Number, default: 0 },
    
    status: { type: String, default: 'Active' }
}, { timestamps: true });

softwareSchema.index({ code: 1 });
softwareSchema.index({ status: 1 });

module.exports = mongoose.model('Software', softwareSchema);
