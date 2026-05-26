const mongoose = require('mongoose');

// Stock movement log (every IN/OUT recorded)
const stockMovementSchema = new mongoose.Schema({
    type: { type: String, required: true }, // IN, OUT, ADJUSTMENT
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    totalValue: { type: Number, default: 0 },
    
    // Where did this come from / go to?
    source: { type: String, default: '' }, // 'Vendor Bill', 'Sale', 'Quotation', 'Manual', 'Damage'
    sourceRef: { type: String, default: '' }, // Bill number, invoice number, etc.
    
    // Tracking
    handledBy: { type: String, required: true }, // who took out / added
    clientName: { type: String, default: '' }, // if OUT to client
    notes: { type: String, default: '' },
    
    serialNumbers: [{ type: String }],
    movementDate: { type: Date, default: Date.now }
}, { _id: true });

const stockItemSchema = new mongoose.Schema({
    productName: { type: String, required: true },
    productCode: { type: String, default: '' }, // SKU
    category: { type: String, default: 'General' }, // Camera, DVR, Cable, RAM, etc.
    brand: { type: String, default: '' },
    model: { type: String, default: '' },
    specifications: { type: String, default: '' },
    unit: { type: String, default: 'Pcs' }, // Pcs, Meter, Roll, Set
    
    // Stock levels
    currentStock: { type: Number, default: 0 },
    minStockLevel: { type: Number, default: 1 }, // alert if below
    
    // Pricing (latest)
    avgCostPrice: { type: Number, default: 0 }, // weighted avg
    lastCostPrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    
    // Vendor info
    primaryVendor: { type: String, default: '' },
    vendorRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' }],
    
    gstPercent: { type: Number, default: 18 },
    hsnCode: { type: String, default: '' },
    
    // Serial numbers currently in stock
    serialNumbers: [{ type: String }],
    
    // All movements (audit trail)
    movements: [stockMovementSchema],
    
    location: { type: String, default: 'Main Store' },
    notes: { type: String, default: '' }
}, { timestamps: true });

// Virtual: total stock value
stockItemSchema.virtual('totalValue').get(function() {
    return this.currentStock * (this.avgCostPrice || this.lastCostPrice);
});

stockItemSchema.set('toJSON', { virtuals: true });
stockItemSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('StockItem', stockItemSchema);
