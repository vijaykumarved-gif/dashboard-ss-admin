const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    mobile: { type: String, required: true, index: true },
    
    // Could be company or individual
    type: { type: String, default: 'Individual' }, // Individual, Corporate
    companyName: { type: String, default: '' },
    email: { type: String, default: '' },
    
    // Addresses
    primaryAddress: { type: String, default: '' },
    altAddresses: [{ type: String }],
    location: { type: String, default: '' }, // City/Area
    
    // GST
    gstNumber: { type: String, default: '' },
    
    // History summary
    totalServices: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalDue: { type: Number, default: 0 },
    lastServiceDate: { type: Date },
    
    // Customer tier
    customerType: { type: String, default: 'Standard' }, // VIP, Standard, New
    rating: { type: Number, default: 0 },
    
    // Notes
    preferences: { type: String, default: '' },
    notes: { type: String, default: '' },
    
    // Auto-source
    sourceModule: { type: String, default: '' } // Hardware, AMC, CCTV, Lead, Corporate, Booking
}, { timestamps: true });

// Indexes for autocomplete search
customerSchema.index({ mobile: 1 });
customerSchema.index({ name: 'text', companyName: 'text', mobile: 'text' });

module.exports = mongoose.model('Customer', customerSchema);
