const mongoose = require('mongoose');

// Item line in a vendor bill
const billItemSchema = new mongoose.Schema({
    productName: { type: String, required: true },
    description: { type: String, default: '' },
    category: { type: String, default: '' }, // Camera, Cable, RAM, etc.
    
    quantity: { type: Number, required: true, default: 1 },
    unit: { type: String, default: 'Pcs' },
    unitCost: { type: Number, required: true },
    gstPercent: { type: Number, default: 18 },
    totalCost: { type: Number, default: 0 }, // qty*cost + gst
    
    // Sales tracking
    sellingPrice: { type: Number, default: 0 }, // What we'll sell at
    warranty: { type: String, default: '' },
    
    // Serial numbers (one entry per piece if needed)
    serialNumbers: [{ type: String }],
    
    // Stock link - which Stock master this item created/added to
    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem' },
    
    // Sale tracking - jab sell hua kis client ko
    soldTo: [{ 
        clientName: String,
        clientMobile: String,
        quantity: Number,
        saleDate: { type: Date, default: Date.now },
        salePrice: Number,
        invoiceRef: String
    }]
}, { _id: true });

// Vendor bill
const vendorBillSchema = new mongoose.Schema({
    billNumber: { type: String, required: true }, // Vendor's bill number
    billDate: { type: Date, default: Date.now },
    deliveryDate: { type: Date },
    
    items: [billItemSchema],
    
    subtotal: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    
    paid: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    paymentStatus: { type: String, default: 'Unpaid' }, // Unpaid, Partial, Paid
    
    // Uploaded bill image/PDF (base64 data URL)
    billDocument: { type: String, default: '' },
    
    notes: { type: String, default: '' },
    receivedBy: { type: String, default: '' } // who received the items
}, { _id: true, timestamps: true });

// Payment to vendor
const vendorPaymentSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    paymentDate: { type: Date, default: Date.now },
    paymentMode: { type: String, default: 'Bank Transfer' },
    transactionRef: { type: String, default: '' },
    billRef: { type: String, default: '' }, // Which bill this payment is for
    notes: { type: String, default: '' }
}, { _id: true });

const vendorSchema = new mongoose.Schema({
    vendorName: { type: String, required: true },
    contactPerson: { type: String, default: '' },
    mobile: { type: String, default: '' },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    
    gstNumber: { type: String, default: '' },
    panNumber: { type: String, default: '' },
    
    // Bank details
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    
    category: { type: String, default: 'Mixed' }, // CCTV, Hardware, Software, Mixed
    
    bills: [vendorBillSchema],
    payments: [vendorPaymentSchema],
    
    status: { type: String, default: 'Active' }, // Active, Inactive, Blacklisted
    notes: { type: String, default: '' }
}, { timestamps: true });


// Performance indexes
vendorSchema.index({ vendorName: 1 });
vendorSchema.index({ status: 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
