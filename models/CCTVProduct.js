const mongoose = require('mongoose');

const cctvProductSchema = new mongoose.Schema({
    productName: { type: String, required: true },
    category: { type: String, required: true }, // Camera, DVR/NVR, Cable, Storage, Biometric, Accessory, Installation
    brand: { type: String, default: '' },
    model: { type: String, default: '' },
    
    specifications: { type: String, default: '' }, // 2MP IR Bullet, 8 Channel, etc.
    unit: { type: String, default: 'Pcs' }, // Pcs, Meter, Roll, Hour
    
    costPrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, required: true },
    
    hsnCode: { type: String, default: '' },
    gstPercent: { type: Number, default: 18 },
    
    inStock: { type: Boolean, default: true },
    notes: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('CCTVProduct', cctvProductSchema);
