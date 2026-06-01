const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    bookingNumber: { type: String, unique: true }, // SEA-BK-0001
    
    // Customer
    customerName: { type: String, required: true },
    companyName: { type: String, default: '' },
    mobileNumber: { type: String, required: true },
    email: { type: String, default: '' },
    location: { type: String, required: true },
    
    // Booking details
    bookingType: { type: String, default: 'Single PC' }, // Single PC, Corporate Office, AMC Visit
    serviceType: { type: String, default: '79 System Service' },
    description: { type: String, default: '' },
    
    // Schedule
    scheduledDate: { type: Date, required: true },
    scheduledTime: { type: String, default: '10:00 AM' },
    estimatedDuration: { type: String, default: '1 hour' },
    
    // Assignment
    assignedAgent: { type: String, default: '' }, // vijay/rahul/admin
    
    // Status
    status: { type: String, default: 'Pending' }, // Pending, Confirmed, In Progress, Completed, Cancelled, Missed
    
    // Numbers for corporate
    numberOfPCs: { type: Number, default: 1 },
    estimatedValue: { type: Number, default: 0 },
    
    // Booked by
    bookedBy: { type: String, required: true }, // admin/vijay/rahul/customer
    bookingSource: { type: String, default: 'Internal' }, // Internal, Phone, WhatsApp, Website
    
    // Confirmation
    confirmationSent: { type: Boolean, default: false },
    confirmationDate: { type: Date },
    
    // Completion link
    completedEntryId: { type: String, default: '' }, // Reference to Entry or CorporateEntry
    completedAt: { type: Date },
    
    notes: { type: String, default: '' }
}, { timestamps: true });


// Performance indexes
bookingSchema.index({ scheduledDate: 1, status: 1 });
bookingSchema.index({ assignedAgent: 1 });
bookingSchema.index({ mobileNumber: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
