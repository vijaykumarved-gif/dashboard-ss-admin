const mongoose = require('mongoose');

// Each line item in invoice
const invoiceItemSchema = new mongoose.Schema({
    section: { type: String, default: 'A' }, // A, B, C for grouping
    sectionTitle: { type: String, default: '' }, // 'Software Reports', 'Maintenance Charges'
    
    description: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    unit: { type: String, default: 'unit' }, // reports, months, hours, license
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }, // qty × rate
    
    // For per-date entries (like Navigene daily reports)
    itemDate: { type: Date },
    
    notes: { type: String, default: '' }
}, { _id: true });

const softwareInvoiceSchema = new mongoose.Schema({
    invoiceNumber: { type: String, unique: true, index: true }, // SEA-INV-2026-XXX-NN
    
    // === SOFTWARE / PRODUCT info ===
    softwareName: { type: String, required: true }, // 'Navigene Reports System', 'Inventory App', etc.
    softwareCode: { type: String, default: '' }, // Short code: NAV, INV, etc.
    softwareDescription: { type: String, default: '' },
    
    // === CLIENT info ===
    clientName: { type: String, required: true },
    clientCompany: { type: String, default: '' },
    clientId: { type: String, default: '' }, // Lab ID, Customer ID, etc.
    clientMobile: { type: String, default: '' },
    clientEmail: { type: String, default: '' },
    clientAddress: { type: String, default: '' },
    clientGST: { type: String, default: '' },
    
    // === INVOICE meta ===
    invoiceDate: { type: Date, default: Date.now },
    dueDate: { type: Date },
    billingPeriodFrom: { type: Date },
    billingPeriodTo: { type: Date },
    billingPeriodLabel: { type: String, default: '' }, // 'April - May 2026'
    
    // === Line items ===
    items: [invoiceItemSchema],
    
    // === Totals ===
    subtotal: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 }, // 0 for non-GST
    gstAmount: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    amountInWords: { type: String, default: '' },
    
    // === Payment ===
    status: { type: String, default: 'Payment Due' }, // Payment Due, Partial Paid, Fully Paid, Cancelled
    paymentDate: { type: Date },
    amountReceived: { type: Number, default: 0 },
    paymentMode: { type: String, default: '' }, // UPI, Bank Transfer, Cheque, Cash
    paymentReference: { type: String, default: '' },
    paymentNotes: { type: String, default: '' },
    
    // === Bank receiving payment ===
    receivingBank: { type: String, default: 'IndusInd Bank' },
    receivingAccount: { type: String, default: '157984959275' },
    receivingIFSC: { type: String, default: 'INDB0000622' },
    receivingAccountName: { type: String, default: 'Vijay Ved' },
    
    // === Audit ===
    createdBy: { type: String, default: '' },
    pdfGenerated: { type: Boolean, default: false },
    pdfGeneratedAt: { type: Date },
    
    notes: { type: String, default: '' },
    termsAndConditions: { type: String, default: '' }
}, { timestamps: true });

// Auto-compute totals before save
softwareInvoiceSchema.pre('save', function(next) {
    // Compute item amounts
    this.items.forEach(item => {
        item.amount = (item.quantity || 0) * (item.rate || 0);
    });
    
    // Subtotal
    this.subtotal = this.items.reduce((s, i) => s + (i.amount || 0), 0);
    
    // GST
    this.gstAmount = (this.subtotal * (this.gstPercent || 0)) / 100;
    
    // Grand total
    this.grandTotal = this.subtotal + this.gstAmount - (this.discount || 0);
    
    next();
});

// Indexes
softwareInvoiceSchema.index({ clientName: 1, invoiceDate: -1 });
softwareInvoiceSchema.index({ softwareCode: 1, invoiceDate: -1 });
softwareInvoiceSchema.index({ status: 1 });

module.exports = mongoose.model('SoftwareInvoice', softwareInvoiceSchema);
