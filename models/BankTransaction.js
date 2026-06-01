const mongoose = require('mongoose');

const bankTransactionSchema = new mongoose.Schema({
    // From bank statement
    transactionDate: { type: Date, required: true },
    description: { type: String, default: '' },
    referenceNumber: { type: String, default: '' },
    
    // Amount
    type: { type: String, required: true }, // CREDIT, DEBIT
    amount: { type: Number, required: true },
    balance: { type: Number, default: 0 },
    
    // Bank info
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    
    // Matching status
    matchStatus: { type: String, default: 'Unmatched' }, // Unmatched, Matched, Manual, Ignored
    matchedTo: { type: String, default: '' }, // 'Entry', 'CorporateEntry', 'VendorPayment', 'Salary', 'Expense'
    matchedRefId: { type: String, default: '' }, // ID of matched record
    matchConfidence: { type: Number, default: 0 }, // 0-100, auto-match score
    matchedAt: { type: Date },
    matchedBy: { type: String, default: '' },
    
    category: { type: String, default: 'Uncategorized' }, // Sales, Vendor Payment, Salary, Misc Expense, Refund, Transfer
    notes: { type: String, default: '' }
}, { timestamps: true });

// Indexes for fast search
bankTransactionSchema.index({ transactionDate: -1 });
bankTransactionSchema.index({ matchStatus: 1 });
bankTransactionSchema.index({ amount: 1, type: 1 });

module.exports = mongoose.model('BankTransaction', bankTransactionSchema);
