const mongoose = require('mongoose');

const quotationItemSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'CCTVProduct' },
    productName: { type: String, required: true },
    specifications: { type: String, default: '' },
    warranty: { type: String, default: '1 Year' }, // per-item warranty
    quantity: { type: Number, required: true, default: 1 },
    unit: { type: String, default: 'Pcs' },
    unitPrice: { type: Number, required: true },
    gstPercent: { type: Number, default: 18 },
    total: { type: Number, required: true } // (quantity * unitPrice) + gst
}, { _id: true });

const quotationSchema = new mongoose.Schema({
    quotationNumber: { type: String, required: true, unique: true }, // SEA-Q-001 format
    
    clientName: { type: String, required: true },
    clientCompany: { type: String, default: '' },
    clientMobile: { type: String, default: '' },
    clientEmail: { type: String, default: '' },
    clientAddress: { type: String, default: '' },
    
    projectType: { type: String, default: 'CCTV Installation' }, // CCTV Installation, Biometric, AMC, Other
    siteLocation: { type: String, default: '' },
    
    items: [quotationItemSchema],
    
    subtotal: { type: Number, default: 0 }, // sum of (qty * unitPrice)
    gstAmount: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    
    installationCharges: { type: Number, default: 0 },
    
    validityDays: { type: Number, default: 15 },
    paymentTerms: { type: String, default: '50% advance, 50% on completion' },
    warranty: { type: String, default: '1 Year Manufacturer Warranty' },
    notes: { type: String, default: '' },
    
    status: { type: String, default: 'Draft' }, // Draft, Sent, Approved, Rejected, Expired
    
    createdBy: { type: String, default: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('Quotation', quotationSchema);
