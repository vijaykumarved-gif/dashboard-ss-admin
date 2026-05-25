const mongoose = require('mongoose');

const otherBusinessSchema = new mongoose.Schema({
    workTitle: { type: String, required: true },
    workCategory: { type: String, default: 'Miscellaneous' },
    
    clientName: { type: String, required: true },
    clientMobile: { type: String, default: '' },
    
    description: { type: String, default: '' },
    
    revenue: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    
    status: { type: String, default: 'In Progress' }, // In Progress, Completed, Cancelled
    workDate: { type: Date, default: Date.now },
    
    notes: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('OtherBusiness', otherBusinessSchema);
