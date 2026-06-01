const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
    type: { type: String, default: 'image' }, // image, pdf, file
    fileName: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },
    mimeType: { type: String, default: '' },
    data: { type: String, default: '' } // base64 data URL
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
    // Conversation = pair of usernames sorted alphabetically (e.g. "admin_vijay")
    conversationId: { type: String, required: true, index: true },
    
    sender: { type: String, required: true }, // username
    receiver: { type: String, required: true },
    
    text: { type: String, default: '' },
    attachments: [attachmentSchema],
    
    // Status
    read: { type: Boolean, default: false },
    readAt: { type: Date },
    delivered: { type: Boolean, default: true },
    
    // Reactions / system
    isSystem: { type: Boolean, default: false }, // system notifications
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }
}, { timestamps: true });

chatMessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
