const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    createdBy: { type: String, required: true },
    customerName: { type: String, required: true },
    mobileNumber: { type: String, required: true },
    location: { type: String, required: true },
    description: { type: String, required: true },
    requestPhoto: { type: String, default: '' },
    
    status: { type: String, default: 'Pending Vendor Pricing' },
    assignedAgent: { type: String, default: 'Pending' },
    whatsappSent: { type: Boolean, default: false },
    
    vendorName: { type: String, default: '' },
    costPrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    warranty: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
