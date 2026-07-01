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
    
    status: { type: String, default: 'Draft' }, // Draft, Sent, Approved, Rejected, Expired, Converted
    
    // Approval lifecycle tracking
    sentAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: { type: String, default: '' }, // who marked it approved
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
    
    // What happens after approval - convert to order/service
    advanceReceived: { type: Number, default: 0 },
    advanceDate: { type: Date },
    advanceMode: { type: String, default: '' },
    finalPaymentReceived: { type: Number, default: 0 },
    paymentStatus: { type: String, default: 'Pending' }, // Pending, Advance Paid, Fully Paid
    deliveryStatus: { type: String, default: 'Not Started' }, // Not Started, In Progress, Delivered
    deliveredAt: { type: Date },
    
    // Link back to customer
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    
    // === VENDOR PROCUREMENT (after approval) ===
    vendorProcurement: [{
        vendorName: { type: String },
        vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
        productName: { type: String },
        quantity: { type: Number, default: 1 },
        vendorPrice: { type: Number, default: 0 }, // what we pay vendor per unit
        deliveryCharges: { type: Number, default: 0 },
        totalVendorCost: { type: Number, default: 0 }, // (qty*price)+delivery
        paymentToVendor: { type: Number, default: 0 }, // paid to vendor so far
        vendorPaymentStatus: { type: String, default: 'Pending' }, // Pending, Partial, Paid
        deliveryStatus: { type: String, default: 'Ordered' }, // Ordered, In Transit, Received
        expectedDelivery: { type: Date },
        receivedDate: { type: Date },
        notes: { type: String, default: '' }
    }],
    totalVendorCost: { type: Number, default: 0 }, // sum of all vendor costs
    totalVendorPaid: { type: Number, default: 0 },
    grossProfit: { type: Number, default: 0 }, // grandTotal - totalVendorCost
    
    // Remark for tracking
    remark: { type: String, default: '' },
    
    createdBy: { type: String, default: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('Quotation', quotationSchema);
