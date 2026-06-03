require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const exceljs = require('exceljs');
const PDFDocument = require('pdfkit');
const compression = require('compression');

// Models
const Entry = require('./models/Entry');
const Target = require('./models/Target');
const Order = require('./models/Order');
const AIProject = require('./models/AIProject');
const CCTVProduct = require('./models/CCTVProduct');
const Quotation = require('./models/Quotation');
const OtherBusiness = require('./models/OtherBusiness');
const AMCOffice = require('./models/AMCOffice');
const Vendor = require('./models/Vendor');
const StockItem = require('./models/StockItem');
const Tool = require('./models/Tool');
const Lead = require('./models/Lead');
const CorporateEntry = require('./models/CorporateEntry');
const Booking = require('./models/Booking');
const Employee = require('./models/Employee');
const BankTransaction = require('./models/BankTransaction');
const Customer = require('./models/Customer');
const ChatMessage = require('./models/ChatMessage');
const Software = require('./models/Software');
const SoftwareInvoice = require('./models/SoftwareInvoice');
const { generateSoftwareInvoicePDF, numberToWords } = require('./utils/invoiceGenerator');

const app = express();

// === PERFORMANCE: gzip compression (5-10x faster page transfers) ===
app.use(compression({
    level: 6,
    threshold: 1024, // only compress > 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

app.set('view engine', 'ejs');
// Disable view caching only in dev; production cache views in memory
app.set('view cache', true);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Static files with aggressive cache (1 day for images, 1 hour for css/js)
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
        if (path.endsWith('.css') || path.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
        } else if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.ico')) {
            res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        }
    }
}));

app.use(session({
    secret: process.env.SESSION_SECRET || 'searvator_secret_key_123',
    resave: false,
    saveUninitialized: false
}));

// EJS template helpers
app.locals.formatINR = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
app.locals.formatDate = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/searvator')
    .then(() => console.log('MongoDB Connected successfully'))
    .catch(err => console.log('DB Error:', err));

// ============ AUTH ============
const requireAuth = (req, res, next) => { if (req.session.user) next(); else res.redirect('/login'); };

// Detect if request is from a mobile device or PWA standalone
function isMobileOrPWA(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    if (/iphone|ipad|ipod|android|mobile|webos|blackberry|opera mini|iemobile/i.test(ua)) return true;
    // PWA standalone or in-app browsers (via display-mode media query won't work server-side, accept WebView UAs)
    if (/wv|standalone/i.test(ua)) return true;
    return false;
}

app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
        req.session.user = { username, role: 'admin' };
        res.redirect('/admin');
    } else if (username === 'vijay' || username === 'rahul') {
        req.session.user = { username, role: 'agent' };
        res.redirect('/agent');
    } else {
        res.send('Invalid Credentials');
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ============ AGENT DASHBOARD ============
app.get('/agent', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    
    // If agent on desktop & not bypassed, show install prompt
    if (!isMobileOrPWA(req) && !req.query.desktop) {
        return res.render('agent-desktop-warning', { user: req.session.user });
    }
    
    let queryDate = new Date();
    if (req.query.date) queryDate = new Date(req.query.date);
    const startOfDay = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0);
    const endOfDay = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59);

    const pendingJobs = await Entry.find({ agentName: req.session.user.username, jobStatus: 'Assigned' }).sort({ createdAt: 1 });
    const entries = await Entry.find({
        agentName: req.session.user.username,
        jobStatus: 'Completed',
        createdAt: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ createdAt: -1 });
    const orders = await Order.find({
        $or: [{ createdBy: req.session.user.username }, { assignedAgent: req.session.user.username }]
    }).sort({ createdAt: -1 });
    
    // === Leads info ===
    const myNewLeads = await Lead.find({ 
        assignedTo: req.session.user.username, 
        agentSeenAt: null,
        status: { $nin: ['Won', 'Lost'] }
    }).sort({ createdAt: -1 }).limit(5).lean();
    const myInProgressLeads = await Lead.countDocuments({
        assignedTo: req.session.user.username,
        agentSeenAt: { $ne: null },
        status: { $nin: ['Won', 'Lost'] }
    });
    
    // === Today's bookings for this agent ===
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const weekEnd = new Date(todayStart); weekEnd.setDate(weekEnd.getDate() + 7);
    
    const myTodayBookings = await Booking.find({
        assignedAgent: req.session.user.username,
        scheduledDate: { $gte: todayStart, $lt: tomorrowStart },
        status: { $nin: ['Completed', 'Cancelled'] }
    }).sort({ scheduledTime: 1 }).limit(10).lean();
    
    const myUpcomingBookings = await Booking.find({
        assignedAgent: req.session.user.username,
        scheduledDate: { $gte: tomorrowStart, $lt: weekEnd },
        status: { $nin: ['Completed', 'Cancelled'] }
    }).sort({ scheduledDate: 1 }).limit(10).lean();

    res.render('agent', {
        agentName: req.session.user.username,
        entries,
        pendingJobs,
        orders,
        selectedDate: req.query.date || '',
        myNewLeads,
        myInProgressLeads,
        myTodayBookings,
        myUpcomingBookings
    });
});

app.post('/api/entry', requireAuth, async (req, res) => {
    try {
        if (req.body.entryId) {
            await Entry.findByIdAndUpdate(req.body.entryId, { ...req.body, jobStatus: 'Completed' });
        } else {
            const newEntry = new Entry(req.body);
            newEntry.agentName = req.session.user.username;
            newEntry.jobStatus = 'Completed';
            await newEntry.save();
        }
        res.redirect('/agent');
    } catch (err) { res.status(500).send(err.message); }
});

// ============ HARDWARE ORDERS ============
app.post('/api/order/new', requireAuth, async (req, res) => {
    const newOrder = new Order(req.body);
    newOrder.createdBy = req.session.user.username;
    if (req.session.user.role === 'admin') newOrder.assignedAgent = req.body.assignedAgent || 'Pending';
    await newOrder.save();
    res.redirect(req.session.user.role === 'admin' ? '/admin' : '/agent');
});

app.post('/api/admin/order/process/:id', requireAuth, async (req, res) => {
    const { vendorName, costPrice, sellingPrice, warranty, assignedAgent } = req.body;
    const profit = Number(sellingPrice) - Number(costPrice);
    await Order.findByIdAndUpdate(req.params.id, {
        vendorName, costPrice, sellingPrice, warranty, assignedAgent, profit, status: 'Assigned'
    });
    res.redirect('/admin');
});

app.post('/api/order/status/:id', requireAuth, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: req.body.status });
    res.redirect('/agent');
});

app.post('/api/order/whatsapp-sent/:id', requireAuth, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { whatsappSent: true });
    res.json({ success: true });
});

// ============ HARDWARE SERVICE APIS ============
app.post('/api/admin/assign', requireAuth, async (req, res) => {
    const newEntry = new Entry({
        customerName: req.body.customerName,
        mobileNumber: req.body.mobileNumber,
        location: req.body.location,
        agentName: req.body.agentName,
        jobStatus: 'Assigned'
    });
    await newEntry.save();
    res.redirect('/admin');
});

app.post('/api/admin/targets', requireAuth, async (req, res) => {
    let t = await Target.findOne();
    if (!t) t = new Target();
    t.dailyTarget = req.body.dailyTarget;
    t.weeklyTarget = req.body.weeklyTarget;
    t.monthlyTarget = req.body.monthlyTarget;
    await t.save();
    res.redirect('/admin');
});

app.post('/api/admin/update-km/:id', requireAuth, async (req, res) => {
    const km = Number(req.body.kmTraveled) || 0;
    const expense = (km / 50) * 100;
    await Entry.findByIdAndUpdate(req.params.id, { kmTraveled: km, travelExpense: expense });
    res.redirect('/admin');
});

app.post('/api/admin/followup/:id', requireAuth, async (req, res) => {
    await Entry.findByIdAndUpdate(req.params.id, {
        callStatus: 'Done',
        conversionStatus: req.body.conversionStatus
    });
    res.redirect('/admin');
});

app.post('/api/whatsapp-sent/:id', requireAuth, async (req, res) => {
    await Entry.findByIdAndUpdate(req.params.id, { whatsappSent: true });
    res.json({ success: true });
});

// ======================== PDF GENERATORS ========================

// ======================== PDF DESIGN HELPERS ========================
// Reusable function for the premium header on all PDFs
function drawPdfHeader(doc, docType, docNumber) {
    const W = doc.page.width;
    const path = require('path');
    
    // Dark gradient-like header background (3 shades layered)
    doc.rect(0, 0, W, 130).fill('#0f172a');
    doc.rect(0, 0, W, 80).fill('#1e293b');
    doc.rect(0, 0, W, 40).fill('#334155');
    
    // Accent line at bottom of header
    doc.rect(0, 130, W, 4).fill('#3b82f6');
    
    // White rounded box behind logo
    doc.roundedRect(40, 30, 75, 75, 10).fill('#ffffff');
    
    // Real Searvator logo
    try {
        const logoPath = path.join(__dirname, 'public', 'logo-icon.png');
        doc.image(logoPath, 45, 35, { fit: [65, 65], align: 'center', valign: 'center' });
    } catch (e) {
        // Fallback to S letter
        doc.fillColor('#0f172a').fontSize(40).font('Helvetica-Bold').text('S', 60, 50);
    }
    
    // Company name & tagline
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('SEARVATOR', 130, 45, { lineBreak: false });
    doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text('IT SOLUTIONS PVT. LTD.', 130, 72, { lineBreak: false });
    doc.fillColor('#cbd5e1').fontSize(7.5).text('CCTV • Biometric • AI Software • Hardware • Operations', 130, 86, { lineBreak: false });
    doc.fillColor('#fb923c').fontSize(7).font('Helvetica-Bold').text('SEARCH AND FACILITATOR', 130, 99, { lineBreak: false });
    
    // Document type & number (right)
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold').text(docType, 0, 50, { align: 'right', width: W - 40, lineBreak: false });
    if (docNumber) {
        doc.fillColor('#60a5fa').fontSize(10).font('Helvetica').text('# ' + docNumber, 0, 78, { align: 'right', width: W - 40, lineBreak: false });
    }
    doc.fillColor('#94a3b8').fontSize(8).text('www.searvator.com', 0, 95, { align: 'right', width: W - 40, lineBreak: false });
}

// Reusable services + contact footer for all PDFs
function drawPdfFooter(doc) {
    const W = doc.page.width;
    const H = doc.page.height;
    const footerY = H - 130;
    
    // Services strip (dark blue band)
    doc.rect(0, footerY, W, 50).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
        .text('OUR SERVICES', 0, footerY + 10, { align: 'center', width: W, lineBreak: false, height: 14 });
    
    const services = ['CCTV INSTALLATION', 'BIOMETRIC SYSTEMS', 'AI SOFTWARE', 'OPERATION SOFTWARE', 'HARDWARE & REPAIR'];
    const totalWidth = W - 40;
    const colWidth = totalWidth / services.length;
    services.forEach((s, i) => {
        doc.fillColor('#bfdbfe').fontSize(7.5).font('Helvetica-Bold')
            .text(s, 20 + (i * colWidth), footerY + 28, { width: colWidth, align: 'center', lineBreak: false, height: 12 });
    });
    
    // Dark contact footer
    doc.rect(0, footerY + 50, W, 80).fill('#0f172a');
    
    // Brand name
    doc.fillColor('#60a5fa').fontSize(12).font('Helvetica-Bold')
        .text('SEARVATOR IT SOLUTIONS PVT. LTD.', 0, footerY + 62, { align: 'center', width: W, lineBreak: false, height: 16 });
    
    // Contact details in 3 columns - using single line per element with no wrap
    const colY = footerY + 86;
    const cols = [
        { icon: 'PHONE', text: '+91 9106959092' },
        { icon: 'EMAIL', text: 'info@searvator.com' },
        { icon: 'WEB', text: 'www.searvator.com' }
    ];
    cols.forEach((c, i) => {
        const x = 20 + (i * ((W - 40) / 3));
        const w = (W - 40) / 3;
        doc.fillColor('#94a3b8').fontSize(7).font('Helvetica-Bold')
            .text(c.icon, x, colY, { width: w, align: 'center', lineBreak: false, height: 10 });
        doc.fillColor('#e2e8f0').fontSize(8.5).font('Helvetica')
            .text(c.text, x, colY + 11, { width: w, align: 'center', lineBreak: false, height: 12 });
    });
    
    // Bottom line
    doc.fillColor('#64748b').fontSize(7).font('Helvetica')
        .text('Ahmedabad, Gujarat, India  |  This is a system-generated document', 0, footerY + 115, { align: 'center', width: W, lineBreak: false, height: 10 });
}

// Creates a PDF doc that REFUSES to add new pages (forces single page)
function createSinglePagePdf() {
    const doc = new PDFDocument({ margin: 40, size: 'A4', autoFirstPage: true });
    // Block any auto page additions — prevents content overflow into new pages
    doc.addPage = function() { return doc; };
    return doc;
}

// ======================== PDF GENERATORS ========================

// 1. DIAGNOSTIC REPORT PDF
app.get('/report/:id', async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        if (!entry) return res.status(404).send('Report not found');
        const doc = createSinglePagePdf();
        res.setHeader('Content-disposition', `attachment; filename=Diagnostic_Report_${entry.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        
        const reportNum = 'SEA-DR-' + entry._id.toString().slice(-6).toUpperCase();
        drawPdfHeader(doc, 'DIAGNOSTIC REPORT', reportNum);
        
        let y = 155;
        
        // Customer info card (left) & Service info card (right)
        const cardW = 250;
        // Left card - Customer
        doc.roundedRect(40, y, cardW, 110, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text('CUSTOMER DETAILS', 52, y + 12);
        doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(entry.customerName, 52, y + 28);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Mobile: ' + entry.mobileNumber, 52, y + 50);
        doc.text('Location:', 52, y + 65);
        doc.text(entry.location, 52, y + 78, { width: cardW - 24 });
        
        // Right card - Service
        doc.roundedRect(305, y, cardW, 110, 8).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.fillColor('#1e40af').fontSize(8).font('Helvetica-Bold').text('SERVICE DETAILS', 317, y + 12);
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('Date: ', 317, y + 30, { continued: true }).font('Helvetica').text(entry.createdAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }));
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Time: ' + entry.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), 317, y + 50);
        doc.text('PC/System: ' + (entry.pcModel || 'N/A'), 317, y + 65);
        doc.text('Engineer: ' + entry.agentName.toUpperCase(), 317, y + 80);
        doc.fillColor('#16a34a').fontSize(9).font('Helvetica-Bold').text('Service: ' + entry.serviceTaken, 317, y + 95);
        
        y += 130;
        
        // Section title
        doc.roundedRect(40, y, 515, 28, 6).fill('#3b82f6');
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text('HARDWARE COMPONENT HEALTH STATUS', 0, y + 9, { align: 'center', width: doc.page.width });
        
        y += 38;
        
        // Component rows in a beautiful 2-column layout
        const components = [
            ['Motherboard', entry.motherboard, 'CPU/Processor', entry.cpu],
            ['RAM Status', entry.ramStatus, 'RAM Slots', entry.ramSlot],
            ['Storage (HDD/SSD)', entry.hddHealth, 'Optical Drive', entry.drive],
            ['Cooling Fan', entry.fan, 'System Temperature', entry.temperature],
            ['Ports / Connectors', entry.connectors, 'Monitor / Screen', entry.monitor],
            ['Battery Health', entry.battery, 'Charger / Power', entry.charger],
            ['Power Cable', entry.powerCable, 'Webcam / Mic', entry.webcam]
        ];
        
        const isGood = (v) => v === 'Good' || v === 'Normal' || v === 'N/A';
        
        components.forEach((row, idx) => {
            const rowY = y + (idx * 26);
            // Alternate row background
            if (idx % 2 === 0) {
                doc.rect(40, rowY, 515, 26).fill('#f8fafc');
            }
            // Left component
            doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold').text(row[0], 52, rowY + 8, { width: 110 });
            // Status badge - left
            const goodL = isGood(row[1]);
            doc.roundedRect(165, rowY + 5, 90, 16, 8).fillAndStroke(goodL ? '#dcfce7' : '#fee2e2', goodL ? '#86efac' : '#fca5a5');
            doc.fillColor(goodL ? '#15803d' : '#b91c1c').fontSize(8).font('Helvetica-Bold').text(row[1], 165, rowY + 9, { width: 90, align: 'center' });
            
            // Right component
            doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold').text(row[2], 295, rowY + 8, { width: 110 });
            // Status badge - right
            const goodR = isGood(row[3]);
            doc.roundedRect(420, rowY + 5, 90, 16, 8).fillAndStroke(goodR ? '#dcfce7' : '#fee2e2', goodR ? '#86efac' : '#fca5a5');
            doc.fillColor(goodR ? '#15803d' : '#b91c1c').fontSize(8).font('Helvetica-Bold').text(row[3], 420, rowY + 9, { width: 90, align: 'center' });
        });
        
        y += (components.length * 26) + 20;
        
        // Engineer remarks
        doc.roundedRect(40, y, 515, 70, 8).fillAndStroke('#fffbeb', '#fcd34d');
        doc.fillColor('#92400e').fontSize(9).font('Helvetica-Bold').text('ENGINEER REMARKS', 52, y + 12);
        doc.fillColor('#451a03').fontSize(10).font('Helvetica').text(entry.remarks, 52, y + 28, { width: 491, align: 'justify' });
        
        y += 80;
        
        // Signature area (only if space)
        if (y < doc.page.height - 200) {
            doc.fillColor('#64748b').fontSize(8).font('Helvetica').text('This is an authentic diagnostic report issued by Searvator IT Solutions Pvt. Ltd.', 40, y, { width: 515, align: 'center' });
            doc.moveTo(360, y + 30).lineTo(540, y + 30).strokeColor('#94a3b8').stroke();
            doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Authorized Signature', 360, y + 35, { width: 180, align: 'center' });
        }
        
        drawPdfFooter(doc);
        doc.end();
    } catch (err) { console.error(err); res.status(500).send('Error generating report'); }
});

// 2. SERVICE INVOICE PDF
app.get('/invoice/:id', async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        if (!entry) return res.status(404).send('Invoice not found');
        const doc = createSinglePagePdf();
        res.setHeader('Content-disposition', `attachment; filename=Service_Invoice_${entry.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        
        const invNum = 'SEA-INV-' + entry._id.toString().slice(-6).toUpperCase();
        drawPdfHeader(doc, 'INVOICE', invNum);
        
        let y = 155;
        
        // Bill To card (left) & Invoice Meta card (right)
        // Left card - Bill To
        doc.roundedRect(40, y, 250, 110, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text('BILLED TO', 52, y + 12);
        doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(entry.customerName, 52, y + 28);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Mobile: ' + entry.mobileNumber, 52, y + 50);
        doc.text('Address:', 52, y + 65);
        doc.text(entry.location, 52, y + 78, { width: 226 });
        
        // Right card - Invoice details
        doc.roundedRect(305, y, 250, 110, 8).fillAndStroke('#f0fdf4', '#86efac');
        doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold').text('INVOICE DETAILS', 317, y + 12);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Invoice No: ', 317, y + 30, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(invNum);
        doc.fillColor('#475569').font('Helvetica').text('Date: ', 317, y + 50, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(entry.createdAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }));
        doc.fillColor('#475569').font('Helvetica').text('Payment Mode: ', 317, y + 70, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(entry.paymentMode || 'Cash');
        doc.fillColor('#475569').font('Helvetica').text('Status: ', 317, y + 90, { continued: true }).fillColor('#16a34a').font('Helvetica-Bold').text('PAID');
        
        y += 130;
        
        // Items table header
        doc.rect(40, y, 515, 32).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
        doc.text('#', 50, y + 11);
        doc.text('DESCRIPTION', 80, y + 11);
        doc.text('QTY', 360, y + 11, { width: 40, align: 'center' });
        doc.text('RATE', 410, y + 11, { width: 60, align: 'right' });
        doc.text('AMOUNT', 480, y + 11, { width: 65, align: 'right' });
        
        y += 32;
        
        // Items row
        doc.rect(40, y, 515, 50).fillAndStroke('#ffffff', '#e2e8f0');
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('1', 50, y + 16);
        doc.text(entry.serviceTaken, 80, y + 14);
        doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Professional IT diagnostic and system service', 80, y + 30);
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica').text('1', 360, y + 16, { width: 40, align: 'center' });
        doc.text('Rs. ' + entry.revenue.toLocaleString('en-IN'), 410, y + 16, { width: 60, align: 'right' });
        doc.font('Helvetica-Bold').text('Rs. ' + entry.revenue.toLocaleString('en-IN'), 480, y + 16, { width: 65, align: 'right' });
        
        y += 60;
        
        // Totals section (right aligned card)
        doc.roundedRect(305, y, 250, 90, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Subtotal:', 320, y + 14);
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Rs. ' + entry.revenue.toLocaleString('en-IN'), 0, y + 14, { width: 540, align: 'right' });
        doc.fillColor('#64748b').font('Helvetica').text('Tax:', 320, y + 32);
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Inclusive', 0, y + 32, { width: 540, align: 'right' });
        
        // Divider
        doc.moveTo(320, y + 55).lineTo(540, y + 55).strokeColor('#cbd5e1').stroke();
        
        // Grand total
        doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('TOTAL AMOUNT', 320, y + 65);
        doc.fillColor('#16a34a').fontSize(16).font('Helvetica-Bold').text('Rs. ' + entry.revenue.toLocaleString('en-IN'), 0, y + 62, { width: 540, align: 'right' });
        
        y += 110;
        
        // Thank you / Notes section
        doc.roundedRect(40, y, 255, 70, 8).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.fillColor('#1e40af').fontSize(9).font('Helvetica-Bold').text('THANK YOU FOR CHOOSING US!', 52, y + 12);
        doc.fillColor('#475569').fontSize(8).font('Helvetica').text('Your trust means everything to us. For any queries regarding this service, please reach out to our support team.', 52, y + 28, { width: 232 });
        
        // Signature area
        doc.fillColor('#64748b').fontSize(8).font('Helvetica').text('For SEARVATOR IT SOLUTIONS', 380, y + 12, { width: 160, align: 'center' });
        doc.moveTo(380, y + 50).lineTo(540, y + 50).strokeColor('#94a3b8').stroke();
        doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Authorized Signatory', 380, y + 55, { width: 160, align: 'center' });
        
        drawPdfFooter(doc);
        doc.end();
    } catch (err) { console.error(err); res.status(500).send('Error generating invoice'); }
});

// 3. ORDER (TAX) INVOICE PDF
app.get('/order-invoice/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send('Invoice not found');
        const doc = createSinglePagePdf();
        res.setHeader('Content-disposition', `attachment; filename=Tax_Invoice_${order.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        
        const invNum = 'SEA-TAX-' + order._id.toString().slice(-6).toUpperCase();
        drawPdfHeader(doc, 'TAX INVOICE', invNum);
        
        let y = 155;
        
        // Bill To card (left) & Invoice Meta card (right)
        doc.roundedRect(40, y, 250, 110, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text('BILLED TO', 52, y + 12);
        doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(order.customerName, 52, y + 28);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Mobile: ' + order.mobileNumber, 52, y + 50);
        doc.text('Address:', 52, y + 65);
        doc.text(order.location, 52, y + 78, { width: 226 });
        
        doc.roundedRect(305, y, 250, 110, 8).fillAndStroke('#fef3c7', '#fcd34d');
        doc.fillColor('#92400e').fontSize(8).font('Helvetica-Bold').text('INVOICE DETAILS', 317, y + 12);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Invoice No: ', 317, y + 30, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(invNum);
        doc.fillColor('#475569').font('Helvetica').text('Date: ', 317, y + 50, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(order.createdAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }));
        doc.fillColor('#475569').font('Helvetica').text('Warranty: ', 317, y + 70, { continued: true }).fillColor('#16a34a').font('Helvetica-Bold').text(order.warranty || 'N/A');
        doc.fillColor('#475569').font('Helvetica').text('Vendor: ', 317, y + 90, { continued: true }).fillColor('#0f172a').font('Helvetica-Bold').text(order.vendorName || 'N/A');
        
        y += 130;
        
        // Items table header
        doc.rect(40, y, 515, 32).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
        doc.text('#', 50, y + 11);
        doc.text('PRODUCT / SERVICE DESCRIPTION', 80, y + 11);
        doc.text('QTY', 360, y + 11, { width: 40, align: 'center' });
        doc.text('RATE', 410, y + 11, { width: 60, align: 'right' });
        doc.text('AMOUNT', 480, y + 11, { width: 65, align: 'right' });
        
        y += 32;
        
        // Items row - bigger to accommodate description
        const descHeight = 60;
        doc.rect(40, y, 515, descHeight).fillAndStroke('#ffffff', '#e2e8f0');
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('1', 50, y + 16);
        doc.text(order.description, 80, y + 14, { width: 270 });
        doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Warranty: ' + (order.warranty || 'N/A'), 80, y + descHeight - 16);
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica').text('1', 360, y + 16, { width: 40, align: 'center' });
        doc.text('Rs. ' + order.sellingPrice.toLocaleString('en-IN'), 410, y + 16, { width: 60, align: 'right' });
        doc.font('Helvetica-Bold').text('Rs. ' + order.sellingPrice.toLocaleString('en-IN'), 480, y + 16, { width: 65, align: 'right' });
        
        y += descHeight + 10;
        
        // Totals card
        doc.roundedRect(305, y, 250, 90, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Subtotal:', 320, y + 14);
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Rs. ' + order.sellingPrice.toLocaleString('en-IN'), 0, y + 14, { width: 540, align: 'right' });
        doc.fillColor('#64748b').font('Helvetica').text('Tax:', 320, y + 32);
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Inclusive', 0, y + 32, { width: 540, align: 'right' });
        
        doc.moveTo(320, y + 55).lineTo(540, y + 55).strokeColor('#cbd5e1').stroke();
        
        doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('TOTAL AMOUNT', 320, y + 65);
        doc.fillColor('#16a34a').fontSize(16).font('Helvetica-Bold').text('Rs. ' + order.sellingPrice.toLocaleString('en-IN'), 0, y + 62, { width: 540, align: 'right' });
        
        y += 110;
        
        // Terms & Signature
        doc.roundedRect(40, y, 255, 70, 8).fillAndStroke('#fef3c7', '#fcd34d');
        doc.fillColor('#92400e').fontSize(9).font('Helvetica-Bold').text('WARRANTY & TERMS', 52, y + 12);
        doc.fillColor('#451a03').fontSize(8).font('Helvetica').text('• Warranty period: ' + (order.warranty || 'N/A') + '\n• Warranty void if seal is tampered\n• Product replacement subject to vendor approval', 52, y + 28, { width: 232 });
        
        doc.fillColor('#64748b').fontSize(8).font('Helvetica').text('For SEARVATOR IT SOLUTIONS', 380, y + 12, { width: 160, align: 'center' });
        doc.moveTo(380, y + 50).lineTo(540, y + 50).strokeColor('#94a3b8').stroke();
        doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Authorized Signatory', 380, y + 55, { width: 160, align: 'center' });
        
        drawPdfFooter(doc);
        doc.end();
    } catch (err) { console.error(err); res.status(500).send('Error generating invoice'); }
});

// ============ ADMIN DASHBOARD (Hardware - original) ============
app.get('/admin', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'admin') return res.redirect('/agent');
    let query = {};
    if (req.query.agent) query.agentName = req.query.agent;
    if (req.query.date) {
        const d = new Date(req.query.date);
        query.createdAt = { $gte: d, $lt: new Date(d.getTime() + 24 * 60 * 60 * 1000) };
    }

    // Get filtered entries (limit 200 for view) - exclude heavy fields (photos)
    const entries = await Entry.find(query)
        .select('-proofPhoto -beforePhoto -afterPhoto -editLogs')
        .sort({ createdAt: -1 }).limit(200).lean();
    
    const allOrders = await Order.find().sort({ createdAt: -1 }).limit(200).lean();

    let targets = await Target.findOne().lean();
    if (!targets) targets = { dailyTarget: 10000, weeklyTarget: 70000, monthlyTarget: 300000 };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Use aggregation for revenue stats (fast - DB-side calculation)
    const [todayAgg, weekAgg, monthAgg, allStats, followUpAgg, sourceAgg, conversionAgg] = await Promise.all([
        Entry.aggregate([
            { $match: { createdAt: { $gte: startOfToday }, jobStatus: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$revenue' } } }
        ]),
        Entry.aggregate([
            { $match: { createdAt: { $gte: startOfWeek }, jobStatus: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$revenue' } } }
        ]),
        Entry.aggregate([
            { $match: { createdAt: { $gte: startOfMonth }, jobStatus: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$revenue' } } }
        ]),
        Entry.aggregate([
            { $match: { jobStatus: 'Completed' } },
            { $group: { _id: null, totalRev: { $sum: '$revenue' }, totalExp: { $sum: '$travelExpense' } } }
        ]),
        Entry.aggregate([
            { $match: { callStatus: 'Done', conversionStatus: 'Converted' } },
            { $group: { _id: null, total: { $sum: '$revenue' } } }
        ]),
        Entry.aggregate([
            { $match: { jobStatus: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$revenue' } } }
        ]),
        Entry.aggregate([
            { $match: { followUpDate: { $ne: null } } },
            { $group: { _id: '$conversionStatus', count: { $sum: 1 } } }
        ])
    ]);
    
    const ordersTodayRev = allOrders.filter(o => o.createdAt >= startOfToday && o.status === 'Completed').reduce((s, o) => s + (o.sellingPrice || 0), 0);
    const ordersWeekRev = allOrders.filter(o => o.createdAt >= startOfWeek && o.status === 'Completed').reduce((s, o) => s + (o.sellingPrice || 0), 0);
    const ordersMonthRev = allOrders.filter(o => o.createdAt >= startOfMonth && o.status === 'Completed').reduce((s, o) => s + (o.sellingPrice || 0), 0);
    
    const todayRevenue = (todayAgg[0]?.total || 0) + ordersTodayRev;
    const weekRevenue = (weekAgg[0]?.total || 0) + ordersWeekRev;
    const monthRevenue = (monthAgg[0]?.total || 0) + ordersMonthRev;
    
    const ordersAllRev = allOrders.filter(o => o.status === 'Completed').reduce((s, o) => s + (o.sellingPrice || 0), 0);
    const ordersAllCost = allOrders.filter(o => o.status === 'Completed').reduce((s, o) => s + (o.costPrice || 0), 0);
    
    // Filter-specific totals from loaded entries
    const totalRevenue = entries.filter(e => e.jobStatus === 'Completed').reduce((s, e) => s + (e.revenue || 0), 0) + ordersAllRev;
    const totalExpense = entries.reduce((s, e) => s + (e.travelExpense || 0), 0) + ordersAllCost;
    
    const followUpRevenue = followUpAgg[0]?.total || 0;
    
    let sources = { CCTV: 0, Networking: 0, 'Software AI': 0, AMC: 0, '79 Service': 0 };
    sources['79 Service'] = sourceAgg[0]?.total || 0;
    // Interested services - count from filtered entries (good enough)
    entries.filter(e => e.jobStatus === 'Completed').forEach(e => {
        (e.interestedServices || []).forEach(s => { if (sources[s] !== undefined) sources[s] += 1000; });
    });
    
    // Conversion analysis
    let conversionCounts = { Converted: 0, TotalCalls: 0 };
    conversionAgg.forEach(a => {
        conversionCounts.TotalCalls += a.count;
        if (a._id === 'Converted') conversionCounts.Converted = a.count;
    });

    let weakPoint = "None. All systems performing optimally.";
    if (conversionCounts.TotalCalls > 0 && (conversionCounts.Converted / conversionCounts.TotalCalls) < 0.4) {
        weakPoint = "Follow-up Conversion Rate is low. Call intervention required.";
    }

    const pendingVijay = entries.filter(e => e.agentName === 'vijay' && e.jobStatus === 'Assigned');
    const pendingRahul = entries.filter(e => e.agentName === 'rahul' && e.jobStatus === 'Assigned');

    res.render('admin', {
        user: req.session.user,
        entries, orders: allOrders, totalRevenue, totalExpense,
        todayRevenue, weekRevenue, monthRevenue, targets,
        weakPoint, query: req.query, sources, followUpRevenue,
        pendingVijay, pendingRahul
    });
});

app.get('/admin/export', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'admin') return res.redirect('/login');
    const entries = await Entry.find().sort({ createdAt: -1 }).limit(300).lean();
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Business Report');
    worksheet.columns = [
        { header: 'Date', key: 'date', width: 15 },
        { header: 'Time', key: 'time', width: 10 },
        { header: 'Agent', key: 'agentName', width: 15 },
        { header: 'Customer', key: 'customerName', width: 20 },
        { header: 'Mobile', key: 'mobileNumber', width: 15 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Gross Revenue', key: 'revenue', width: 15 },
        { header: 'Travel Expense', key: 'expense', width: 15 },
        { header: 'Net Revenue', key: 'net', width: 15 }
    ];
    entries.forEach(e => {
        worksheet.addRow({
            date: e.createdAt.toLocaleDateString(),
            time: e.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            agentName: e.agentName,
            customerName: e.customerName,
            mobileNumber: e.mobileNumber,
            revenue: e.revenue,
            expense: e.travelExpense,
            net: e.revenue - e.travelExpense
        });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Searvator_Report.xlsx');
    return workbook.xlsx.write(res).then(() => res.status(200).end());
});

// ======================== AI PROJECTS MODULE ========================
const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).send('Access Denied');
    }
    next();
};

app.get('/ai-projects', requireAuth, requireAdmin, async (req, res) => {
    const projects = await AIProject.find().sort({ createdAt: -1 }).limit(100).lean();
    res.render('ai-projects', { user: req.session.user, projects });
});

app.get('/ai-projects/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        if (!project) return res.status(404).send('Project not found');
        res.render('ai-project-detail', { user: req.session.user, project });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/ai-projects', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = new AIProject(req.body);
        await project.save();
        res.json({ success: true, project });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/ai-projects/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, project });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/ai-projects/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await AIProject.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Cost entries
app.post('/api/ai-projects/:id/costs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.costs.push(req.body);
        await project.save();
        res.json({ success: true, project });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/ai-projects/:id/costs/:costId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.costs.id(req.params.costId).deleteOne();
        await project.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Recurring costs
app.post('/api/ai-projects/:id/recurring', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.recurringCosts.push(req.body);
        await project.save();
        res.json({ success: true, project });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/ai-projects/:id/recurring/:rcId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.recurringCosts.id(req.params.rcId).deleteOne();
        await project.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Revenue entries
app.post('/api/ai-projects/:id/revenues', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.revenues.push(req.body);
        await project.save();
        res.json({ success: true, project });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/ai-projects/:id/revenues/:revId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const project = await AIProject.findById(req.params.id);
        project.revenues.id(req.params.revId).deleteOne();
        await project.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======================== CCTV MODULE ========================
app.get('/cctv', requireAuth, requireAdmin, async (req, res) => {
    const products = await CCTVProduct.find().sort({ category: 1, productName: 1 }).limit(200).lean();
    const quotations = await Quotation.find().sort({ createdAt: -1 }).limit(50);
    res.render('cctv', { user: req.session.user, products, quotations });
});

app.post('/api/cctv/products', requireAuth, requireAdmin, async (req, res) => {
    try {
        const product = new CCTVProduct(req.body);
        await product.save();
        res.json({ success: true, product });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/cctv/products/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const product = await CCTVProduct.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, product });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/cctv/products/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await CCTVProduct.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/cctv/products', requireAuth, async (req, res) => {
    const products = await CCTVProduct.find({ inStock: true }).sort({ category: 1, productName: 1 });
    res.json(products);
});

// CCTV Quotations
app.get('/cctv/quotation/new', requireAuth, requireAdmin, async (req, res) => {
    const products = await CCTVProduct.find({ inStock: true }).sort({ category: 1, productName: 1 });
    res.render('quotation-builder', { user: req.session.user, products, quotation: null });
});

app.get('/cctv/quotation/:id/edit', requireAuth, requireAdmin, async (req, res) => {
    const products = await CCTVProduct.find({ inStock: true }).sort({ category: 1, productName: 1 });
    const quotation = await Quotation.findById(req.params.id);
    res.render('quotation-builder', { user: req.session.user, products, quotation });
});

app.post('/api/quotations', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        const count = await Quotation.countDocuments();
        data.quotationNumber = `SEA-Q-${String(count + 1).padStart(4, '0')}`;
        data.createdBy = req.session.user.username;

        let subtotal = 0, gstAmount = 0;
        (data.items || []).forEach(item => {
            const itemSubtotal = (item.quantity || 0) * (item.unitPrice || 0);
            const itemGst = itemSubtotal * (item.gstPercent || 0) / 100;
            item.total = itemSubtotal + itemGst;
            subtotal += itemSubtotal;
            gstAmount += itemGst;
        });
        data.subtotal = subtotal;
        data.gstAmount = gstAmount;
        data.grandTotal = subtotal + gstAmount + (data.installationCharges || 0) - (data.discount || 0);

        const quotation = new Quotation(data);
        await quotation.save();
        res.json({ success: true, quotation });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/quotations/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        if (data.items) {
            let subtotal = 0, gstAmount = 0;
            data.items.forEach(item => {
                const itemSubtotal = (item.quantity || 0) * (item.unitPrice || 0);
                const itemGst = itemSubtotal * (item.gstPercent || 0) / 100;
                item.total = itemSubtotal + itemGst;
                subtotal += itemSubtotal;
                gstAmount += itemGst;
            });
            data.subtotal = subtotal;
            data.gstAmount = gstAmount;
            data.grandTotal = subtotal + gstAmount + (data.installationCharges || 0) - (data.discount || 0);
        }
        const quotation = await Quotation.findByIdAndUpdate(req.params.id, data, { new: true });
        res.json({ success: true, quotation });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/quotations/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Quotation.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// CCTV Quotation PDF
app.get('/api/quotations/:id/pdf', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).send('Not found');

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${q.quotationNumber}.pdf"`);
        doc.pipe(res);

        doc.rect(0, 0, doc.page.width, 90).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold').text('SEARVATOR', 40, 28);
        doc.fontSize(9).font('Helvetica').fillColor('#94a3b8').text('AI • Hardware • CCTV • Biometric Solutions', 40, 58);
        doc.fontSize(9).fillColor('#cbd5e1').text('QUOTATION', 0, 32, { align: 'right', width: doc.page.width - 40 });
        doc.fontSize(14).fillColor('#ffffff').font('Helvetica-Bold').text(q.quotationNumber, 0, 50, { align: 'right', width: doc.page.width - 40 });

        doc.fillColor('#000000').fontSize(10).font('Helvetica');
        let y = 110;

        doc.font('Helvetica-Bold').fontSize(11).text('Quotation To:', 40, y);
        doc.font('Helvetica').fontSize(10);
        y += 18;
        doc.text(q.clientName, 40, y); y += 14;
        if (q.clientCompany) { doc.text(q.clientCompany, 40, y); y += 14; }
        if (q.clientMobile) { doc.text(`Mobile: ${q.clientMobile}`, 40, y); y += 14; }
        if (q.clientEmail) { doc.text(`Email: ${q.clientEmail}`, 40, y); y += 14; }
        if (q.clientAddress) { doc.text(q.clientAddress, 40, y, { width: 300 }); y += 14; }

        const rightX = 380;
        let ry = 110;
        doc.font('Helvetica-Bold').fontSize(10).text('Date:', rightX, ry);
        doc.font('Helvetica').text(new Date(q.createdAt).toLocaleDateString('en-IN'), rightX + 70, ry);
        ry += 16;
        doc.font('Helvetica-Bold').text('Valid Till:', rightX, ry);
        const validTill = new Date(q.createdAt);
        validTill.setDate(validTill.getDate() + (q.validityDays || 15));
        doc.font('Helvetica').text(validTill.toLocaleDateString('en-IN'), rightX + 70, ry);
        ry += 16;
        doc.font('Helvetica-Bold').text('Project:', rightX, ry);
        doc.font('Helvetica').text(q.projectType, rightX + 70, ry);
        ry += 16;
        if (q.siteLocation) {
            doc.font('Helvetica-Bold').text('Site:', rightX, ry);
            doc.font('Helvetica').text(q.siteLocation, rightX + 70, ry, { width: 150 });
        }

        y = Math.max(y, ry) + 20;

        const tableTop = y;
        const colX = { sno: 40, desc: 75, qty: 320, unit: 360, price: 400, gst: 460, total: 500 };

        doc.rect(40, tableTop, doc.page.width - 80, 24).fill('#0f172a');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
        doc.text('#', colX.sno, tableTop + 8);
        doc.text('Description', colX.desc, tableTop + 8);
        doc.text('Qty', colX.qty, tableTop + 8);
        doc.text('Unit', colX.unit, tableTop + 8);
        doc.text('Price', colX.price, tableTop + 8);
        doc.text('GST%', colX.gst, tableTop + 8);
        doc.text('Total', colX.total, tableTop + 8);

        y = tableTop + 24;
        doc.fillColor('#000000').font('Helvetica').fontSize(9);

        (q.items || []).forEach((item, idx) => {
            const rowHeight = item.specifications ? 32 : 20;
            if (idx % 2 === 0) {
                doc.rect(40, y, doc.page.width - 80, rowHeight).fill('#f8fafc');
                doc.fillColor('#000000');
            }
            doc.text(String(idx + 1), colX.sno, y + 6);
            doc.font('Helvetica-Bold').text(item.productName, colX.desc, y + 6, { width: 235 });
            if (item.specifications) {
                doc.font('Helvetica').fillColor('#64748b').fontSize(8).text(item.specifications, colX.desc, y + 18, { width: 235 });
                doc.fillColor('#000000').fontSize(9);
            }
            doc.font('Helvetica').text(String(item.quantity), colX.qty, y + 6);
            doc.text(item.unit || 'Pcs', colX.unit, y + 6);
            doc.text(`Rs.${item.unitPrice.toLocaleString('en-IN')}`, colX.price, y + 6);
            doc.text(`${item.gstPercent}%`, colX.gst, y + 6);
            doc.font('Helvetica-Bold').text(`Rs.${Math.round(item.total).toLocaleString('en-IN')}`, colX.total, y + 6);
            doc.font('Helvetica');
            y += rowHeight;
        });

        y += 10;
        const totalsX = 380;
        doc.fontSize(10).font('Helvetica');
        doc.text('Subtotal:', totalsX, y);
        doc.text(`Rs.${Math.round(q.subtotal).toLocaleString('en-IN')}`, totalsX + 100, y, { align: 'right', width: 75 });
        y += 16;
        doc.text('GST:', totalsX, y);
        doc.text(`Rs.${Math.round(q.gstAmount).toLocaleString('en-IN')}`, totalsX + 100, y, { align: 'right', width: 75 });
        y += 16;
        if (q.installationCharges > 0) {
            doc.text('Installation:', totalsX, y);
            doc.text(`Rs.${q.installationCharges.toLocaleString('en-IN')}`, totalsX + 100, y, { align: 'right', width: 75 });
            y += 16;
        }
        if (q.discount > 0) {
            doc.fillColor('#dc2626').text('Discount:', totalsX, y);
            doc.text(`-Rs.${q.discount.toLocaleString('en-IN')}`, totalsX + 100, y, { align: 'right', width: 75 });
            doc.fillColor('#000000');
            y += 16;
        }

        doc.rect(totalsX - 5, y, 185, 26).fill('#0f172a');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12);
        doc.text('GRAND TOTAL:', totalsX, y + 8);
        doc.text(`Rs.${Math.round(q.grandTotal).toLocaleString('en-IN')}`, totalsX + 100, y + 8, { align: 'right', width: 75 });
        y += 36;

        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('Terms & Conditions:', 40, y);
        y += 16;
        doc.font('Helvetica').fontSize(9);
        doc.text(`• Payment Terms: ${q.paymentTerms}`, 40, y); y += 12;
        doc.text(`• Warranty: ${q.warranty}`, 40, y); y += 12;
        doc.text(`• Validity: ${q.validityDays} days from quotation date`, 40, y); y += 12;
        doc.text(`• Installation charges are inclusive of basic setup. Civil work extra.`, 40, y); y += 12;
        doc.text(`• Prices are subject to change without prior notice.`, 40, y); y += 12;
        if (q.notes) {
            y += 6;
            doc.font('Helvetica-Bold').text('Notes:', 40, y); y += 14;
            doc.font('Helvetica').text(q.notes, 40, y, { width: doc.page.width - 80 });
        }

        const footerY = doc.page.height - 50;
        doc.rect(0, footerY, doc.page.width, 50).fill('#0f172a');
        doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('Thank you for considering Searvator. We look forward to working with you.', 40, footerY + 18, { align: 'center', width: doc.page.width - 80 });
        doc.fontSize(7).text('This is a system-generated quotation.', 40, footerY + 32, { align: 'center', width: doc.page.width - 80 });

        doc.end();
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

// ======================== OTHER BUSINESS ========================
app.get('/other-business', requireAuth, requireAdmin, async (req, res) => {
    const items = await OtherBusiness.find().sort({ createdAt: -1 }).limit(100).lean();
    res.render('other-business', { user: req.session.user, items });
});

app.post('/api/other-business', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        data.profit = (data.revenue || 0) - (data.expenses || 0);
        const item = new OtherBusiness(data);
        await item.save();
        res.json({ success: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/other-business/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        data.profit = (data.revenue || 0) - (data.expenses || 0);
        const item = await OtherBusiness.findByIdAndUpdate(req.params.id, data, { new: true });
        res.json({ success: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/other-business/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await OtherBusiness.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======================== AMC MANAGEMENT MODULE ========================

// Helper: Auto-generate suggestions based on PC component status
function generateSuggestions(pc) {
    const sug = [];
    if (pc.ramStatus !== 'Good') sug.push('RAM Upgrade Recommended');
    if (pc.hddHealth !== 'Good') sug.push('SSD Upgrade Required');
    if (pc.fan === 'Noisy/Slow' || pc.temperature === 'Overheating') sug.push('Cooling System Service');
    if (pc.battery === 'Dead/Replace') sug.push('Battery Replacement');
    if (pc.motherboard !== 'Good') sug.push('Motherboard Repair');
    if (pc.cpu !== 'Good') sug.push('CPU Service / Replacement');
    if (pc.monitor !== 'Good') sug.push('Monitor Replacement');
    return sug;
}

function calculateOverallStatus(pc) {
    let issues = 0;
    if (pc.motherboard !== 'Good') issues++;
    if (pc.cpu !== 'Good') issues++;
    if (pc.ramStatus !== 'Good') issues++;
    if (pc.hddHealth !== 'Good') issues++;
    if (pc.fan !== 'Good') issues++;
    if (pc.temperature !== 'Normal') issues++;
    if (pc.battery !== 'Good' && pc.battery !== 'N/A') issues++;
    if (pc.monitor !== 'Good') issues++;
    if (issues === 0) return 'Healthy';
    if (issues <= 2) return 'Issues';
    return 'Critical';
}

// ---- Master AMC Dashboard ----
app.get('/amc', requireAuth, requireAdmin, async (req, res) => {
    const offices = await AMCOffice.find().select('-pcs.beforePhoto -pcs.afterPhoto -visits.pcServiceLogs.beforePhoto -visits.pcServiceLogs.afterPhoto').sort({ createdAt: -1 }).limit(100).lean();
    
    // Aggregate stats
    let totalPCs = 0, healthyPCs = 0, issuePCs = 0, criticalPCs = 0;
    let totalRevenue = 0, totalExpense = 0, totalPending = 0;
    let upcomingVisits = [];
    const today = new Date(); today.setHours(0,0,0,0);
    const next7 = new Date(today); next7.setDate(next7.getDate() + 7);
    
    offices.forEach(off => {
        totalPCs += off.pcs.length;
        off.pcs.forEach(p => {
            if (p.overallStatus === 'Healthy') healthyPCs++;
            else if (p.overallStatus === 'Issues') issuePCs++;
            else criticalPCs++;
        });
        const paid = (off.payments || []).reduce((s, p) => s + p.amount, 0);
        const exp = (off.expenses || []).reduce((s, e) => s + e.amount, 0);
        totalRevenue += paid;
        totalExpense += exp;
        
        // Estimate pending: contract months * monthly fee - paid
        if (off.contractStartDate && off.monthlyFee) {
            const monthsElapsed = Math.max(1, Math.ceil((new Date() - new Date(off.contractStartDate)) / (1000 * 60 * 60 * 24 * 30)));
            const expected = monthsElapsed * off.monthlyFee;
            totalPending += Math.max(0, expected - paid);
        }
        
        // Upcoming visits
        (off.visits || []).forEach(v => {
            if (v.status === 'Scheduled' && new Date(v.visitDate) >= today && new Date(v.visitDate) <= next7) {
                upcomingVisits.push({ ...v.toObject(), officeName: off.officeName, officeId: off._id });
            }
        });
    });
    
    upcomingVisits.sort((a, b) => new Date(a.visitDate) - new Date(b.visitDate));
    
    res.render('amc', {
        user: req.session.user,
        offices,
        stats: {
            totalOffices: offices.length,
            totalPCs, healthyPCs, issuePCs, criticalPCs,
            totalRevenue, totalExpense,
            netProfit: totalRevenue - totalExpense,
            totalPending,
            upcomingVisitsCount: upcomingVisits.length
        },
        upcomingVisits: upcomingVisits.slice(0, 10)
    });
});

// ---- Office Detail Page ----
app.get('/amc/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        if (!office) return res.status(404).send('Office not found');
        res.render('amc-office', { user: req.session.user, office });
    } catch (e) { res.status(500).send(e.message); }
});

// ---- Office CRUD ----
app.post('/api/amc/offices', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = new AMCOffice(req.body);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/amc/offices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/amc/offices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await AMCOffice.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- PCs CRUD ----
app.post('/api/amc/offices/:id/pcs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        const pcData = req.body;
        pcData.suggestions = generateSuggestions(pcData);
        pcData.overallStatus = calculateOverallStatus(pcData);
        office.pcs.push(pcData);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/amc/offices/:id/pcs/:pcId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        const pc = office.pcs.id(req.params.pcId);
        if (!pc) return res.status(404).json({ error: 'PC not found' });
        Object.assign(pc, req.body);
        pc.suggestions = generateSuggestions(pc);
        pc.overallStatus = calculateOverallStatus(pc);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/amc/offices/:id/pcs/:pcId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.pcs.id(req.params.pcId).deleteOne();
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Visits CRUD ----
app.post('/api/amc/offices/:id/visits', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.visits.push(req.body);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/amc/offices/:id/visits/:vId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        const visit = office.visits.id(req.params.vId);
        if (!visit) return res.status(404).json({ error: 'Visit not found' });
        Object.assign(visit, req.body);
        if (req.body.status === 'Completed' && !visit.completedAt) visit.completedAt = new Date();
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/amc/offices/:id/visits/:vId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.visits.id(req.params.vId).deleteOne();
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Payments ----
app.post('/api/amc/offices/:id/payments', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.payments.push(req.body);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/amc/offices/:id/payments/:pId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.payments.id(req.params.pId).deleteOne();
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Expenses ----
app.post('/api/amc/offices/:id/expenses', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.expenses.push(req.body);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/amc/offices/:id/expenses/:eId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        office.expenses.id(req.params.eId).deleteOne();
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- WhatsApp notification - mark sent ----
app.post('/api/amc/offices/:id/visits/:vId/wa-sent', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        const visit = office.visits.id(req.params.vId);
        visit.notificationSent = true;
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Export Office data to Excel ----
app.get('/api/amc/offices/:id/export', requireAuth, requireAdmin, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        if (!office) return res.status(404).send('Office not found');
        
        const workbook = new exceljs.Workbook();
        
        // Sheet 1: PCs
        const pcSheet = workbook.addWorksheet('PCs');
        pcSheet.columns = [
            { header: 'PC ID', key: 'pcId', width: 12 },
            { header: 'Type', key: 'pcType', width: 12 },
            { header: 'Model', key: 'pcModel', width: 25 },
            { header: 'User', key: 'user', width: 18 },
            { header: 'Department', key: 'department', width: 18 },
            { header: 'Rate/PC', key: 'ratePerPC', width: 10 },
            { header: 'Status', key: 'overallStatus', width: 12 },
            { header: 'Motherboard', key: 'motherboard', width: 14 },
            { header: 'CPU', key: 'cpu', width: 14 },
            { header: 'RAM', key: 'ramStatus', width: 14 },
            { header: 'Storage', key: 'hddHealth', width: 14 },
            { header: 'Fan', key: 'fan', width: 14 },
            { header: 'Temp', key: 'temperature', width: 14 },
            { header: 'Battery', key: 'battery', width: 14 },
            { header: 'Monitor', key: 'monitor', width: 14 },
            { header: 'Suggestions', key: 'suggestions', width: 40 },
            { header: 'Last Service', key: 'lastServicedDate', width: 14 },
            { header: 'Last Engineer', key: 'lastServicedBy', width: 14 },
            { header: 'Remarks', key: 'remarks', width: 30 }
        ];
        office.pcs.forEach(p => {
            pcSheet.addRow({
                ...p.toObject(),
                suggestions: (p.suggestions || []).join(', '),
                lastServicedDate: p.lastServicedDate ? p.lastServicedDate.toLocaleDateString() : '-'
            });
        });
        
        // Sheet 2: Visits
        const visitSheet = workbook.addWorksheet('Visits');
        visitSheet.columns = [
            { header: 'Date', key: 'visitDate', width: 14 },
            { header: 'Time', key: 'visitTime', width: 10 },
            { header: 'Agent', key: 'assignedAgent', width: 14 },
            { header: 'Purpose', key: 'purpose', width: 22 },
            { header: 'PCs', key: 'pcsToService', width: 30 },
            { header: 'Status', key: 'status', width: 14 },
            { header: 'Completed', key: 'completedAt', width: 14 },
            { header: 'Notes', key: 'notes', width: 30 }
        ];
        office.visits.forEach(v => {
            visitSheet.addRow({
                ...v.toObject(),
                visitDate: v.visitDate.toLocaleDateString(),
                pcsToService: (v.pcsToService || []).join(', '),
                completedAt: v.completedAt ? v.completedAt.toLocaleDateString() : '-'
            });
        });
        
        // Sheet 3: Payments
        const paymentSheet = workbook.addWorksheet('Payments');
        paymentSheet.columns = [
            { header: 'Date', key: 'paidDate', width: 14 },
            { header: 'Amount', key: 'amount', width: 12 },
            { header: 'Mode', key: 'paymentMode', width: 14 },
            { header: 'Invoice', key: 'invoiceNumber', width: 18 },
            { header: 'Notes', key: 'notes', width: 30 }
        ];
        office.payments.forEach(p => {
            paymentSheet.addRow({ ...p.toObject(), paidDate: p.paidDate.toLocaleDateString() });
        });
        
        // Sheet 4: Expenses
        const expenseSheet = workbook.addWorksheet('Expenses');
        expenseSheet.columns = [
            { header: 'Date', key: 'date', width: 14 },
            { header: 'Category', key: 'category', width: 14 },
            { header: 'Description', key: 'description', width: 30 },
            { header: 'Amount', key: 'amount', width: 12 }
        ];
        office.expenses.forEach(e => {
            expenseSheet.addRow({ ...e.toObject(), date: e.date.toLocaleDateString() });
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=AMC_${office.officeName.replace(/\s+/g, '_')}.xlsx`);
        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (err) { res.status(500).send(err.message); }
});

// ============ AGENT-SIDE AMC ROUTES ============

// Agent's AMC dashboard - shows assigned visits
app.get('/agent/amc', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    const agent = req.session.user.username;
    
    // Find all offices that have visits assigned to this agent
    const offices = await AMCOffice.find({ 'visits.assignedAgent': agent });
    
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const myVisits = [];
    
    offices.forEach(off => {
        off.visits.forEach(v => {
            if (v.assignedAgent === agent) {
                myVisits.push({
                    ...v.toObject(),
                    officeId: off._id,
                    officeName: off.officeName,
                    contactPerson: off.contactPerson,
                    contactMobile: off.contactMobile,
                    address: off.address
                });
            }
        });
    });
    
    // Sort: today first, then upcoming, then past
    myVisits.sort((a, b) => new Date(a.visitDate) - new Date(b.visitDate));
    
    const todayVisits = myVisits.filter(v => {
        const vd = new Date(v.visitDate); vd.setHours(0, 0, 0, 0);
        return vd.getTime() === today.getTime() && v.status !== 'Completed';
    });
    const upcomingVisits = myVisits.filter(v => {
        const vd = new Date(v.visitDate); vd.setHours(0, 0, 0, 0);
        return vd.getTime() > today.getTime() && v.status === 'Scheduled';
    });
    const inProgressVisits = myVisits.filter(v => v.status === 'In Progress');
    const completedVisits = myVisits.filter(v => v.status === 'Completed').slice(-10).reverse();
    
    res.render('agent-amc', {
        agentName: agent,
        todayVisits, upcomingVisits, inProgressVisits, completedVisits
    });
});

// Agent visit detail page (start/work on a visit)
app.get('/agent/amc/:officeId/visit/:visitId', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        if (!office) return res.status(404).send('Office not found');
        const visit = office.visits.id(req.params.visitId);
        if (!visit) return res.status(404).send('Visit not found');
        if (visit.assignedAgent !== req.session.user.username) {
            return res.status(403).send('Not assigned to you');
        }
        res.render('agent-visit', { agentName: req.session.user.username, office, visit });
    } catch (e) { res.status(500).send(e.message); }
});

// Start visit
app.post('/api/amc/offices/:officeId/visits/:visitId/start', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        const visit = office.visits.id(req.params.visitId);
        if (!visit) return res.status(404).json({ error: 'Visit not found' });
        visit.status = 'In Progress';
        visit.startedAt = new Date();
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add/update PC service log within a visit
app.post('/api/amc/offices/:officeId/visits/:visitId/service-pc', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        const visit = office.visits.id(req.params.visitId);
        if (!visit) return res.status(404).json({ error: 'Visit not found' });
        
        const { pcId, logId, ...serviceData } = req.body;
        
        // Update or add service log
        let log;
        if (logId) {
            log = visit.pcServiceLogs.id(logId);
            if (log) Object.assign(log, serviceData);
        } else {
            visit.pcServiceLogs.push({ pcId, ...serviceData, servicedAt: new Date(), serviceComplete: true });
            log = visit.pcServiceLogs[visit.pcServiceLogs.length - 1];
        }
        
        // Also update the master PC record in office.pcs
        const pc = office.pcs.find(p => p.pcId === pcId);
        if (pc && serviceData.isUnderAMC !== false) {
            ['motherboard', 'cpu', 'ramStatus', 'hddHealth', 'fan', 'temperature', 'battery', 'monitor'].forEach(field => {
                if (serviceData[field]) pc[field] = serviceData[field];
            });
            if (serviceData.beforePhoto) pc.beforePhoto = serviceData.beforePhoto;
            if (serviceData.afterPhoto) pc.afterPhoto = serviceData.afterPhoto;
            pc.lastServicedDate = new Date();
            pc.lastServicedBy = req.session.user.username;
            pc.remarks = serviceData.workDone || pc.remarks;
            
            // Recalculate status & suggestions
            pc.suggestions = generateSuggestions(pc);
            pc.overallStatus = calculateOverallStatus(pc);
        }
        
        // Recalculate visit extra bill total
        visit.extraBillAmount = visit.pcServiceLogs.reduce((s, l) => s + (l.extraWorkAmount || 0), 0);
        
        await office.save();
        res.json({ success: true, log });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Delete a PC service log
app.delete('/api/amc/offices/:officeId/visits/:visitId/service-pc/:logId', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        const visit = office.visits.id(req.params.visitId);
        visit.pcServiceLogs.id(req.params.logId).deleteOne();
        visit.extraBillAmount = visit.pcServiceLogs.reduce((s, l) => s + (l.extraWorkAmount || 0), 0);
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Complete visit
app.post('/api/amc/offices/:officeId/visits/:visitId/complete', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        const visit = office.visits.id(req.params.visitId);
        if (!visit) return res.status(404).json({ error: 'Visit not found' });
        visit.status = 'Completed';
        visit.completedAt = new Date();
        visit.visitSummary = req.body.visitSummary || '';
        visit.extraBillAmount = visit.pcServiceLogs.reduce((s, l) => s + (l.extraWorkAmount || 0), 0);
        await office.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Agent can also add new PCs (for offices they have visits in)
app.post('/api/agent/amc/offices/:id/pcs', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.id);
        // Verify agent has a visit assigned to this office
        const hasAccess = office.visits.some(v => v.assignedAgent === req.session.user.username);
        if (!hasAccess && req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'No access to this office' });
        }
        const pcData = req.body;
        pcData.suggestions = generateSuggestions(pcData);
        pcData.overallStatus = calculateOverallStatus(pcData);
        pcData.lastServicedBy = req.session.user.username;
        pcData.lastServicedDate = new Date();
        office.pcs.push(pcData);
        await office.save();
        res.json({ success: true, office });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Visit Service Report PDF
app.get('/amc/visit/:officeId/:visitId/report', requireAuth, async (req, res) => {
    try {
        const office = await AMCOffice.findById(req.params.officeId);
        if (!office) return res.status(404).send('Office not found');
        const visit = office.visits.id(req.params.visitId);
        if (!visit) return res.status(404).send('Visit not found');
        
        const doc = new PDFDocument({ margin: 40, size: 'A4', autoFirstPage: true });
        res.setHeader('Content-disposition', `attachment; filename=Visit_Report_${office.officeName.replace(/\s+/g, '_')}_${new Date(visit.visitDate).toISOString().split('T')[0]}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        
        const reportNum = 'SEA-VR-' + visit._id.toString().slice(-6).toUpperCase();
        drawPdfHeader(doc, 'VISIT SERVICE REPORT', reportNum);
        
        let y = 155;
        
        // Office card & visit card
        doc.roundedRect(40, y, 250, 110, 8).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text('CLIENT DETAILS', 52, y + 12);
        doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text(office.officeName, 52, y + 28, { width: 226, lineBreak: false });
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        if (office.companyName) doc.text(office.companyName, 52, y + 48, { width: 226, lineBreak: false });
        doc.text('Contact: ' + office.contactPerson, 52, y + 62, { width: 226, lineBreak: false });
        doc.text('Mobile: ' + office.contactMobile, 52, y + 76, { width: 226, lineBreak: false });
        doc.text(office.address || '', 52, y + 90, { width: 226, lineBreak: false, height: 12 });
        
        doc.roundedRect(305, y, 250, 110, 8).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.fillColor('#1e40af').fontSize(8).font('Helvetica-Bold').text('VISIT DETAILS', 317, y + 12);
        doc.fillColor('#475569').fontSize(9).font('Helvetica');
        doc.text('Date: ', 317, y + 30, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(new Date(visit.visitDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), { lineBreak: false });
        doc.fillColor('#475569').font('Helvetica').text('Time: ', 317, y + 46, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(visit.visitTime, { lineBreak: false });
        doc.fillColor('#475569').font('Helvetica').text('Engineer: ', 317, y + 62, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(visit.assignedAgent.toUpperCase(), { lineBreak: false });
        doc.fillColor('#475569').font('Helvetica').text('Purpose: ', 317, y + 78, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(visit.purpose, { lineBreak: false });
        doc.fillColor('#475569').font('Helvetica').text('PCs Serviced: ', 317, y + 94, { continued: true, lineBreak: false }).fillColor('#16a34a').font('Helvetica-Bold').text(String(visit.pcServiceLogs.length), { lineBreak: false });
        
        y += 130;
        
        // PCs Serviced Table
        doc.rect(40, y, 515, 28).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text('PCs SERVICED IN THIS VISIT', 0, y + 9, { align: 'center', width: doc.page.width, lineBreak: false });
        y += 28;
        
        // Table header
        doc.rect(40, y, 515, 20).fill('#1e293b');
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
        doc.text('PC ID', 50, y + 6, { width: 60, lineBreak: false });
        doc.text('STATUS', 115, y + 6, { width: 70, lineBreak: false });
        doc.text('WORK DONE', 190, y + 6, { width: 200, lineBreak: false });
        doc.text('TYPE', 395, y + 6, { width: 60, lineBreak: false });
        doc.text('EXTRA', 460, y + 6, { width: 85, align: 'right', lineBreak: false });
        y += 20;
        
        let totalExtra = 0;
        if (visit.pcServiceLogs.length === 0) {
            doc.rect(40, y, 515, 30).fillAndStroke('#fef3c7', '#fcd34d');
            doc.fillColor('#92400e').fontSize(10).font('Helvetica').text('No PCs serviced in this visit yet.', 0, y + 10, { align: 'center', width: doc.page.width, lineBreak: false });
            y += 30;
        } else {
            visit.pcServiceLogs.forEach((log, idx) => {
                const rowH = 28;
                if (idx % 2 === 0) doc.rect(40, y, 515, rowH).fill('#f8fafc');
                
                doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(log.pcId, 50, y + 9, { width: 60, lineBreak: false });
                
                // Status color
                const issues = ['motherboard', 'cpu', 'ramStatus', 'hddHealth', 'fan', 'monitor'].filter(f => log[f] !== 'Good').length;
                const statusText = issues === 0 ? 'HEALTHY' : issues <= 2 ? 'ISSUES' : 'CRITICAL';
                const statusColor = issues === 0 ? '#15803d' : issues <= 2 ? '#b45309' : '#b91c1c';
                doc.fillColor(statusColor).fontSize(9).font('Helvetica-Bold').text(statusText, 115, y + 9, { width: 70, lineBreak: false });
                
                doc.fillColor('#334155').font('Helvetica').fontSize(8.5).text(log.workDone || '-', 190, y + 6, { width: 195, height: 22, lineBreak: true });
                
                // Type badge
                doc.fillColor(log.isUnderAMC ? '#15803d' : '#b45309').fontSize(8).font('Helvetica-Bold').text(log.isUnderAMC ? 'AMC' : 'EXTRA', 395, y + 9, { width: 60, lineBreak: false });
                
                doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(log.extraWorkAmount > 0 ? 'Rs.' + log.extraWorkAmount.toLocaleString('en-IN') : '-', 460, y + 9, { width: 85, align: 'right', lineBreak: false });
                
                totalExtra += log.extraWorkAmount || 0;
                y += rowH;
            });
        }
        
        y += 10;
        
        // Bill summary
        doc.roundedRect(305, y, 250, 70, 8).fillAndStroke('#f0fdf4', '#86efac');
        doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold').text('VISIT BILLING SUMMARY', 317, y + 10, { lineBreak: false });
        doc.fillColor('#475569').fontSize(9).font('Helvetica').text('AMC Service:', 317, y + 28, { lineBreak: false });
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Included in Contract', 0, y + 28, { width: 540, align: 'right', lineBreak: false });
        doc.fillColor('#475569').font('Helvetica').text('Extra Work:', 317, y + 44, { lineBreak: false });
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Rs. ' + totalExtra.toLocaleString('en-IN'), 0, y + 44, { width: 540, align: 'right', lineBreak: false });
        doc.moveTo(320, y + 58).lineTo(540, y + 58).strokeColor('#86efac').stroke();
        doc.fillColor('#15803d').fontSize(11).font('Helvetica-Bold').text('TOTAL DUE: Rs. ' + totalExtra.toLocaleString('en-IN'), 0, y + 62, { width: 545, align: 'right', lineBreak: false });
        
        y += 80;
        
        // Visit summary
        if (visit.visitSummary || visit.notes) {
            doc.roundedRect(40, y, 515, 50, 8).fillAndStroke('#fffbeb', '#fcd34d');
            doc.fillColor('#92400e').fontSize(9).font('Helvetica-Bold').text('VISIT NOTES', 52, y + 10, { lineBreak: false });
            doc.fillColor('#451a03').fontSize(9).font('Helvetica').text(visit.visitSummary || visit.notes, 52, y + 24, { width: 491, height: 24, lineBreak: true });
        }
        
        drawPdfFooter(doc);
        doc.end();
    } catch (err) { console.error(err); res.status(500).send('Error generating report'); }
});

// ======================== VENDOR MANAGEMENT ========================

app.get('/vendors', requireAuth, requireAdmin, async (req, res) => {
    const vendors = await Vendor.find().select('-bills.billDocument').sort({ createdAt: -1 }).limit(100).lean();
    
    // Aggregate stats
    let totalPurchased = 0, totalPaid = 0, totalPending = 0;
    vendors.forEach(v => {
        const billsTotal = (v.bills || []).reduce((s, b) => s + (b.grandTotal || 0), 0);
        const payments = (v.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
        totalPurchased += billsTotal;
        totalPaid += payments;
        totalPending += Math.max(0, billsTotal - payments);
    });
    
    res.render('vendors', { 
        user: req.session.user, 
        vendors,
        stats: { totalPurchased, totalPaid, totalPending, totalVendors: vendors.length }
    });
});

// Smart vendor compare page
app.get('/vendor-compare', requireAuth, requireAdmin, async (req, res) => {
    res.render('vendor-compare', { user: req.session.user, query: req.query.product || '' });
});

app.get('/vendors/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        if (!vendor) return res.status(404).send('Vendor not found');
        res.render('vendor-detail', { user: req.session.user, vendor });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/vendors', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = new Vendor(req.body);
        await vendor.save();
        res.json({ success: true, vendor });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/vendors/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, vendor });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/vendors/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Vendor.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add bill to vendor - AUTO ADDS TO STOCK
app.post('/api/vendors/:id/bills', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        const billData = req.body;
        
        // Calculate totals
        let subtotal = 0, totalGst = 0;
        (billData.items || []).forEach(item => {
            const sub = (item.quantity || 0) * (item.unitCost || 0);
            const gst = sub * (item.gstPercent || 0) / 100;
            item.totalCost = sub + gst;
            subtotal += sub;
            totalGst += gst;
        });
        billData.subtotal = subtotal;
        billData.totalGst = totalGst;
        billData.grandTotal = subtotal + totalGst;
        billData.pending = billData.grandTotal - (billData.paid || 0);
        billData.paymentStatus = billData.paid >= billData.grandTotal ? 'Paid' : billData.paid > 0 ? 'Partial' : 'Unpaid';
        
        vendor.bills.push(billData);
        const savedBill = vendor.bills[vendor.bills.length - 1];
        
        // AUTO-ADD items to Stock
        for (const item of savedBill.items) {
            // Find or create stock item
            let stockItem = await StockItem.findOne({ 
                productName: item.productName,
                $or: [{ category: item.category }, { category: { $exists: false } }]
            });
            
            if (!stockItem) {
                stockItem = new StockItem({
                    productName: item.productName,
                    category: item.category || 'General',
                    unit: item.unit || 'Pcs',
                    specifications: item.description || '',
                    primaryVendor: vendor.vendorName,
                    sellingPrice: item.sellingPrice || (item.unitCost * 1.2),
                    gstPercent: item.gstPercent || 18,
                    avgCostPrice: item.unitCost,
                    lastCostPrice: item.unitCost,
                    currentStock: 0,
                    serialNumbers: []
                });
            }
            
            // Update vendor link
            if (!stockItem.vendorRefs.includes(vendor._id)) {
                stockItem.vendorRefs.push(vendor._id);
            }
            
            // Calculate weighted avg cost
            const totalValue = (stockItem.currentStock * stockItem.avgCostPrice) + (item.quantity * item.unitCost);
            const totalQty = stockItem.currentStock + item.quantity;
            stockItem.avgCostPrice = totalQty > 0 ? totalValue / totalQty : item.unitCost;
            stockItem.lastCostPrice = item.unitCost;
            
            // Increase stock
            stockItem.currentStock += item.quantity;
            if (item.serialNumbers && item.serialNumbers.length > 0) {
                stockItem.serialNumbers.push(...item.serialNumbers);
            }
            
            // Add movement log
            stockItem.movements.push({
                type: 'IN',
                quantity: item.quantity,
                unitCost: item.unitCost,
                totalValue: item.quantity * item.unitCost,
                source: 'Vendor Bill',
                sourceRef: `${vendor.vendorName} - ${billData.billNumber}`,
                handledBy: billData.receivedBy || req.session.user.username,
                serialNumbers: item.serialNumbers || [],
                notes: `From bill ${billData.billNumber}`
            });
            
            await stockItem.save();
            item.stockItemId = stockItem._id;
        }
        
        await vendor.save();
        res.json({ success: true, vendor });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.delete('/api/vendors/:id/bills/:billId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        vendor.bills.id(req.params.billId).deleteOne();
        await vendor.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Vendor payment
app.post('/api/vendors/:id/payments', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        vendor.payments.push(req.body);
        await vendor.save();
        res.json({ success: true, vendor });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/vendors/:id/payments/:pId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        vendor.payments.id(req.params.pId).deleteOne();
        await vendor.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Record item sold to client (manually mark on bill item)
app.post('/api/vendors/:id/bills/:billId/items/:itemId/sold', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        const bill = vendor.bills.id(req.params.billId);
        const item = bill.items.id(req.params.itemId);
        item.soldTo.push(req.body);
        await vendor.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Vendor Excel export
app.get('/api/vendors/:id/export', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendor = await Vendor.findById(req.params.id);
        if (!vendor) return res.status(404).send('Not found');
        
        const workbook = new exceljs.Workbook();
        
        // Sheet 1: Bills
        const billSheet = workbook.addWorksheet('Bills');
        billSheet.columns = [
            { header: 'Bill No', key: 'billNumber', width: 15 },
            { header: 'Date', key: 'billDate', width: 12 },
            { header: 'Items', key: 'itemCount', width: 8 },
            { header: 'Subtotal', key: 'subtotal', width: 12 },
            { header: 'GST', key: 'totalGst', width: 12 },
            { header: 'Grand Total', key: 'grandTotal', width: 14 },
            { header: 'Paid', key: 'paid', width: 12 },
            { header: 'Pending', key: 'pending', width: 12 },
            { header: 'Status', key: 'paymentStatus', width: 12 },
            { header: 'Received By', key: 'receivedBy', width: 14 }
        ];
        vendor.bills.forEach(b => {
            billSheet.addRow({
                billNumber: b.billNumber,
                billDate: b.billDate.toLocaleDateString(),
                itemCount: b.items.length,
                subtotal: b.subtotal, totalGst: b.totalGst, grandTotal: b.grandTotal,
                paid: b.paid, pending: b.pending,
                paymentStatus: b.paymentStatus, receivedBy: b.receivedBy
            });
        });
        
        // Sheet 2: All Items
        const itemSheet = workbook.addWorksheet('Items');
        itemSheet.columns = [
            { header: 'Bill', key: 'bill', width: 14 },
            { header: 'Product', key: 'productName', width: 25 },
            { header: 'Category', key: 'category', width: 14 },
            { header: 'Qty', key: 'quantity', width: 8 },
            { header: 'Unit Cost', key: 'unitCost', width: 12 },
            { header: 'Selling Price', key: 'sellingPrice', width: 12 },
            { header: 'Warranty', key: 'warranty', width: 14 },
            { header: 'Serials', key: 'serials', width: 30 },
            { header: 'Sold To Clients', key: 'sold', width: 40 }
        ];
        vendor.bills.forEach(b => {
            b.items.forEach(it => {
                itemSheet.addRow({
                    bill: b.billNumber,
                    productName: it.productName, category: it.category,
                    quantity: it.quantity, unitCost: it.unitCost, sellingPrice: it.sellingPrice,
                    warranty: it.warranty,
                    serials: (it.serialNumbers || []).join(', '),
                    sold: (it.soldTo || []).map(s => `${s.clientName} (${s.quantity})`).join(', ')
                });
            });
        });
        
        // Sheet 3: Payments
        const paySheet = workbook.addWorksheet('Payments');
        paySheet.columns = [
            { header: 'Date', key: 'paymentDate', width: 14 },
            { header: 'Amount', key: 'amount', width: 12 },
            { header: 'Mode', key: 'paymentMode', width: 14 },
            { header: 'Ref', key: 'transactionRef', width: 20 },
            { header: 'Bill Ref', key: 'billRef', width: 14 }
        ];
        vendor.payments.forEach(p => {
            paySheet.addRow({
                paymentDate: p.paymentDate.toLocaleDateString(),
                amount: p.amount, paymentMode: p.paymentMode,
                transactionRef: p.transactionRef, billRef: p.billRef
            });
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Vendor_${vendor.vendorName.replace(/\s+/g, '_')}.xlsx`);
        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (e) { res.status(500).send(e.message); }
});

// ======================== STOCK MANAGEMENT ========================

app.get('/stock', requireAuth, requireAdmin, async (req, res) => {
    const items = await StockItem.find().select('-movements').sort({ category: 1, productName: 1 }).limit(500).lean();
    
    let totalValue = 0, totalItems = 0, lowStockCount = 0;
    const categoryStats = {};
    items.forEach(i => {
        const val = i.currentStock * (i.avgCostPrice || i.lastCostPrice);
        totalValue += val;
        totalItems += i.currentStock;
        if (i.currentStock <= i.minStockLevel) lowStockCount++;
        categoryStats[i.category] = (categoryStats[i.category] || 0) + val;
    });
    
    res.render('stock', { 
        user: req.session.user, 
        items,
        stats: { totalValue, totalItems, lowStockCount, totalProducts: items.length, categoryStats }
    });
});

app.get('/stock/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const item = await StockItem.findById(req.params.id);
        if (!item) return res.status(404).send('Not found');
        res.render('stock-detail', { user: req.session.user, item });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/stock', requireAuth, requireAdmin, async (req, res) => {
    try {
        const item = new StockItem(req.body);
        await item.save();
        res.json({ success: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/stock/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const item = await StockItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/stock/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await StockItem.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Stock movement (IN/OUT)
app.post('/api/stock/:id/movement', requireAuth, async (req, res) => {
    try {
        const item = await StockItem.findById(req.params.id);
        const { type, quantity, unitCost, source, sourceRef, clientName, notes, serialNumbers } = req.body;
        const qty = Number(quantity) || 0;
        
        if (type === 'OUT' && item.currentStock < qty) {
            return res.status(400).json({ error: `Only ${item.currentStock} in stock` });
        }
        
        if (type === 'IN') {
            const totalValue = (item.currentStock * item.avgCostPrice) + (qty * (unitCost || item.lastCostPrice));
            const totalQty = item.currentStock + qty;
            item.avgCostPrice = totalQty > 0 ? totalValue / totalQty : (unitCost || item.lastCostPrice);
            item.lastCostPrice = unitCost || item.lastCostPrice;
            item.currentStock += qty;
            if (serialNumbers && serialNumbers.length > 0) {
                item.serialNumbers.push(...serialNumbers);
            }
        } else if (type === 'OUT') {
            item.currentStock = Math.max(0, item.currentStock - qty);
            if (serialNumbers && serialNumbers.length > 0) {
                item.serialNumbers = item.serialNumbers.filter(sn => !serialNumbers.includes(sn));
            }
        } else if (type === 'ADJUSTMENT') {
            item.currentStock = qty;
        }
        
        item.movements.push({
            type, quantity: qty,
            unitCost: unitCost || item.lastCostPrice,
            totalValue: qty * (unitCost || item.lastCostPrice),
            source: source || 'Manual',
            sourceRef: sourceRef || '',
            handledBy: req.session.user.username,
            clientName: clientName || '',
            notes: notes || '',
            serialNumbers: serialNumbers || []
        });
        
        await item.save();
        res.json({ success: true, item });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.get('/api/stock/export', requireAuth, requireAdmin, async (req, res) => {
    const items = await StockItem.find().select('-movements').sort({ category: 1, productName: 1 }).limit(500).lean();
    const workbook = new exceljs.Workbook();
    
    // Sheet 1: Current Stock
    const stockSheet = workbook.addWorksheet('Current Stock');
    stockSheet.columns = [
        { header: 'Product', key: 'productName', width: 25 },
        { header: 'Code', key: 'productCode', width: 12 },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Brand', key: 'brand', width: 14 },
        { header: 'Stock', key: 'currentStock', width: 8 },
        { header: 'Min Level', key: 'minStockLevel', width: 10 },
        { header: 'Avg Cost', key: 'avgCostPrice', width: 12 },
        { header: 'Selling', key: 'sellingPrice', width: 12 },
        { header: 'Total Value', key: 'totalValue', width: 14 },
        { header: 'Vendor', key: 'primaryVendor', width: 18 },
        { header: 'Location', key: 'location', width: 14 }
    ];
    items.forEach(i => {
        stockSheet.addRow({
            productName: i.productName, productCode: i.productCode,
            category: i.category, brand: i.brand,
            currentStock: i.currentStock, minStockLevel: i.minStockLevel,
            avgCostPrice: Math.round(i.avgCostPrice), sellingPrice: i.sellingPrice,
            totalValue: Math.round(i.currentStock * i.avgCostPrice),
            primaryVendor: i.primaryVendor, location: i.location
        });
    });
    
    // Sheet 2: All Movements
    const movSheet = workbook.addWorksheet('All Movements');
    movSheet.columns = [
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Product', key: 'product', width: 25 },
        { header: 'Type', key: 'type', width: 10 },
        { header: 'Quantity', key: 'quantity', width: 10 },
        { header: 'Unit Cost', key: 'unitCost', width: 12 },
        { header: 'Total Value', key: 'totalValue', width: 14 },
        { header: 'Source', key: 'source', width: 18 },
        { header: 'Reference', key: 'sourceRef', width: 25 },
        { header: 'Handled By', key: 'handledBy', width: 14 },
        { header: 'Client', key: 'clientName', width: 18 },
        { header: 'Notes', key: 'notes', width: 30 }
    ];
    items.forEach(i => {
        (i.movements || []).forEach(m => {
            movSheet.addRow({
                date: m.movementDate.toLocaleDateString(),
                product: i.productName,
                type: m.type, quantity: m.quantity,
                unitCost: m.unitCost, totalValue: m.totalValue,
                source: m.source, sourceRef: m.sourceRef,
                handledBy: m.handledBy, clientName: m.clientName,
                notes: m.notes
            });
        });
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Stock_Report.xlsx');
    return workbook.xlsx.write(res).then(() => res.status(200).end());
});

// ======================== TOOLS MANAGEMENT ========================

app.get('/tools', requireAuth, requireAdmin, async (req, res) => {
    const tools = await Tool.find().select('-photo').sort({ createdAt: -1 }).limit(100).lean();
    
    let totalPurchase = 0, totalMaintenance = 0, totalIssued = 0;
    tools.forEach(t => {
        totalPurchase += t.purchaseCost || 0;
        totalMaintenance += (t.maintenanceLogs || []).reduce((s, m) => s + (m.cost || 0), 0);
        totalIssued += (t.issueLogs || []).filter(l => l.status === 'Issued').length;
    });
    
    res.render('tools', { 
        user: req.session.user, 
        tools,
        stats: { 
            totalPurchase, totalMaintenance, 
            totalInvestment: totalPurchase + totalMaintenance,
            totalTools: tools.length, totalIssued
        }
    });
});

app.get('/tools/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tool = await Tool.findById(req.params.id);
        if (!tool) return res.status(404).send('Not found');
        res.render('tool-detail', { user: req.session.user, tool });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/tools', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        data.availableQuantity = data.quantity || 1;
        const tool = new Tool(data);
        await tool.save();
        res.json({ success: true, tool });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/tools/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tool = await Tool.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, tool });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/tools/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Tool.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Issue tool
app.post('/api/tools/:id/issue', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tool = await Tool.findById(req.params.id);
        const qty = Number(req.body.quantity) || 1;
        if (tool.availableQuantity < qty) {
            return res.status(400).json({ error: `Only ${tool.availableQuantity} available` });
        }
        tool.issueLogs.push({ ...req.body, quantity: qty, status: 'Issued' });
        tool.availableQuantity -= qty;
        await tool.save();
        res.json({ success: true, tool });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Return tool
app.post('/api/tools/:id/return/:logId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tool = await Tool.findById(req.params.id);
        const log = tool.issueLogs.id(req.params.logId);
        if (!log) return res.status(404).json({ error: 'Log not found' });
        
        const retQty = Number(req.body.returnedQuantity) || log.quantity;
        log.returnedQuantity = retQty;
        log.returnedDate = new Date();
        log.returnCondition = req.body.returnCondition || 'Good';
        log.status = req.body.returnCondition === 'Lost' ? 'Lost' : req.body.returnCondition === 'Damaged' ? 'Damaged' : 'Returned';
        log.notes = req.body.notes || log.notes;
        
        // Add back to available only if returned in usable condition
        if (log.status !== 'Lost' && log.status !== 'Damaged') {
            tool.availableQuantity += retQty;
        }
        
        await tool.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add maintenance
app.post('/api/tools/:id/maintenance', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tool = await Tool.findById(req.params.id);
        tool.maintenanceLogs.push(req.body);
        await tool.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======================== LEAD / ENQUIRY MANAGEMENT ========================

app.get('/leads', requireAuth, async (req, res) => {
    const me = req.session.user.username;
    const isAdmin = req.session.user.role === 'admin';
    
    // Filter for agent
    const filter = isAdmin ? {} : { assignedTo: me };
    const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    
    const stats = {
        total: leads.length,
        new: leads.filter(l => l.status === 'New').length,
        contacted: leads.filter(l => l.status === 'Contacted').length,
        meeting: leads.filter(l => ['Meeting Scheduled', 'Site Visit Done'].includes(l.status)).length,
        vendorQuoting: leads.filter(l => ['Vendor Quotes Pending', 'Vendor Quotes Received'].includes(l.status)).length,
        quoteSent: leads.filter(l => l.status === 'Quote Sent').length,
        won: leads.filter(l => l.status === 'Won').length,
        lost: leads.filter(l => l.status === 'Lost').length,
        totalValue: leads.reduce((s, l) => s + (l.estimatedValue || 0), 0),
        wonValue: leads.filter(l => l.status === 'Won').reduce((s, l) => s + (l.wonAmount || l.estimatedValue || 0), 0),
        // Agent specific
        myNew: leads.filter(l => l.assignedTo === me && !l.agentSeenAt && !['Won', 'Lost'].includes(l.status)).length,
        inProgress: leads.filter(l => l.agentSeenAt && !['Won', 'Lost'].includes(l.status)).length
    };
    
    // Today's follow-ups (lean objects, no toObject)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const todayFollowUps = [];
    leads.forEach(lead => {
        (lead.followUps || []).forEach(f => {
            const fd = new Date(f.date);
            if (fd >= today && fd < tomorrow && f.status === 'Scheduled') {
                todayFollowUps.push({ ...f, leadId: lead._id, leadName: lead.leadName, mobile: lead.mobile });
            }
        });
    });
    
    res.render('leads', { user: req.session.user, leads, stats, todayFollowUps });
});

// Agent-specific leads page
app.get('/agent/leads', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/leads');
    const me = req.session.user.username;
    
    const leads = await Lead.find({ assignedTo: me }).sort({ createdAt: -1 }).limit(100).lean();
    
    const stats = {
        total: leads.length,
        new: leads.filter(l => !l.agentSeenAt && !['Won', 'Lost'].includes(l.status)).length,
        inProgress: leads.filter(l => l.agentSeenAt && !['Won', 'Lost'].includes(l.status)).length,
        won: leads.filter(l => l.status === 'Won').length,
        lost: leads.filter(l => l.status === 'Lost').length,
        myNew: 0,
        contacted: 0, meeting: 0, vendorQuoting: 0, quoteSent: 0,
        totalValue: leads.reduce((s, l) => s + (l.estimatedValue || 0), 0),
        wonValue: leads.filter(l => l.status === 'Won').reduce((s, l) => s + (l.wonAmount || 0), 0)
    };
    
    res.render('agent-leads', { user: req.session.user, agentName: me, leads, stats });
});

app.get('/leads/:id', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).send('Lead not found');
        
        // Auto-mark seen if agent opens
        if (req.session.user.role === 'agent' && 
            lead.assignedTo === req.session.user.username && 
            !lead.agentSeenAt) {
            lead.agentSeenAt = new Date();
            lead.agentNotified = true;
            lead.progress.push({
                action: 'Lead Opened by Agent',
                description: `${req.session.user.username.toUpperCase()} acknowledged this lead`,
                actor: req.session.user.username
            });
            await lead.save();
        }
        
        res.render('lead-detail', { user: req.session.user, lead });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
    try {
        const data = req.body;
        const count = await Lead.countDocuments();
        data.leadNumber = `SEA-L-${String(count + 1).padStart(4, '0')}`;
        
        // Auto-log creation
        data.progress = [{
            action: 'Lead Created',
            description: `New lead from ${data.source || 'Direct'}. Interested in: ${(data.interestedIn || []).join(', ')}`,
            actor: req.session.user.username,
            statusChange: 'New'
        }];
        
        // If assigned, log assignment + set notification
        if (data.assignedTo) {
            data.assignedAt = new Date();
            data.assignedBy = req.session.user.username;
            data.agentNotified = false;
            data.progress.push({
                action: 'Assigned to Agent',
                description: `Lead assigned to ${data.assignedTo.toUpperCase()} by ${req.session.user.username}`,
                actor: req.session.user.username
            });
        }
        
        data.lastActivityAt = new Date();
        
        const lead = new Lead(data);
        lead.progressPercent = lead.computeProgress();
        await lead.save();
        res.json({ success: true, lead });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        const editor = req.session.user.username;
        const updates = req.body;
        
        // Track status change
        if (updates.status && updates.status !== lead.status) {
            lead.progress.push({
                action: 'Status Updated',
                description: `${lead.status} → ${updates.status}`,
                actor: editor,
                statusChange: updates.status
            });
        }
        
        // Track assignment change
        if (updates.assignedTo !== undefined && updates.assignedTo !== lead.assignedTo) {
            lead.progress.push({
                action: 'Reassigned',
                description: `Now assigned to ${(updates.assignedTo || 'Unassigned').toUpperCase()}`,
                actor: editor
            });
            if (updates.assignedTo) {
                lead.assignedAt = new Date();
                lead.assignedBy = editor;
                lead.agentNotified = false;
                lead.agentSeenAt = null;
            }
        }
        
        Object.assign(lead, updates);
        lead.lastActivityAt = new Date();
        lead.progressPercent = lead.computeProgress();
        
        await lead.save();
        res.json({ success: true, lead });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Lead.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === Mark lead as SEEN by agent (notification cleared) ===
app.post('/api/leads/:id/seen', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        if (lead.assignedTo === req.session.user.username && !lead.agentSeenAt) {
            lead.agentSeenAt = new Date();
            lead.agentNotified = true;
            lead.progress.push({
                action: 'Lead Opened by Agent',
                description: `${req.session.user.username.toUpperCase()} acknowledged this lead`,
                actor: req.session.user.username
            });
            await lead.save();
        }
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === VENDOR ESTIMATES (agent gets quotes from vendors) ===
app.post('/api/leads/:id/vendor-estimates', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        const data = req.body;
        data.addedBy = req.session.user.username;
        data.totalPrice = (Number(data.unitPrice) || 0) * (Number(data.quantity) || 1);
        
        lead.vendorEstimates.push(data);
        
        // Log progress
        lead.progress.push({
            action: 'Vendor Estimate Added',
            description: `${data.vendorName}: ₹${data.totalPrice} (${data.productDetails || 'no details'})`,
            actor: req.session.user.username
        });
        
        // Auto-advance status if first estimate
        if (lead.vendorEstimates.length === 1 && ['New', 'Contacted', 'Site Visit Done'].includes(lead.status)) {
            lead.status = 'Vendor Quotes Received';
        }
        
        lead.lastActivityAt = new Date();
        lead.progressPercent = lead.computeProgress();
        await lead.save();
        res.json({ success: true, lead });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.put('/api/leads/:id/vendor-estimates/:vId', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        const est = lead.vendorEstimates.id(req.params.vId);
        if (!est) return res.status(404).json({ error: 'Not found' });
        
        // If marking as selected, unselect others
        if (req.body.isSelected === true) {
            lead.vendorEstimates.forEach(v => { v.isSelected = false; });
            lead.progress.push({
                action: 'Vendor Selected',
                description: `${est.vendorName} chosen for this deal`,
                actor: req.session.user.username
            });
        }
        
        Object.assign(est, req.body);
        if (req.body.unitPrice !== undefined || req.body.quantity !== undefined) {
            est.totalPrice = (Number(est.unitPrice) || 0) * (Number(est.quantity) || 1);
        }
        
        lead.lastActivityAt = new Date();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/leads/:id/vendor-estimates/:vId', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        lead.vendorEstimates.id(req.params.vId).deleteOne();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === ADD PROGRESS NOTE (any action by agent/admin) ===
app.post('/api/leads/:id/progress', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        lead.progress.push({
            action: req.body.action || 'Note Added',
            description: req.body.description || '',
            actor: req.session.user.username,
            photo: req.body.photo || ''
        });
        lead.lastActivityAt = new Date();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === SEND FINAL QUOTE TO CUSTOMER ===
app.post('/api/leads/:id/send-quote', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        lead.finalQuoteAmount = Number(req.body.amount) || 0;
        lead.finalQuoteNotes = req.body.notes || '';
        lead.finalQuotePhoto = req.body.photo || '';
        lead.finalQuoteSentAt = new Date();
        lead.status = 'Quote Sent';
        
        lead.progress.push({
            action: 'Quote Sent to Customer',
            description: `Final quote: ₹${lead.finalQuoteAmount}. ${lead.finalQuoteNotes}`,
            actor: req.session.user.username,
            statusChange: 'Quote Sent'
        });
        
        lead.lastActivityAt = new Date();
        lead.progressPercent = lead.computeProgress();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === MARK AS WON (billing cycle starts) ===
app.post('/api/leads/:id/won', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Not found' });
        
        lead.status = 'Won';
        lead.wonAmount = Number(req.body.wonAmount) || lead.finalQuoteAmount;
        lead.advancePaid = Number(req.body.advancePaid) || 0;
        lead.billingStatus = lead.advancePaid > 0 ? 'Advance Paid' : 'Pending';
        lead.deliveryStatus = 'Pending';
        lead.convertedAt = new Date();
        
        lead.progress.push({
            action: '🏆 Deal Won!',
            description: `Won at ₹${lead.wonAmount}. Advance: ₹${lead.advancePaid}`,
            actor: req.session.user.username,
            statusChange: 'Won'
        });
        
        lead.lastActivityAt = new Date();
        lead.progressPercent = 100;
        
        // Auto-sync to Customer master
        await syncCustomer({
            name: lead.leadName, mobile: lead.mobile,
            companyName: lead.companyName, email: lead.email,
            location: lead.address, address: lead.address
        }, 'Lead-Won');
        
        await lead.save();
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// === MARK AS DELIVERED ===
app.post('/api/leads/:id/delivered', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        lead.deliveryStatus = 'Delivered';
        lead.deliveryDate = new Date();
        lead.progress.push({
            action: '✅ Delivered',
            description: req.body.notes || 'Product delivered & installed',
            actor: req.session.user.username
        });
        lead.lastActivityAt = new Date();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === FINAL PAYMENT RECEIVED ===
app.post('/api/leads/:id/payment', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        const amount = Number(req.body.amount) || 0;
        lead.finalAmountReceived = (lead.finalAmountReceived || 0) + amount;
        
        const totalPaid = lead.advancePaid + lead.finalAmountReceived;
        if (totalPaid >= lead.wonAmount) {
            lead.billingStatus = 'Fully Paid';
        } else if (totalPaid > 0) {
            lead.billingStatus = 'Partial Paid';
        }
        
        lead.progress.push({
            action: '💰 Payment Received',
            description: `₹${amount} via ${req.body.mode || 'cash'}. Total paid: ₹${totalPaid}/${lead.wonAmount}`,
            actor: req.session.user.username
        });
        
        lead.lastActivityAt = new Date();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === GET AGENT'S NEW LEADS COUNT (for notification badge) ===
app.get('/api/leads/my-pending', requireAuth, async (req, res) => {
    try {
        const me = req.session.user.username;
        const newLeads = await Lead.countDocuments({
            assignedTo: me,
            agentSeenAt: null,
            status: { $nin: ['Won', 'Lost'] }
        });
        const inProgress = await Lead.countDocuments({
            assignedTo: me,
            agentSeenAt: { $ne: null },
            status: { $nin: ['Won', 'Lost'] }
        });
        res.json({ newLeads, inProgress, total: newLeads + inProgress });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add follow-up
app.post('/api/leads/:id/followups', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        const data = { ...req.body, scheduledBy: req.session.user.username };
        lead.followUps.push(data);
        await lead.save();
        res.json({ success: true, lead });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/leads/:id/followups/:fId', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        const f = lead.followUps.id(req.params.fId);
        Object.assign(f, req.body);
        if (req.body.status === 'Done') f.handledBy = req.session.user.username;
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/leads/:id/followups/:fId', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        lead.followUps.id(req.params.fId).deleteOne();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add meeting
app.post('/api/leads/:id/meetings', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        lead.meetings.push(req.body);
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/leads/:id/meetings/:mId', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        lead.meetings.id(req.params.mId).deleteOne();
        await lead.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Convert lead - AUTO creates Order/AMC/Quote
app.post('/api/leads/:id/convert', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        const { convertTo } = req.body;
        
        let refId = '';
        
        if (convertTo === 'Hardware Order') {
            const order = await Order.create({
                createdBy: req.session.user.username,
                customerName: lead.leadName,
                mobileNumber: lead.mobile,
                location: lead.address || 'Unknown',
                description: lead.requirement || 'From lead',
                status: 'Pending Vendor Pricing'
            });
            refId = order._id.toString();
        } else if (convertTo === 'AMC Office') {
            const office = await AMCOffice.create({
                officeName: lead.companyName || lead.leadName,
                companyName: lead.companyName,
                contactPerson: lead.leadName,
                contactMobile: lead.mobile,
                contactEmail: lead.email,
                address: lead.address,
                contractStartDate: new Date(),
                notes: `Converted from lead ${lead.leadNumber}. Requirement: ${lead.requirement}`
            });
            refId = office._id.toString();
        } else if (convertTo === 'CCTV Quote') {
            // Direct redirect to quotation builder with prefilled client - we just mark lead converted
            refId = '/cctv/quotation/new';
        }
        
        lead.status = 'Won';
        lead.convertedAt = new Date();
        lead.convertedTo = convertTo;
        lead.convertedRefId = refId;
        await lead.save();
        
        res.json({ success: true, refId, convertTo });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// ======================== CORPORATE ENTRY MODULE ========================

// Helper: compute totals from PCs
function computeCorporateTotals(entry) {
    let subtotal = 0;
    (entry.pcs || []).forEach(p => { subtotal += (Number(p.serviceRate) || 0); });
    entry.subtotal = subtotal;
    
    const afterDiscount = subtotal - (Number(entry.discount) || 0);
    entry.gstAmount = afterDiscount * (Number(entry.gstPercent) || 0) / 100;
    entry.grandTotal = afterDiscount + entry.gstAmount;
    entry.amountDue = Math.max(0, entry.grandTotal - (Number(entry.amountReceived) || 0));
    entry.paymentStatus = entry.amountDue <= 0 ? 'Paid' : entry.amountReceived > 0 ? 'Partial' : 'Pending';
    return entry;
}

// Helper: compute PC overall status
function computePcStatus(pc) {
    const fields = ['motherboard', 'cpu', 'ramStatus', 'ramSlots', 'hddHealth', 'drive', 'fan', 'connectors', 'battery', 'charger', 'powerCable', 'monitor', 'webcam'];
    let issues = 0;
    fields.forEach(f => { if (pc[f] && pc[f] !== 'Good' && pc[f] !== 'N/A') issues++; });
    if (pc.temperature && pc.temperature !== 'Normal') issues++;
    if (issues === 0) return 'Good';
    if (issues <= 2) return 'Needs Attention';
    return 'Critical';
}

// LIST: Corporate Entries (admin view)
app.get('/corporate', requireAuth, requireAdmin, async (req, res) => {
    const entries = await CorporateEntry.find().select('-pcs.beforePhoto -pcs.afterPhoto -editLogs').sort({ createdAt: -1 }).limit(200).lean();
    
    let totalRevenue = 0, totalReceived = 0, totalDue = 0, totalPCs = 0;
    entries.forEach(e => {
        totalRevenue += e.grandTotal || 0;
        totalReceived += e.amountReceived || 0;
        totalDue += e.amountDue || 0;
        totalPCs += (e.pcs || []).length;
    });
    
    res.render('corporate-list', {
        user: req.session.user,
        entries,
        stats: { totalEntries: entries.length, totalPCs, totalRevenue, totalReceived, totalDue }
    });
});

// NEW Corporate Entry form
app.get('/corporate/new', requireAuth, (req, res) => {
    res.render('corporate-new', { user: req.session.user, agentName: req.session.user.username });
});

// Agent view
app.get('/agent/corporate/new', requireAuth, (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    res.render('corporate-new', { user: req.session.user, agentName: req.session.user.username });
});

// Corporate Detail
app.get('/corporate/:id', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        if (!entry) return res.status(404).send('Not found');
        res.render('corporate-detail', { user: req.session.user, entry });
    } catch (e) { res.status(500).send(e.message); }
});

// Create
app.post('/api/corporate', requireAuth, async (req, res) => {
    try {
        const count = await CorporateEntry.countDocuments();
        const data = req.body;
        data.entryNumber = `SEA-CORP-${String(count + 1).padStart(4, '0')}`;
        data.createdBy = req.session.user.username;
        data.agentName = data.agentName || req.session.user.username;
        
        // Compute PC status
        (data.pcs || []).forEach(p => { p.overallStatus = computePcStatus(p); });
        
        // Compute totals
        computeCorporateTotals(data);
        
        if (data.jobStatus === 'Completed' && !data.completedAt) data.completedAt = new Date();
        
        const entry = new CorporateEntry(data);
        await entry.save();
        res.json({ success: true, entry });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Update with edit log
app.put('/api/corporate/:id', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        
        const editor = req.session.user.username;
        const updates = req.body;
        const editLogs = [];
        
        // Track changes for simple top-level fields
        const trackedFields = ['customerName', 'companyName', 'mobileNumber', 'location', 'visitDate', 'visitTime', 'serviceType', 'overallRemarks', 'amountReceived', 'discount', 'discountReason', 'paymentMode', 'gstPercent'];
        trackedFields.forEach(f => {
            if (updates[f] !== undefined && String(entry[f] || '') !== String(updates[f] || '')) {
                editLogs.push({
                    editedBy: editor, field: f,
                    oldValue: entry[f], newValue: updates[f]
                });
                entry[f] = updates[f];
            }
        });
        
        // PCs section (replace if provided)
        if (updates.pcs) {
            editLogs.push({
                editedBy: editor, field: 'pcs',
                oldValue: `${entry.pcs.length} PCs`,
                newValue: `${updates.pcs.length} PCs (modified)`
            });
            updates.pcs.forEach(p => { p.overallStatus = computePcStatus(p); });
            entry.pcs = updates.pcs;
        }
        
        editLogs.forEach(log => entry.editLogs.push(log));
        entry.lastModifiedBy = editor;
        
        computeCorporateTotals(entry);
        
        await entry.save();
        res.json({ success: true, entry });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Mark payment
app.post('/api/corporate/:id/payment', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        const { amount, paymentMode, paymentRef } = req.body;
        const editor = req.session.user.username;
        
        const oldReceived = entry.amountReceived;
        entry.amountReceived += Number(amount) || 0;
        entry.paymentMode = paymentMode || entry.paymentMode;
        entry.paymentRef = paymentRef || entry.paymentRef;
        entry.paymentDate = new Date();
        computeCorporateTotals(entry);
        
        entry.editLogs.push({
            editedBy: editor, field: 'payment',
            oldValue: `Received: ${oldReceived}`,
            newValue: `Added: ${amount} via ${paymentMode}. Total: ${entry.amountReceived}`,
            note: 'Payment added'
        });
        
        await entry.save();
        res.json({ success: true, entry });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Capture GPS
app.post('/api/corporate/:id/gps', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        const { latitude, longitude, accuracy, address } = req.body;
        entry.gpsLatitude = latitude;
        entry.gpsLongitude = longitude;
        entry.gpsAccuracy = accuracy;
        entry.gpsAddress = address || '';
        entry.gpsCapturedAt = new Date();
        await entry.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Token verification - admin generates token, customer gets WA, agent enters
app.post('/api/corporate/:id/generate-token', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        const token = Math.floor(1000 + Math.random() * 9000).toString();
        entry.customerToken = token;
        entry.customerTokenVerified = false;
        await entry.save();
        res.json({ success: true, token, mobile: entry.mobileNumber, customerName: entry.customerName });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Verify token (agent enters what customer told)
app.post('/api/corporate/:id/verify-token', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        const { token } = req.body;
        if (entry.customerToken && entry.customerToken === String(token).trim()) {
            entry.customerTokenVerified = true;
            entry.customerTokenVerifiedAt = new Date();
            await entry.save();
            res.json({ success: true, verified: true });
        } else {
            res.json({ success: true, verified: false, error: 'Invalid token' });
        }
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete (admin only)
app.delete('/api/corporate/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await CorporateEntry.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Corporate PDF (Service Report + Invoice combined - single page)
app.get('/corporate/:id/pdf', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        if (!entry) return res.status(404).send('Not found');
        
        const docType = req.query.type || 'invoice'; // invoice or diagnostic
        
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        res.setHeader('Content-disposition', `attachment; filename=${docType === 'diagnostic' ? 'Diagnostic' : 'Invoice'}_${entry.entryNumber}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        
        if (docType === 'diagnostic') {
            generateCorporateDiagnosticPDF(doc, entry);
        } else {
            generateCorporateInvoicePDF(doc, entry);
        }
        
        doc.end();
    } catch (err) { console.error(err); res.status(500).send('PDF generation failed'); }
});

// Generate Corporate Invoice PDF
function generateCorporateInvoicePDF(doc, entry) {
    drawPdfHeader(doc, 'TAX INVOICE', entry.entryNumber);
    
    let y = 155;
    
    // Client + Invoice info (2 cards)
    doc.roundedRect(40, y, 250, 110, 8).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text('BILL TO', 52, y + 12, { lineBreak: false });
    doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text(entry.companyName || entry.customerName, 52, y + 28, { width: 226, lineBreak: false });
    doc.fillColor('#475569').fontSize(9).font('Helvetica');
    if (entry.companyName) doc.text('Contact: ' + entry.customerName, 52, y + 48, { width: 226, lineBreak: false });
    doc.text('Mobile: ' + entry.mobileNumber, 52, y + 62, { width: 226, lineBreak: false });
    if (entry.gstNumber) doc.text('GST: ' + entry.gstNumber, 52, y + 76, { width: 226, lineBreak: false });
    doc.text(entry.location || '', 52, y + 90, { width: 226, lineBreak: false, height: 14 });
    
    doc.roundedRect(305, y, 250, 110, 8).fillAndStroke('#eff6ff', '#bfdbfe');
    doc.fillColor('#1e40af').fontSize(8).font('Helvetica-Bold').text('INVOICE DETAILS', 317, y + 12, { lineBreak: false });
    doc.fillColor('#475569').fontSize(9).font('Helvetica');
    doc.text('Date: ', 317, y + 30, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(new Date(entry.visitDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), { lineBreak: false });
    doc.fillColor('#475569').font('Helvetica').text('Engineer: ', 317, y + 46, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(entry.agentName.toUpperCase(), { lineBreak: false });
    doc.fillColor('#475569').font('Helvetica').text('Service Type: ', 317, y + 62, { continued: true, lineBreak: false }).fillColor('#0f172a').font('Helvetica-Bold').text(entry.serviceType, { lineBreak: false });
    doc.fillColor('#475569').font('Helvetica').text('Total PCs: ', 317, y + 78, { continued: true, lineBreak: false }).fillColor('#16a34a').font('Helvetica-Bold').text(String(entry.pcs.length), { lineBreak: false });
    doc.fillColor('#475569').font('Helvetica').text('Status: ', 317, y + 94, { continued: true, lineBreak: false }).fillColor(entry.paymentStatus === 'Paid' ? '#15803d' : entry.paymentStatus === 'Partial' ? '#b45309' : '#b91c1c').font('Helvetica-Bold').text(entry.paymentStatus.toUpperCase(), { lineBreak: false });
    
    y += 130;
    
    // Items table
    doc.rect(40, y, 515, 24).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    doc.text('#', 50, y + 8, { width: 25, lineBreak: false });
    doc.text('PC ID / Description', 78, y + 8, { width: 210, lineBreak: false });
    doc.text('Model / SN', 290, y + 8, { width: 130, lineBreak: false });
    doc.text('Service', 422, y + 8, { width: 60, lineBreak: false });
    doc.text('Amount', 482, y + 8, { width: 65, align: 'right', lineBreak: false });
    y += 24;
    
    let serial = 1;
    entry.pcs.forEach((pc, idx) => {
        const rowH = 28;
        if (idx % 2 === 0) doc.rect(40, y, 515, rowH).fill('#f8fafc');
        
        doc.fillColor('#475569').fontSize(9).font('Helvetica').text(String(serial++), 50, y + 9, { width: 25, lineBreak: false });
        doc.fillColor('#0f172a').font('Helvetica-Bold').text(pc.pcSrNo || `PC-${idx+1}`, 78, y + 5, { width: 210, lineBreak: false });
        doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(pc.pcType + (pc.user ? ' · ' + pc.user : ''), 78, y + 17, { width: 210, lineBreak: false });
        doc.fillColor('#475569').fontSize(9).font('Helvetica').text(pc.pcModel || '-', 290, y + 5, { width: 130, lineBreak: false });
        doc.fillColor('#64748b').fontSize(8).text(pc.serialNumber ? 'SN: ' + pc.serialNumber : '', 290, y + 17, { width: 130, lineBreak: false });
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(entry.serviceType, 422, y + 9, { width: 60, lineBreak: false });
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text('Rs.' + (pc.serviceRate || 0), 482, y + 9, { width: 65, align: 'right', lineBreak: false });
        
        y += rowH;
    });
    
    y += 10;
    
    // Totals box
    const totalsX = 320, totalsW = 235;
    doc.roundedRect(totalsX, y, totalsW, 130, 8).fillAndStroke('#f8fafc', '#e2e8f0');
    
    let ty = y + 12;
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Subtotal:', totalsX + 14, ty, { lineBreak: false });
    doc.fillColor('#0f172a').font('Helvetica-Bold').text('Rs. ' + entry.subtotal.toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
    ty += 18;
    
    if (entry.discount > 0) {
        doc.fillColor('#64748b').font('Helvetica').text('Discount' + (entry.discountReason ? ' (' + entry.discountReason + ')' : '') + ':', totalsX + 14, ty, { width: totalsW - 100, lineBreak: false });
        doc.fillColor('#dc2626').font('Helvetica-Bold').text('- Rs. ' + entry.discount.toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
        ty += 18;
    }
    
    doc.fillColor('#64748b').font('Helvetica').text(`GST (${entry.gstPercent}%):`, totalsX + 14, ty, { lineBreak: false });
    doc.fillColor('#0f172a').font('Helvetica-Bold').text('Rs. ' + Math.round(entry.gstAmount).toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
    ty += 18;
    
    doc.moveTo(totalsX + 14, ty).lineTo(totalsX + totalsW - 14, ty).strokeColor('#cbd5e1').stroke();
    ty += 6;
    
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('GRAND TOTAL:', totalsX + 14, ty, { lineBreak: false });
    doc.fillColor('#1e40af').fontSize(13).font('Helvetica-Bold').text('Rs. ' + Math.round(entry.grandTotal).toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
    ty += 22;
    
    doc.fillColor('#15803d').fontSize(9).font('Helvetica').text('Paid:', totalsX + 14, ty, { lineBreak: false });
    doc.fillColor('#15803d').font('Helvetica-Bold').text('Rs. ' + entry.amountReceived.toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
    ty += 16;
    
    if (entry.amountDue > 0) {
        doc.fillColor('#dc2626').fontSize(10).font('Helvetica-Bold').text('DUE:', totalsX + 14, ty, { lineBreak: false });
        doc.fillColor('#dc2626').font('Helvetica-Bold').text('Rs. ' + Math.round(entry.amountDue).toLocaleString('en-IN'), totalsX + 14, ty, { width: totalsW - 28, align: 'right', lineBreak: false });
    }
    
    // Engineer signature box
    doc.roundedRect(40, y, 270, 130, 8).fillAndStroke('#fffbeb', '#fcd34d');
    doc.fillColor('#92400e').fontSize(8).font('Helvetica-Bold').text('ENGINEER SIGNATURE', 52, y + 12, { lineBreak: false });
    doc.fillColor('#451a03').fontSize(18).font('Helvetica-Bold').text(entry.agentName.toUpperCase(), 52, y + 28, { width: 246, lineBreak: false });
    doc.fillColor('#92400e').fontSize(8).font('Helvetica').text('Authorized Signatory', 52, y + 54, { lineBreak: false });
    
    if (entry.gpsLatitude) {
        doc.fillColor('#92400e').fontSize(7).font('Helvetica').text(`GPS Verified · ${entry.gpsLatitude.toFixed(4)}, ${entry.gpsLongitude.toFixed(4)}`, 52, y + 74, { lineBreak: false });
    }
    if (entry.customerTokenVerified) {
        doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold').text('✓ Customer Token Verified', 52, y + 88, { lineBreak: false });
    }
    if (entry.paymentMode) {
        doc.fillColor('#451a03').fontSize(8).font('Helvetica').text('Payment Mode: ' + entry.paymentMode, 52, y + 104, { lineBreak: false });
    }
    
    drawPdfFooter(doc);
}

// Generate Corporate Diagnostic Report PDF (multi-page allowed for big offices)
function generateCorporateDiagnosticPDF(doc, entry) {
    drawPdfHeader(doc, 'DIAGNOSTIC REPORT', entry.entryNumber);
    
    let y = 155;
    
    // Client info
    doc.roundedRect(40, y, 515, 70, 8).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(entry.companyName || entry.customerName, 52, y + 10, { lineBreak: false });
    doc.fillColor('#475569').fontSize(10).font('Helvetica');
    doc.text('Contact: ' + entry.customerName + ' · ' + entry.mobileNumber, 52, y + 30, { lineBreak: false });
    doc.text('Address: ' + (entry.location || '-'), 52, y + 44, { width: 491, lineBreak: false, height: 14 });
    
    doc.fillColor('#475569').fontSize(9).font('Helvetica').text(
        'Visit Date: ' + new Date(entry.visitDate).toLocaleDateString('en-IN') + ' · Engineer: ' + entry.agentName.toUpperCase() + ' · Total PCs: ' + entry.pcs.length,
        52, y + 58, { lineBreak: false }
    );
    
    y += 80;
    
    // Per-PC mini cards (4 columns)
    const colW = 250, rowH = 220;
    
    entry.pcs.forEach((pc, idx) => {
        const col = idx % 2;
        const xPos = 40 + col * (colW + 15);
        
        if (idx > 0 && col === 0) {
            y += rowH + 10;
        }
        
        if (y + rowH > doc.page.height - 150) {
            doc.addPage();
            drawPdfHeader(doc, 'DIAGNOSTIC REPORT', entry.entryNumber + ' (cont.)');
            y = 155;
        }
        
        const sc = pc.overallStatus === 'Good' ? '#15803d' : pc.overallStatus === 'Needs Attention' ? '#b45309' : '#b91c1c';
        const scBg = pc.overallStatus === 'Good' ? '#dcfce7' : pc.overallStatus === 'Needs Attention' ? '#fef3c7' : '#fee2e2';
        
        doc.roundedRect(xPos, y, colW, rowH, 8).fillAndStroke('#ffffff', '#e2e8f0');
        doc.rect(xPos, y, colW, 30).fill('#0f172a');
        
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(pc.pcSrNo || `PC-${idx+1}`, xPos + 10, y + 9, { width: 100, lineBreak: false });
        doc.fillColor(scBg).rect(xPos + colW - 90, y + 6, 80, 18).fill();
        doc.fillColor(sc).fontSize(8).font('Helvetica-Bold').text(pc.overallStatus.toUpperCase(), xPos + colW - 90, y + 11, { width: 80, align: 'center', lineBreak: false });
        
        let py = y + 38;
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(pc.pcType + ' · ' + (pc.pcModel || 'N/A'), xPos + 10, py, { width: colW - 20, lineBreak: false });
        py += 14;
        if (pc.serialNumber) {
            doc.fillColor('#64748b').fontSize(8).font('Helvetica').text('SN: ' + pc.serialNumber, xPos + 10, py, { width: colW - 20, lineBreak: false });
            py += 12;
        }
        if (pc.user) {
            doc.fillColor('#64748b').fontSize(8).font('Helvetica').text('User: ' + pc.user + (pc.department ? ' · ' + pc.department : ''), xPos + 10, py, { width: colW - 20, lineBreak: false });
            py += 12;
        }
        py += 4;
        
        // Component grid 2 col
        const checks = [
            ['Motherboard', pc.motherboard], ['CPU', pc.cpu],
            ['RAM', pc.ramStatus], ['Storage', pc.hddHealth],
            ['Fan', pc.fan], ['Temp', pc.temperature],
            ['Monitor', pc.monitor], ['Battery', pc.battery]
        ];
        checks.forEach((c, i) => {
            const cx = xPos + 10 + (i % 2) * ((colW - 20) / 2);
            const cy = py + Math.floor(i / 2) * 12;
            const good = c[1] === 'Good' || c[1] === 'Normal' || c[1] === 'N/A';
            doc.fillColor('#64748b').fontSize(7).font('Helvetica').text(c[0] + ':', cx, cy, { lineBreak: false });
            doc.fillColor(good ? '#15803d' : '#b91c1c').fontSize(7).font('Helvetica-Bold').text(c[1] || '-', cx + 50, cy, { lineBreak: false });
        });
        py += 12 * 4 + 6;
        
        if (pc.remarks) {
            doc.fillColor('#475569').fontSize(7).font('Helvetica-Oblique').text('Remarks: ' + pc.remarks, xPos + 10, py, { width: colW - 20, height: 24, lineBreak: true });
        }
    });
    
    drawPdfFooter(doc);
}

// ======================== BOOKING SYSTEM ========================

app.get('/bookings', requireAuth, async (req, res) => {
    const allBookings = await Booking.find().sort({ scheduledDate: 1 }).limit(200).lean();
    
    // Filter for agent
    let bookings = allBookings;
    if (req.session.user.role === 'agent') {
        bookings = allBookings.filter(b => b.assignedAgent === req.session.user.username);
    }
    
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    
    const todayBookings = bookings.filter(b => {
        const d = new Date(b.scheduledDate); d.setHours(0,0,0,0);
        return d.getTime() === today.getTime() && b.status !== 'Completed' && b.status !== 'Cancelled';
    });
    const upcoming = bookings.filter(b => {
        const d = new Date(b.scheduledDate); d.setHours(0,0,0,0);
        return d.getTime() > today.getTime() && b.status !== 'Completed' && b.status !== 'Cancelled';
    });
    const completed = bookings.filter(b => b.status === 'Completed').slice(-15);
    const allOther = bookings.filter(b => b.status !== 'Completed').slice(0, 50);
    
    const stats = {
        total: bookings.length,
        today: todayBookings.length,
        upcoming: upcoming.length,
        completed: bookings.filter(b => b.status === 'Completed').length
    };
    
    res.render('bookings', { 
        user: req.session.user, 
        todayBookings, upcoming, completed, allOther, stats 
    });
});

app.post('/api/bookings', requireAuth, async (req, res) => {
    try {
        const count = await Booking.countDocuments();
        const data = req.body;
        data.bookingNumber = `SEA-BK-${String(count + 1).padStart(4, '0')}`;
        data.bookedBy = req.session.user.username;
        const booking = new Booking(data);
        await booking.save();
        res.json({ success: true, booking });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/bookings/:id', requireAuth, async (req, res) => {
    try {
        const booking = await Booking.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, booking });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/bookings/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Booking.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======================== EXTEND SINGLE ENTRY APIs (GPS, Token, Due) ========================

// Capture GPS for single entry
app.post('/api/entries/:id/gps', requireAuth, async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        const { latitude, longitude, accuracy, address } = req.body;
        entry.gpsLatitude = latitude;
        entry.gpsLongitude = longitude;
        entry.gpsAccuracy = accuracy;
        entry.gpsAddress = address || '';
        entry.gpsCapturedAt = new Date();
        await entry.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Generate token for entry
app.post('/api/entries/:id/generate-token', requireAuth, async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        const token = Math.floor(1000 + Math.random() * 9000).toString();
        entry.customerToken = token;
        entry.customerTokenVerified = false;
        await entry.save();
        res.json({ success: true, token, mobile: entry.mobileNumber, customerName: entry.customerName });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Verify token for entry
app.post('/api/entries/:id/verify-token', requireAuth, async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        const { token } = req.body;
        if (entry.customerToken && entry.customerToken === String(token).trim()) {
            entry.customerTokenVerified = true;
            entry.customerTokenVerifiedAt = new Date();
            await entry.save();
            res.json({ success: true, verified: true });
        } else {
            res.json({ success: true, verified: false });
        }
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Edit existing entry (with audit log)
app.put('/api/entries/:id', requireAuth, async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        
        const editor = req.session.user.username;
        const updates = req.body;
        
        const trackedFields = ['customerName', 'mobileNumber', 'location', 'remarks', 'serviceTaken', 'revenue', 'amountReceived', 'discount', 'discountReason', 'paymentMode', 'pcModel', 'serialNumber', 'pcType', 'followUpDate', 'callStatus', 'conversionStatus', 'isCompleted'];
        const componentFields = ['cpu', 'motherboard', 'ramStatus', 'ramSlot', 'hddHealth', 'drive', 'fan', 'temperature', 'connectors', 'battery', 'charger', 'powerCable', 'monitor', 'webcam'];
        
        [...trackedFields, ...componentFields].forEach(f => {
            if (updates[f] !== undefined && String(entry[f] || '') !== String(updates[f] || '')) {
                entry.editLogs.push({
                    editedBy: editor, field: f,
                    oldValue: entry[f], newValue: updates[f]
                });
                entry[f] = updates[f];
            }
        });
        
        if (updates.beforePhoto !== undefined) entry.beforePhoto = updates.beforePhoto;
        if (updates.afterPhoto !== undefined) entry.afterPhoto = updates.afterPhoto;
        if (updates.proofPhoto !== undefined) entry.proofPhoto = updates.proofPhoto;
        if (updates.futureRequirements !== undefined) entry.futureRequirements = updates.futureRequirements;
        
        // Compute due if revenue/amountReceived/discount changed
        const finalAmount = (entry.revenue || 0) - (entry.discount || 0);
        entry.amountDue = Math.max(0, finalAmount - (entry.amountReceived || 0));
        entry.paymentStatus = entry.amountDue <= 0 ? 'Paid' : entry.amountReceived > 0 ? 'Partial' : 'Pending';
        
        entry.lastModifiedBy = editor;
        await entry.save();
        res.json({ success: true, entry });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// ======================== REPORTS MODULE (Day/Week/Month/Sales/Follow-up) ========================

app.get('/reports', requireAuth, requireAdmin, async (req, res) => {
    const period = req.query.period || 'today';
    const now = new Date();
    let fromDate, toDate = new Date(now);
    
    if (period === 'today') {
        fromDate = new Date(now); fromDate.setHours(0, 0, 0, 0);
    } else if (period === 'yesterday') {
        fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 1); fromDate.setHours(0, 0, 0, 0);
        toDate = new Date(fromDate); toDate.setHours(23, 59, 59, 999);
    } else if (period === 'week') {
        fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 7);
    } else if (period === 'month') {
        fromDate = new Date(now); fromDate.setMonth(fromDate.getMonth() - 1);
    } else if (period === 'thismonth') {
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
        fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 7);
    }
    
    // Data from different sources
    const [entries, corpEntries, orders, leads] = await Promise.all([
        Entry.find({ createdAt: { $gte: fromDate, $lte: toDate } }),
        CorporateEntry.find({ createdAt: { $gte: fromDate, $lte: toDate } }),
        Order.find({ createdAt: { $gte: fromDate, $lte: toDate } }),
        Lead.find({ createdAt: { $gte: fromDate, $lte: toDate } })
    ]);
    
    // Aggregations
    const entryRev = entries.reduce((s, e) => s + (e.amountReceived || e.revenue || 0), 0);
    const corpRev = corpEntries.reduce((s, e) => s + (e.amountReceived || 0), 0);
    const entryDue = entries.reduce((s, e) => s + (e.amountDue || 0), 0);
    const corpDue = corpEntries.reduce((s, e) => s + (e.amountDue || 0), 0);
    const entryExp = entries.reduce((s, e) => s + (e.travelExpense || 0), 0);
    
    // Service breakdown
    const serviceBreakdown = {};
    entries.forEach(e => {
        serviceBreakdown[e.serviceTaken] = (serviceBreakdown[e.serviceTaken] || 0) + 1;
    });
    
    // Agent breakdown
    const agentBreakdown = {};
    [...entries, ...corpEntries].forEach(e => {
        const a = e.agentName;
        if (!agentBreakdown[a]) agentBreakdown[a] = { count: 0, revenue: 0, due: 0 };
        agentBreakdown[a].count++;
        agentBreakdown[a].revenue += (e.amountReceived || e.revenue || 0);
        agentBreakdown[a].due += (e.amountDue || 0);
    });
    
    // Follow-ups pending
    const pendingFollowUps = await Entry.find({ 
        followUpDate: { $exists: true, $ne: null }, 
        conversionStatus: 'Pending' 
    }).sort({ followUpDate: 1 }).limit(20);
    
    // Pending due entries (all-time)
    const allDueEntries = await Entry.find({ amountDue: { $gt: 0 } }).sort({ createdAt: -1 }).limit(50);
    const allDueCorp = await CorporateEntry.find({ amountDue: { $gt: 0 } }).sort({ createdAt: -1 }).limit(50);
    
    res.render('reports', {
        user: req.session.user,
        period, fromDate, toDate,
        stats: {
            totalEntries: entries.length,
            totalCorpEntries: corpEntries.length,
            totalLeads: leads.length,
            totalOrders: orders.length,
            entryRev, corpRev,
            totalRevenue: entryRev + corpRev,
            entryDue, corpDue,
            totalDue: entryDue + corpDue,
            entryExp,
            netProfit: (entryRev + corpRev) - entryExp
        },
        serviceBreakdown, agentBreakdown,
        pendingFollowUps,
        allDueEntries, allDueCorp,
        entries, corpEntries
    });
});

// ============================================================
//   PHASE 4 - SMART FEATURES
// ============================================================

// =========== HELPER: Auto-sync customer master ===========
async function syncCustomer(data, source) {
    try {
        if (!data.mobile && !data.mobileNumber) return null;
        const mobile = String(data.mobile || data.mobileNumber).replace(/\D/g, '').slice(-10);
        if (mobile.length !== 10) return null;
        
        let customer = await Customer.findOne({ mobile });
        if (!customer) {
            customer = new Customer({
                name: data.name || data.customerName || data.leadName || 'Unknown',
                mobile,
                companyName: data.companyName || '',
                email: data.email || '',
                primaryAddress: data.address || data.location || '',
                location: data.location || '',
                gstNumber: data.gstNumber || '',
                type: data.companyName ? 'Corporate' : 'Individual',
                sourceModule: source
            });
        } else {
            // Update if better data
            if (!customer.companyName && data.companyName) customer.companyName = data.companyName;
            if (!customer.email && data.email) customer.email = data.email;
            if (!customer.primaryAddress && (data.address || data.location)) {
                customer.primaryAddress = data.address || data.location;
            }
            if (!customer.gstNumber && data.gstNumber) customer.gstNumber = data.gstNumber;
        }
        await customer.save();
        return customer;
    } catch (e) {
        console.warn('Customer sync failed:', e.message);
        return null;
    }
}

// ============================================================
//   CUSTOMER AUTO-FILL API (Smart fill by mobile)
// ============================================================

// Lookup customer by mobile (returns suggestion list)
app.get('/api/customers/lookup', requireAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 3) return res.json({ suggestions: [] });
        
        const digits = q.replace(/\D/g, '');
        const filter = digits.length >= 3
            ? { mobile: { $regex: digits, $options: 'i' } }
            : { $or: [
                { name: { $regex: q, $options: 'i' } },
                { companyName: { $regex: q, $options: 'i' } }
            ] };
        
        const suggestions = await Customer.find(filter).limit(8).sort({ totalRevenue: -1, updatedAt: -1 });
        res.json({ suggestions });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get customer by exact mobile
app.get('/api/customers/by-mobile/:mobile', requireAuth, async (req, res) => {
    try {
        const mobile = req.params.mobile.replace(/\D/g, '').slice(-10);
        const customer = await Customer.findOne({ mobile });
        
        if (!customer) return res.json({ found: false });
        
        // Get related history
        const [entries, corpEntries, leads, bookings] = await Promise.all([
            Entry.find({ mobileNumber: { $regex: mobile + '$' } }).limit(5).sort({ createdAt: -1 }),
            CorporateEntry.find({ mobileNumber: { $regex: mobile + '$' } }).limit(5).sort({ createdAt: -1 }),
            Lead.find({ mobile: { $regex: mobile + '$' } }).limit(3).sort({ createdAt: -1 }),
            Booking.find({ mobileNumber: { $regex: mobile + '$' } }).limit(3).sort({ createdAt: -1 })
        ]);
        
        res.json({
            found: true,
            customer,
            history: {
                entries: entries.length,
                corporate: corpEntries.length,
                leads: leads.length,
                bookings: bookings.length
            }
        });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk sync existing data into customer master
app.post('/api/customers/sync-all', requireAuth, requireAdmin, async (req, res) => {
    try {
        let synced = 0;
        
        const allEntries = await Entry.find();
        for (const e of allEntries) {
            const c = await syncCustomer({
                customerName: e.customerName, mobile: e.mobileNumber, location: e.location
            }, 'Hardware');
            if (c) synced++;
        }
        
        const corpEntries = await CorporateEntry.find();
        for (const e of corpEntries) {
            const c = await syncCustomer({
                customerName: e.customerName, mobile: e.mobileNumber, location: e.location,
                companyName: e.companyName, email: e.email, gstNumber: e.gstNumber
            }, 'Corporate');
            if (c) synced++;
        }
        
        const leads = await Lead.find();
        for (const l of leads) {
            const c = await syncCustomer({
                customerName: l.leadName, mobile: l.mobile, location: l.address,
                companyName: l.companyName, email: l.email
            }, 'Lead');
            if (c) synced++;
        }
        
        const offices = await AMCOffice.find();
        for (const o of offices) {
            const c = await syncCustomer({
                customerName: o.contactPerson, mobile: o.contactMobile, location: o.address,
                companyName: o.companyName || o.officeName, email: o.contactEmail
            }, 'AMC');
            if (c) synced++;
        }
        
        res.json({ success: true, synced });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================================================
//   MASTER SMART SEARCH
// ============================================================

app.get('/api/search', requireAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ results: [], shortcuts: [] });
        
        const ql = q.toLowerCase();
        const results = [];
        const shortcuts = [];
        
        // Keyword shortcuts
        const keywords = {
            'salary': { url: '/hr', label: 'HR & Salary', icon: '💰' },
            'attendance': { url: '/hr', label: 'HR / Attendance', icon: '📅' },
            'employee': { url: '/hr', label: 'Employees', icon: '👤' },
            'hr': { url: '/hr', label: 'HR Management', icon: '👥' },
            'leave': { url: '/hr', label: 'Leaves', icon: '🏖️' },
            'advance': { url: '/hr', label: 'Advance Payments', icon: '💸' },
            'bank': { url: '/bank', label: 'Bank Reconciliation', icon: '🏦' },
            'statement': { url: '/bank', label: 'Bank Statement', icon: '🏦' },
            'reconcile': { url: '/bank', label: 'Bank Match', icon: '🏦' },
            'vendor': { url: '/vendors', label: 'Vendors', icon: '🏭' },
            'stock': { url: '/stock', label: 'Stock', icon: '📦' },
            'inventory': { url: '/stock', label: 'Stock', icon: '📦' },
            'tool': { url: '/tools', label: 'Tools', icon: '🔧' },
            'lead': { url: '/leads', label: 'Leads', icon: '🎯' },
            'enquiry': { url: '/leads', label: 'Enquiries', icon: '🎯' },
            'booking': { url: '/bookings', label: 'Bookings', icon: '📅' },
            'amc': { url: '/amc', label: 'AMC Management', icon: '🏢' },
            'office': { url: '/corporate', label: 'Corporate Office', icon: '🏢' },
            'corporate': { url: '/corporate', label: 'Office Corporate', icon: '🏢' },
            'cctv': { url: '/cctv', label: 'CCTV Module', icon: '📹' },
            'quote': { url: '/cctv', label: 'Quotations', icon: '📋' },
            'quotation': { url: '/cctv', label: 'Quotations', icon: '📋' },
            'ai': { url: '/ai-projects', label: 'AI Projects', icon: '🤖' },
            'project': { url: '/ai-projects', label: 'AI Projects', icon: '🤖' },
            'report': { url: '/reports', label: 'Reports', icon: '📊' },
            'due': { url: '/reports', label: 'Pending Dues', icon: '💰' },
            'pending': { url: '/reports', label: 'Pending', icon: '⏳' },
            'expense': { url: '/reports', label: 'Expenses', icon: '💸' },
            'customer': { url: '/customers', label: 'Customers', icon: '👥' },
            'profit': { url: '/reports', label: 'P&L Reports', icon: '📈' }
        };
        
        Object.entries(keywords).forEach(([key, val]) => {
            if (key.includes(ql) || ql.includes(key)) {
                if (!shortcuts.find(s => s.url === val.url)) shortcuts.push(val);
            }
        });
        
        // Search across data
        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const limit = 5;
        
        // Customers
        const customers = await Customer.find({
            $or: [{ name: regex }, { mobile: regex }, { companyName: regex }]
        }).limit(limit);
        customers.forEach(c => results.push({
            type: 'Customer', title: c.name + (c.companyName ? ' · ' + c.companyName : ''),
            subtitle: c.mobile + ' · ' + (c.totalServices || 0) + ' services',
            url: `/customers#${c._id}`, icon: '👤'
        }));
        
        // Entries
        const entries = await Entry.find({
            $or: [{ customerName: regex }, { mobileNumber: regex }, { serviceTaken: regex }]
        }).limit(limit);
        entries.forEach(e => results.push({
            type: 'Service', title: e.customerName, subtitle: e.mobileNumber + ' · ' + (e.serviceTaken || ''),
            url: '/admin', icon: '🔧'
        }));
        
        // Corporate
        const corps = await CorporateEntry.find({
            $or: [{ customerName: regex }, { companyName: regex }, { mobileNumber: regex }, { entryNumber: regex }]
        }).limit(limit);
        corps.forEach(c => results.push({
            type: 'Corporate', title: c.companyName || c.customerName,
            subtitle: c.entryNumber + ' · ' + c.mobileNumber,
            url: '/corporate/' + c._id, icon: '🏢'
        }));
        
        // Vendors
        const vendors = await Vendor.find({
            $or: [{ vendorName: regex }, { mobile: regex }, { contactPerson: regex }]
        }).limit(limit);
        vendors.forEach(v => results.push({
            type: 'Vendor', title: v.vendorName, subtitle: v.contactPerson + ' · ' + v.mobile,
            url: '/vendors/' + v._id, icon: '🏭'
        }));
        
        // Stock
        const stocks = await StockItem.find({
            $or: [{ productName: regex }, { category: regex }, { brand: regex }, { model: regex }]
        }).limit(limit);
        stocks.forEach(s => results.push({
            type: 'Stock', title: s.productName,
            subtitle: s.category + ' · ' + s.currentStock + ' in stock',
            url: '/stock/' + s._id, icon: '📦'
        }));
        
        // Leads
        const leads = await Lead.find({
            $or: [{ leadName: regex }, { mobile: regex }, { leadNumber: regex }, { companyName: regex }]
        }).limit(limit);
        leads.forEach(l => results.push({
            type: 'Lead', title: l.leadName + (l.companyName ? ' · ' + l.companyName : ''),
            subtitle: l.leadNumber + ' · ' + l.status,
            url: '/leads/' + l._id, icon: '🎯'
        }));
        
        // AMC Offices
        const offices = await AMCOffice.find({
            $or: [{ officeName: regex }, { companyName: regex }, { contactMobile: regex }, { contactPerson: regex }]
        }).limit(limit);
        offices.forEach(o => results.push({
            type: 'AMC', title: o.officeName, subtitle: o.contactPerson + ' · ' + o.contactMobile,
            url: '/amc/' + o._id, icon: '🏢'
        }));
        
        // Employees
        const emps = await Employee.find({
            $or: [{ name: regex }, { mobile: regex }, { employeeCode: regex }, { username: regex }]
        }).limit(limit);
        emps.forEach(e => results.push({
            type: 'Employee', title: e.name + ' (' + e.role + ')',
            subtitle: e.employeeCode + ' · ' + e.mobile,
            url: '/hr/employee/' + e._id, icon: '👤'
        }));
        
        res.json({ results: results.slice(0, 30), shortcuts: shortcuts.slice(0, 6) });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// ============================================================
//   SMART VENDOR SUGGESTION (cheapest, best vendor for product)
// ============================================================

app.get('/api/vendors/suggest', requireAuth, async (req, res) => {
    try {
        const q = (req.query.product || '').trim();
        if (!q) return res.json({ suggestions: [] });
        
        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const suggestions = [];
        
        // Search all vendor bills for matching products
        const vendors = await Vendor.find({ 'bills.items.productName': regex });
        
        for (const vendor of vendors) {
            const matchingItems = [];
            for (const bill of (vendor.bills || [])) {
                for (const item of (bill.items || [])) {
                    if (regex.test(item.productName)) {
                        matchingItems.push({
                            productName: item.productName,
                            unitCost: item.unitCost,
                            sellingPrice: item.sellingPrice,
                            gstPercent: item.gstPercent,
                            warranty: item.warranty,
                            billDate: bill.billDate,
                            billNumber: bill.billNumber
                        });
                    }
                }
            }
            
            if (matchingItems.length === 0) continue;
            
            // Take most recent price
            matchingItems.sort((a, b) => new Date(b.billDate) - new Date(a.billDate));
            const latest = matchingItems[0];
            
            // Calculate vendor metrics
            const totalBills = (vendor.bills || []).reduce((s, b) => s + b.grandTotal, 0);
            const totalPaid = (vendor.payments || []).reduce((s, p) => s + p.amount, 0);
            const pending = Math.max(0, totalBills - totalPaid);
            const creditUsed = pending; // pending = credit being used
            
            // Score: lower cost = better, paid up = better, more orders = better
            const cheapnessScore = latest.unitCost > 0 ? (1000 / latest.unitCost) * 10 : 0;
            const reliabilityScore = totalBills > 0 ? (totalPaid / totalBills) * 50 : 50;
            const experienceScore = Math.min(matchingItems.length * 5, 30);
            const totalScore = cheapnessScore + reliabilityScore + experienceScore;
            
            suggestions.push({
                vendorId: vendor._id,
                vendorName: vendor.vendorName,
                contact: vendor.contactPerson,
                mobile: vendor.mobile,
                category: vendor.category,
                
                latestPrice: latest.unitCost,
                sellingPrice: latest.sellingPrice,
                gstPercent: latest.gstPercent,
                warranty: latest.warranty,
                lastPurchaseDate: latest.billDate,
                lastBillNumber: latest.billNumber,
                
                totalPurchases: matchingItems.length,
                totalBilled: Math.round(totalBills),
                totalPaid: Math.round(totalPaid),
                pendingPayment: Math.round(pending),
                creditUsed: Math.round(creditUsed),
                
                score: Math.round(totalScore),
                rating: vendor.status === 'Active' ? 'Active' : vendor.status
            });
        }
        
        // Sort by score (best first)
        suggestions.sort((a, b) => b.score - a.score);
        
        // Add tags
        if (suggestions.length > 0) {
            const cheapest = suggestions.reduce((min, v) => v.latestPrice < min.latestPrice ? v : min, suggestions[0]);
            cheapest._cheapest = true;
            
            const mostBought = suggestions.reduce((max, v) => v.totalPurchases > max.totalPurchases ? v : max, suggestions[0]);
            mostBought._mostBought = true;
            
            suggestions[0]._best = true; // highest score
        }
        
        res.json({ suggestions });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// ============================================================
//   HR / EMPLOYEE MANAGEMENT
// ============================================================

app.get('/hr', requireAuth, requireAdmin, async (req, res) => {
    const employees = await Employee.find().select('-photo -attendance -salaryPayments -advances -leaves').sort({ status: 1, name: 1 }).limit(50).lean();
    
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    
    let totalSalaryThisMonth = 0, totalAdvancesPending = 0, todayPresent = 0;
    employees.forEach(emp => {
        // This month salary
        const thisMonth = (emp.salaryPayments || []).find(s => s.month === today.toISOString().slice(0, 7));
        if (thisMonth) totalSalaryThisMonth += thisMonth.netPay || 0;
        else totalSalaryThisMonth += emp.baseSalary || 0;
        
        // Advances pending
        (emp.advances || []).forEach(a => {
            if (a.status === 'Paid') totalAdvancesPending += (a.pendingAmount || (a.amount - (a.adjustedAmount || 0)));
        });
        
        // Today attendance
        const todayAtt = (emp.attendance || []).find(a => {
            const ad = new Date(a.date); ad.setHours(0,0,0,0);
            return ad.getTime() === today.getTime();
        });
        if (todayAtt && todayAtt.status === 'Present') todayPresent++;
    });
    
    res.render('hr', {
        user: req.session.user,
        employees,
        stats: {
            totalEmployees: employees.length,
            activeEmployees: employees.filter(e => e.status === 'Active').length,
            todayPresent,
            totalSalaryThisMonth,
            totalAdvancesPending
        }
    });
});

app.get('/hr/employee/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).send('Not found');
        
        // Calculate revenue this month from entries
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
        
        const [entries, corpEntries] = await Promise.all([
            Entry.find({ agentName: emp.username, createdAt: { $gte: monthStart } }),
            CorporateEntry.find({ agentName: emp.username, createdAt: { $gte: monthStart } })
        ]);
        
        const monthRevenue = 
            entries.reduce((s, e) => s + (e.amountReceived || e.revenue || 0), 0) +
            corpEntries.reduce((s, e) => s + (e.amountReceived || 0), 0);
        
        const monthVisits = entries.length + corpEntries.length;
        const monthExpense = entries.reduce((s, e) => s + (e.travelExpense || 0), 0);
        
        res.render('hr-employee', { 
            user: req.session.user, 
            emp, 
            performance: { monthRevenue, monthVisits, monthExpense }
        });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/hr/employees', requireAuth, requireAdmin, async (req, res) => {
    try {
        const count = await Employee.countDocuments();
        const data = req.body;
        data.employeeCode = data.employeeCode || `SEA-E-${String(count + 1).padStart(3, '0')}`;
        const emp = new Employee(data);
        await emp.save();
        res.json({ success: true, emp });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/hr/employees/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, emp });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/hr/employees/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Employee.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mark attendance
app.post('/api/hr/employees/:id/attendance', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const { date, status, checkIn, checkOut, notes } = req.body;
        
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        
        // Check if already exists for this date
        const existing = emp.attendance.find(a => {
            const ad = new Date(a.date); ad.setHours(0,0,0,0);
            return ad.getTime() === d.getTime();
        });
        
        if (existing) {
            existing.status = status;
            existing.checkIn = checkIn || existing.checkIn;
            existing.checkOut = checkOut || existing.checkOut;
            existing.notes = notes || existing.notes;
        } else {
            emp.attendance.push({ date: d, status, checkIn: checkIn || '', checkOut: checkOut || '', notes: notes || '' });
        }
        
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Apply leave
app.post('/api/hr/employees/:id/leaves', requireAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const { fromDate, toDate, leaveType, reason } = req.body;
        const days = Math.ceil((new Date(toDate) - new Date(fromDate)) / (1000 * 60 * 60 * 24)) + 1;
        emp.leaves.push({ fromDate, toDate, days, leaveType: leaveType || 'Casual', reason: reason || '', status: 'Pending' });
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Approve/reject leave
app.put('/api/hr/employees/:id/leaves/:lId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const leave = emp.leaves.id(req.params.lId);
        Object.assign(leave, req.body);
        if (req.body.status === 'Approved') leave.approvedBy = req.session.user.username;
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add advance
app.post('/api/hr/employees/:id/advances', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const data = req.body;
        data.pendingAmount = data.amount;
        emp.advances.push(data);
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/hr/employees/:id/advances/:aId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const adv = emp.advances.id(req.params.aId);
        Object.assign(adv, req.body);
        if (adv.adjustedAmount !== undefined) {
            adv.pendingAmount = Math.max(0, adv.amount - adv.adjustedAmount);
        }
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Generate salary for a month
app.post('/api/hr/employees/:id/salary', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const { month } = req.body; // "2026-05"
        
        if (!month) return res.status(400).json({ error: 'Month required' });
        
        const [yr, mn] = month.split('-').map(Number);
        const monthStart = new Date(yr, mn - 1, 1);
        const monthEnd = new Date(yr, mn, 0, 23, 59, 59);
        const monthName = monthStart.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        const daysInMonth = monthEnd.getDate();
        
        // Calculate attendance for the month
        const monthAttendance = (emp.attendance || []).filter(a => {
            const ad = new Date(a.date);
            return ad >= monthStart && ad <= monthEnd;
        });
        
        const daysWorked = monthAttendance.filter(a => a.status === 'Present').length;
        const daysAbsent = monthAttendance.filter(a => a.status === 'Absent').length;
        const halfDays = monthAttendance.filter(a => a.status === 'Half Day').length;
        const leavesCount = monthAttendance.filter(a => a.status === 'Leave').length;
        
        // Get performance from CRM (entries + corporate)
        const [entries, corpEntries] = await Promise.all([
            Entry.find({ agentName: emp.username, createdAt: { $gte: monthStart, $lte: monthEnd } }),
            CorporateEntry.find({ agentName: emp.username, createdAt: { $gte: monthStart, $lte: monthEnd } })
        ]);
        
        const revenueGenerated = 
            entries.reduce((s, e) => s + (e.amountReceived || e.revenue || 0), 0) +
            corpEntries.reduce((s, e) => s + (e.amountReceived || 0), 0);
        const visitsCompleted = entries.length + corpEntries.length;
        const expensesIncurred = entries.reduce((s, e) => s + (e.travelExpense || 0), 0);
        
        // Salary calculation
        const dailyRate = (emp.baseSalary || 0) / daysInMonth;
        const proRataBase = Math.round(dailyRate * (daysWorked + halfDays * 0.5 + leavesCount));
        const incentive = Math.round(revenueGenerated * (emp.incentivePercent || 0) / 100);
        
        // Advance deduction (auto-deduct pending advances)
        let advanceDeducted = 0;
        const advancesToAdjust = (emp.advances || []).filter(a => a.status === 'Paid' && a.pendingAmount > 0);
        for (const adv of advancesToAdjust) {
            const toDeduct = Math.min(adv.pendingAmount, proRataBase * 0.3); // Max 30% of salary
            advanceDeducted += toDeduct;
        }
        
        const grossPay = proRataBase + incentive + Number(req.body.bonus || 0) + Number(req.body.overtimePay || 0);
        const totalDeductions = advanceDeducted + Number(req.body.otherDeductions || 0);
        const netPay = grossPay - totalDeductions;
        const profitToCompany = revenueGenerated - netPay - expensesIncurred;
        
        const salaryData = {
            month,
            monthName,
            daysWorked, daysAbsent, halfDays, leaves: leavesCount,
            baseSalary: proRataBase,
            incentive,
            bonus: Number(req.body.bonus || 0),
            overtimePay: Number(req.body.overtimePay || 0),
            advanceDeducted,
            otherDeductions: Number(req.body.otherDeductions || 0),
            deductionReason: req.body.deductionReason || '',
            grossPay,
            netPay,
            revenueGenerated,
            visitsCompleted,
            expensesIncurred,
            profitToCompany,
            status: 'Pending'
        };
        
        // Replace or push
        const existing = emp.salaryPayments.find(s => s.month === month);
        if (existing) Object.assign(existing, salaryData);
        else emp.salaryPayments.push(salaryData);
        
        await emp.save();
        res.json({ success: true, salary: salaryData });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Pay salary
app.post('/api/hr/employees/:id/pay-salary/:sId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        const sal = emp.salaryPayments.id(req.params.sId);
        sal.status = 'Paid';
        sal.paymentDate = new Date();
        sal.paymentMode = req.body.paymentMode || 'Bank Transfer';
        sal.paymentRef = req.body.paymentRef || '';
        
        // Adjust advances
        if (sal.advanceDeducted > 0) {
            let toAdjust = sal.advanceDeducted;
            for (const adv of emp.advances) {
                if (adv.status === 'Paid' && adv.pendingAmount > 0 && toAdjust > 0) {
                    const adjust = Math.min(adv.pendingAmount, toAdjust);
                    adv.adjustedAmount = (adv.adjustedAmount || 0) + adjust;
                    adv.pendingAmount -= adjust;
                    if (adv.pendingAmount <= 0) adv.status = 'Adjusted';
                    toAdjust -= adjust;
                }
            }
        }
        
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================================================
//   BANK RECONCILIATION
// ============================================================

app.get('/bank', requireAuth, requireAdmin, async (req, res) => {
    const transactions = await BankTransaction.find().sort({ transactionDate: -1 }).limit(500);
    
    const stats = {
        total: transactions.length,
        matched: transactions.filter(t => t.matchStatus === 'Matched' || t.matchStatus === 'Manual').length,
        unmatched: transactions.filter(t => t.matchStatus === 'Unmatched').length,
        totalCredit: transactions.filter(t => t.type === 'CREDIT').reduce((s, t) => s + t.amount, 0),
        totalDebit: transactions.filter(t => t.type === 'DEBIT').reduce((s, t) => s + t.amount, 0)
    };
    stats.matchPercent = stats.total > 0 ? Math.round((stats.matched / stats.total) * 100) : 0;
    
    res.render('bank', { user: req.session.user, transactions, stats });
});

// Add bank transaction(s)
app.post('/api/bank/transactions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        const transactions = Array.isArray(data) ? data : [data];
        const created = [];
        
        for (const t of transactions) {
            const trx = new BankTransaction(t);
            await trx.save();
            
            // Auto-match attempt
            await autoMatchTransaction(trx);
            created.push(trx);
        }
        
        res.json({ success: true, count: created.length, transactions: created });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Auto-match logic
async function autoMatchTransaction(trx) {
    try {
        const amt = trx.amount;
        const dateMin = new Date(trx.transactionDate);
        dateMin.setDate(dateMin.getDate() - 3);
        const dateMax = new Date(trx.transactionDate);
        dateMax.setDate(dateMax.getDate() + 3);
        
        if (trx.type === 'CREDIT') {
            // Match against payments received (entries / corporate)
            // Try Corporate first
            const corpMatch = await CorporateEntry.findOne({
                amountReceived: amt,
                paymentDate: { $gte: dateMin, $lte: dateMax }
            });
            
            if (corpMatch) {
                trx.matchStatus = 'Matched';
                trx.matchedTo = 'CorporateEntry';
                trx.matchedRefId = corpMatch._id.toString();
                trx.matchConfidence = 90;
                trx.category = 'Sales';
                await trx.save();
                return;
            }
            
            // Try regular Entry
            const entryMatch = await Entry.findOne({
                revenue: amt,
                createdAt: { $gte: dateMin, $lte: dateMax }
            });
            
            if (entryMatch) {
                trx.matchStatus = 'Matched';
                trx.matchedTo = 'Entry';
                trx.matchedRefId = entryMatch._id.toString();
                trx.matchConfidence = 80;
                trx.category = 'Sales';
                await trx.save();
                return;
            }
        } else {
            // DEBIT - match against vendor payments / salaries
            const vendor = await Vendor.findOne({
                'payments.amount': amt,
                'payments.paymentDate': { $gte: dateMin, $lte: dateMax }
            });
            
            if (vendor) {
                trx.matchStatus = 'Matched';
                trx.matchedTo = 'VendorPayment';
                trx.matchedRefId = vendor._id.toString();
                trx.matchConfidence = 85;
                trx.category = 'Vendor Payment';
                await trx.save();
                return;
            }
            
            // Salary
            const emp = await Employee.findOne({
                'salaryPayments.netPay': amt,
                'salaryPayments.paymentDate': { $gte: dateMin, $lte: dateMax }
            });
            
            if (emp) {
                trx.matchStatus = 'Matched';
                trx.matchedTo = 'Salary';
                trx.matchedRefId = emp._id.toString();
                trx.matchConfidence = 85;
                trx.category = 'Salary';
                await trx.save();
                return;
            }
        }
    } catch (e) { console.warn('Auto-match failed:', e.message); }
}

// Bulk auto-match all unmatched
app.post('/api/bank/auto-match-all', requireAuth, requireAdmin, async (req, res) => {
    try {
        const unmatched = await BankTransaction.find({ matchStatus: 'Unmatched' });
        let matched = 0;
        for (const t of unmatched) {
            await autoMatchTransaction(t);
            const refreshed = await BankTransaction.findById(t._id);
            if (refreshed.matchStatus === 'Matched') matched++;
        }
        res.json({ success: true, total: unmatched.length, matched });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Manual match
app.put('/api/bank/transactions/:id/match', requireAuth, requireAdmin, async (req, res) => {
    try {
        const trx = await BankTransaction.findById(req.params.id);
        const { matchedTo, matchedRefId, category, notes } = req.body;
        trx.matchStatus = 'Manual';
        trx.matchedTo = matchedTo;
        trx.matchedRefId = matchedRefId || '';
        trx.category = category || trx.category;
        trx.notes = notes || trx.notes;
        trx.matchConfidence = 100;
        trx.matchedAt = new Date();
        trx.matchedBy = req.session.user.username;
        await trx.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mark as ignored
app.put('/api/bank/transactions/:id/ignore', requireAuth, requireAdmin, async (req, res) => {
    try {
        const trx = await BankTransaction.findById(req.params.id);
        trx.matchStatus = 'Ignored';
        trx.notes = req.body.notes || trx.notes;
        await trx.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete transaction
app.delete('/api/bank/transactions/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await BankTransaction.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Export bank reconciliation
app.get('/api/bank/export', requireAuth, requireAdmin, async (req, res) => {
    try {
        const transactions = await BankTransaction.find().sort({ transactionDate: -1 });
        const workbook = new exceljs.Workbook();
        
        const sheet = workbook.addWorksheet('Bank Reconciliation');
        sheet.columns = [
            { header: 'Date', key: 'transactionDate', width: 14 },
            { header: 'Description', key: 'description', width: 35 },
            { header: 'Reference', key: 'referenceNumber', width: 18 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Amount', key: 'amount', width: 12 },
            { header: 'Balance', key: 'balance', width: 14 },
            { header: 'Match Status', key: 'matchStatus', width: 12 },
            { header: 'Matched To', key: 'matchedTo', width: 16 },
            { header: 'Category', key: 'category', width: 16 },
            { header: 'Confidence', key: 'matchConfidence', width: 10 },
            { header: 'Notes', key: 'notes', width: 25 }
        ];
        
        transactions.forEach(t => {
            sheet.addRow({
                transactionDate: t.transactionDate.toLocaleDateString('en-IN'),
                description: t.description,
                referenceNumber: t.referenceNumber,
                type: t.type, amount: t.amount, balance: t.balance,
                matchStatus: t.matchStatus, matchedTo: t.matchedTo,
                category: t.category, matchConfidence: t.matchConfidence,
                notes: t.notes
            });
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Bank_Reconciliation.xlsx');
        return workbook.xlsx.write(res).then(() => res.status(200).end());
    } catch (e) { res.status(500).send(e.message); }
});

// ============================================================
//   CUSTOMER MASTER PAGE
// ============================================================

app.get('/customers', requireAuth, requireAdmin, async (req, res) => {
    const customers = await Customer.find().sort({ updatedAt: -1 }).limit(500);
    res.render('customers', { user: req.session.user, customers });
});

// ============================================================
//   AGENT ENFORCEMENT MIDDLEWARE
// ============================================================

// All agent routes should redirect agent to mobile app paths
// Admin shouldn't end up on agent paths
function agentOnly(req, res, next) {
    if (!req.session.user) return res.redirect('/');
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    next();
}

// ============================================================
//   CHAT SYSTEM (admin ↔ agent communication)
// ============================================================

function makeConversationId(u1, u2) {
    return [u1, u2].sort().join('___');
}

// Chat page (full UI)
app.get('/chat', requireAuth, async (req, res) => {
    const me = req.session.user.username;
    const myRole = req.session.user.role;
    
    // Build conversation partners list
    let partners = [];
    if (myRole === 'admin') {
        // Admin can chat with all agents (vijay, rahul) - also any registered Employee usernames
        const employees = await Employee.find({ username: { $ne: '', $exists: true } });
        const usernames = new Set(['vijay', 'rahul']);
        employees.forEach(e => { if (e.username) usernames.add(e.username); });
        partners = Array.from(usernames).filter(u => u !== me).map(u => ({ username: u, name: u, role: 'agent' }));
    } else {
        // Agents chat with admin
        partners = [{ username: 'admin', name: 'Admin', role: 'admin' }];
    }
    
    // Get unread counts and last messages
    for (const p of partners) {
        const convId = makeConversationId(me, p.username);
        const unread = await ChatMessage.countDocuments({ 
            conversationId: convId, 
            receiver: me, 
            read: false, 
            deleted: false 
        });
        const lastMsg = await ChatMessage.findOne({ 
            conversationId: convId, 
            deleted: false 
        }).sort({ createdAt: -1 });
        
        p.unread = unread;
        p.lastMessage = lastMsg ? (lastMsg.text || (lastMsg.attachments.length > 0 ? '📎 ' + lastMsg.attachments[0].fileName : '')) : '';
        p.lastTime = lastMsg ? lastMsg.createdAt : null;
        p.conversationId = convId;
    }
    
    // Sort by latest message
    partners.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    
    // If a specific chat is requested
    const activePartner = req.query.with || (partners[0] ? partners[0].username : '');
    let messages = [];
    if (activePartner) {
        const convId = makeConversationId(me, activePartner);
        messages = await ChatMessage.find({ conversationId: convId, deleted: false })
            .sort({ createdAt: 1 })
            .limit(100);
        
        // Mark received messages as read
        await ChatMessage.updateMany(
            { conversationId: convId, receiver: me, read: false },
            { $set: { read: true, readAt: new Date() } }
        );
    }
    
    res.render('chat', { 
        user: req.session.user, 
        partners, 
        activePartner, 
        messages,
        myRole
    });
});

// Send message API
app.post('/api/chat/send', requireAuth, async (req, res) => {
    try {
        const me = req.session.user.username;
        const { receiver, text, attachments } = req.body;
        
        if (!receiver) return res.status(400).json({ error: 'Receiver required' });
        if (!text && (!attachments || attachments.length === 0)) {
            return res.status(400).json({ error: 'Message or attachment required' });
        }
        
        // Filter attachment sizes (max 5MB each)
        const filteredAttachments = (attachments || []).filter(a => {
            const sizeKB = (a.data || '').length * 0.75 / 1024;
            return sizeKB <= 5120; // 5MB
        });
        
        const msg = new ChatMessage({
            conversationId: makeConversationId(me, receiver),
            sender: me,
            receiver,
            text: text || '',
            attachments: filteredAttachments
        });
        await msg.save();
        
        res.json({ success: true, message: msg });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Poll new messages (long-polling alternative)
app.get('/api/chat/messages/:partner', requireAuth, async (req, res) => {
    try {
        const me = req.session.user.username;
        const partner = req.params.partner;
        const convId = makeConversationId(me, partner);
        
        const since = req.query.since ? new Date(req.query.since) : null;
        const filter = { conversationId: convId, deleted: false };
        if (since) filter.createdAt = { $gt: since };
        
        const messages = await ChatMessage.find(filter).sort({ createdAt: 1 }).limit(50);
        
        // Auto-mark received as read
        await ChatMessage.updateMany(
            { conversationId: convId, receiver: me, read: false },
            { $set: { read: true, readAt: new Date() } }
        );
        
        res.json({ messages });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get unread counts (for header badge)
app.get('/api/chat/unread-count', requireAuth, async (req, res) => {
    try {
        const me = req.session.user.username;
        const count = await ChatMessage.countDocuments({ receiver: me, read: false, deleted: false });
        res.json({ count });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete message (soft delete)
app.delete('/api/chat/message/:id', requireAuth, async (req, res) => {
    try {
        const me = req.session.user.username;
        const msg = await ChatMessage.findById(req.params.id);
        if (!msg) return res.status(404).json({ error: 'Not found' });
        if (msg.sender !== me) return res.status(403).json({ error: 'Can only delete your own messages' });
        msg.deleted = true;
        await msg.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================================================
//   SOFTWARE PRODUCTS & INVOICING SYSTEM
// ============================================================

// List all softwares
app.get('/software', requireAuth, requireAdmin, async (req, res) => {
    const softwares = await Software.find().sort({ createdAt: -1 }).lean();
    const recentInvoices = await SoftwareInvoice.find().select('-items').sort({ createdAt: -1 }).limit(20).lean();
    
    const stats = {
        totalSoftwares: softwares.length,
        activeClients: softwares.reduce((s, sw) => s + (sw.clients || []).filter(c => c.status === 'Active').length, 0),
        totalRevenue: softwares.reduce((s, sw) => s + (sw.totalRevenueEarned || 0), 0),
        totalInvoices: await SoftwareInvoice.countDocuments(),
        pendingPayment: await SoftwareInvoice.countDocuments({ status: { $ne: 'Fully Paid' } }),
        paidThisMonth: await SoftwareInvoice.countDocuments({ 
            status: 'Fully Paid',
            paymentDate: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
        })
    };
    
    res.render('software-list', { user: req.session.user, softwares, recentInvoices, stats });
});

// Software detail page (clients + invoices for this software)
app.get('/software/:id', requireAuth, requireAdmin, async (req, res) => {
    const software = await Software.findById(req.params.id);
    if (!software) return res.status(404).send('Software not found');
    
    const invoices = await SoftwareInvoice.find({ softwareCode: software.code })
        .select('-items')
        .sort({ createdAt: -1 }).limit(50).lean();
    
    res.render('software-detail', { user: req.session.user, software, invoices });
});

// Create software
app.post('/api/software', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        const sw = new Software(data);
        await sw.save();
        res.json({ success: true, software: sw });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Update software
app.put('/api/software/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const sw = await Software.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, software: sw });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add client to software
app.post('/api/software/:id/clients', requireAuth, requireAdmin, async (req, res) => {
    try {
        const sw = await Software.findById(req.params.id);
        sw.clients.push(req.body);
        await sw.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === INVOICE: List ===
app.get('/invoices', requireAuth, requireAdmin, async (req, res) => {
    const filter = {};
    if (req.query.software) filter.softwareCode = req.query.software;
    if (req.query.status) filter.status = req.query.status;
    
    const invoices = await SoftwareInvoice.find(filter)
        .select('-items')
        .sort({ createdAt: -1 }).limit(100).lean();
    
    const softwares = await Software.find({ status: 'Active' }).select('code name clients').lean();
    
    const stats = {
        total: invoices.length,
        pending: invoices.filter(i => i.status !== 'Fully Paid' && i.status !== 'Cancelled').length,
        paid: invoices.filter(i => i.status === 'Fully Paid').length,
        totalDue: invoices.filter(i => i.status !== 'Fully Paid').reduce((s, i) => s + i.grandTotal, 0),
        totalReceived: invoices.filter(i => i.status === 'Fully Paid').reduce((s, i) => s + i.grandTotal, 0)
    };
    
    res.render('invoices-list', { user: req.session.user, invoices, softwares, stats, query: req.query });
});

// Create new invoice (page)
app.get('/invoices/new', requireAuth, requireAdmin, async (req, res) => {
    const softwares = await Software.find({ status: 'Active' }).lean();
    res.render('invoice-new', { user: req.session.user, softwares, presetSoftware: req.query.software || '' });
});

// View single invoice
app.get('/invoices/:id', requireAuth, requireAdmin, async (req, res) => {
    const invoice = await SoftwareInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).send('Invoice not found');
    res.render('invoice-detail', { user: req.session.user, invoice });
});

// Create invoice API
app.post('/api/invoices', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        
        // Auto-generate invoice number
        const year = new Date().getFullYear();
        const month = String(new Date().getMonth() + 1).padStart(2, '0');
        const code = data.softwareCode || 'INV';
        const count = await SoftwareInvoice.countDocuments({
            invoiceNumber: { $regex: '^SEA-INV-' + year + '-' + code }
        });
        data.invoiceNumber = 'SEA-INV-' + year + '-' + code + '-' + String(count + 1).padStart(2, '0') + month;
        data.createdBy = req.session.user.username;
        
        // Generate amount in words
        const tempInvoice = new SoftwareInvoice(data);
        tempInvoice.amountInWords = numberToWords(tempInvoice.grandTotal);
        await tempInvoice.save();
        
        // Update software stats
        if (data.softwareCode) {
            await Software.findOneAndUpdate(
                { code: data.softwareCode },
                { $inc: { totalInvoicesGenerated: 1 } }
            );
        }
        
        res.json({ success: true, invoice: tempInvoice });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Mark invoice as paid
app.post('/api/invoices/:id/mark-paid', requireAuth, requireAdmin, async (req, res) => {
    try {
        const invoice = await SoftwareInvoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ error: 'Not found' });
        
        invoice.status = 'Fully Paid';
        invoice.paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : new Date();
        invoice.amountReceived = invoice.grandTotal;
        invoice.paymentMode = req.body.paymentMode || 'Bank Transfer';
        invoice.paymentReference = req.body.paymentReference || '';
        invoice.paymentNotes = req.body.paymentNotes || '';
        
        await invoice.save();
        
        // Update software revenue
        if (invoice.softwareCode) {
            await Software.findOneAndUpdate(
                { code: invoice.softwareCode },
                { $inc: { totalRevenueEarned: invoice.grandTotal } }
            );
        }
        
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete invoice
app.delete('/api/invoices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await SoftwareInvoice.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === DOWNLOAD PDF ===
app.get('/invoices/:id/pdf', requireAuth, async (req, res) => {
    try {
        const invoice = await SoftwareInvoice.findById(req.params.id);
        if (!invoice) return res.status(404).send('Invoice not found');
        
        const isPaid = req.query.paid === '1' || invoice.status === 'Fully Paid';
        
        res.setHeader('Content-Type', 'application/pdf');
        const suffix = isPaid ? '_PAID' : '';
        res.setHeader('Content-Disposition', 'inline; filename="' + invoice.invoiceNumber + suffix + '.pdf"');
        
        const doc = generateSoftwareInvoicePDF(invoice, { isPaid });
        doc.pipe(res);
    } catch (e) { console.error(e); res.status(500).send(e.message); }
});

// ============ START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Searvator CRM running on port ${PORT}`));
