const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
    agentName: { type: String, required: true },
    customerName: { type: String, required: true },
    mobileNumber: { type: String, required: true },
    location: { type: String, required: true },
    
    jobStatus: { type: String, default: 'Completed' },
    whatsappSent: { type: Boolean, default: false },
    
    serviceTaken: { type: String, default: '79 System Service' },
    interestedServices: [{ type: String }],
    followUpDate: { type: Date },
    callStatus: { type: String, default: 'Pending' }, 
    conversionStatus: { type: String, default: 'Pending' }, 
    paymentMode: { type: String },
    isCompleted: { type: Boolean, default: false },
    revenue: { type: Number, default: 0 }, 
    
    kmTraveled: { type: Number, default: 0 },
    travelExpense: { type: Number, default: 0 },

    pcModel: { type: String, default: 'N/A' },
    cpu: { type: String, default: 'Good' },
    motherboard: { type: String, default: 'Good' },
    ramStatus: { type: String, default: 'Good' },
    ramSlot: { type: String, default: 'Good' },
    hddHealth: { type: String, default: 'Good' },
    drive: { type: String, default: 'Good' },
    fan: { type: String, default: 'Good' },
    temperature: { type: String, default: 'Normal' },
    connectors: { type: String, default: 'Good' },
    battery: { type: String, default: 'Good' },
    charger: { type: String, default: 'Good' },
    powerCable: { type: String, default: 'Good' },
    monitor: { type: String, default: 'Good' },
    webcam: { type: String, default: 'Good' },
    remarks: { type: String, default: 'System running normally.' },
    proofPhoto: { type: String, default: '' } 
}, { timestamps: true });

module.exports = mongoose.model('Entry', entrySchema);
