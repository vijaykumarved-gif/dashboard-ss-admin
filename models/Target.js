const mongoose = require('mongoose');

const targetSchema = new mongoose.Schema({
    dailyTarget: { type: Number, default: 10000 },
    weeklyTarget: { type: Number, default: 70000 },
    monthlyTarget: { type: Number, default: 300000 }
}, { timestamps: true });

module.exports = mongoose.model('Target', targetSchema);
