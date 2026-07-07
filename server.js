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
app.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/agent');
    }
    res.render('login', { error: null });
});
app.post('/login', (req, res) => {
    const username = (req.body.username || '').trim().toLowerCase();
    const password = req.body.password || '';
    
    if (username === 'admin' && password === 'admin123') {
        req.session.user = { username: 'admin', role: 'admin' };
        return res.redirect('/admin');
    }
    // Agents: require a password (not blank)
    if ((username === 'vijay' || username === 'rahul') && password.length >= 4) {
        req.session.user = { username, role: 'agent' };
        return res.redirect('/agent');
    }
    // Invalid → re-render login with error
    res.render('login', { error: 'Invalid username or password. Please try again.' });
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
            // DUPLICATE CHECK: same mobile + revenue completed in last 5 min (double submit)
            const mobile = (req.body.mobileNumber || '').trim();
            if (mobile) {
                const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
                const dup = await Entry.findOne({
                    mobileNumber: mobRegex,
                    revenue: Number(req.body.revenue) || 0,
                    jobStatus: 'Completed',
                    createdAt: { $gte: fiveMinAgo }
                }).lean();
                if (dup) {
                    return res.redirect('/agent'); // silently ignore duplicate submit
                }
            }
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
    try {
        const mobile = (req.body.mobileNumber || '').trim();
        const name = (req.body.customerName || '').trim();
        const desc = (req.body.description || '').trim();
        if (!name || !mobile) {
            return res.status(400).send('Customer name and mobile are required. <a href="javascript:history.back()">← Back</a>');
        }
        // DUPLICATE CHECK: same mobile + same requirement in last 10 min (double submit / accidental repeat)
        const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const dup = await Order.findOne({
            mobileNumber: mobRegex,
            description: desc,
            createdAt: { $gte: tenMinAgo }
        }).lean();
        if (dup) {
            return res.status(409).send(`DUPLICATE blocked: Same request for "${name}" (${mobile}) was just added. <a href="javascript:history.back()">← Back</a>`);
        }
        const newOrder = new Order(req.body);
        newOrder.createdBy = req.session.user.username;
        if (req.session.user.role === 'admin') newOrder.assignedAgent = req.body.assignedAgent || 'Pending';
        await newOrder.save();
        res.redirect(req.session.user.role === 'admin' ? '/admin' : '/agent');
    } catch (err) { res.status(500).send(err.message); }
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
    try {
        const mobile = (req.body.mobileNumber || '').trim();
        const name = (req.body.customerName || '').trim();
        if (!name || !mobile) {
            return res.status(400).send('Customer name and mobile are required');
        }
        // DUPLICATE CHECK: same mobile already has a Pending/Assigned lead (not yet completed)
        const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
        const existing = await Entry.findOne({
            mobileNumber: mobRegex,
            jobStatus: 'Assigned'
        }).lean();
        if (existing) {
            return res.status(409).send(`DUPLICATE: "${name}" (${mobile}) ka ek pending lead pehle se hai (assigned to ${existing.agentName}). Naya banane ke bajaye usi ko update karo. <a href="/admin">← Wapas jao</a>`);
        }
        const newEntry = new Entry({
            customerName: name,
            mobileNumber: mobile,
            location: req.body.location,
            agentName: req.body.agentName,
            jobStatus: 'Assigned'
        });
        await newEntry.save();
        res.redirect('/admin');
    } catch (err) { res.status(500).send(err.message); }
});

// ============ DUPLICATE CLEANUP ============
// Find duplicate hardware entries (same mobile + name, grouped)
app.get('/api/admin/duplicates', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const entries = await Entry.find()
            .select('customerName mobileNumber location jobStatus revenue createdAt whatsappSent agentName')
            .sort({ createdAt: -1 }).lean();
        
        // Group by normalized mobile (last 10 digits)
        const groups = {};
        entries.forEach(e => {
            const mob = (e.mobileNumber || '').replace(/\D/g, '').slice(-10);
            if (!mob) return;
            if (!groups[mob]) groups[mob] = [];
            groups[mob].push(e);
        });
        
        // Only keep groups with 2+ entries (duplicates)
        const dupGroups = Object.entries(groups)
            .filter(([mob, list]) => list.length > 1)
            .map(([mob, list]) => ({
                mobile: mob,
                customerName: list[0].customerName,
                count: list.length,
                entries: list.map(e => ({
                    id: e._id, name: e.customerName, location: e.location,
                    status: e.jobStatus, revenue: e.revenue, date: e.createdAt,
                    waSent: e.whatsappSent, agent: e.agentName
                }))
            }))
            .sort((a, b) => b.count - a.count);
        
        res.json({ success: true, groups: dupGroups, totalDuplicates: dupGroups.reduce((s, g) => s + (g.count - 1), 0) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete selected duplicate entries by IDs
app.post('/api/admin/duplicates/delete', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No entries selected' });
        }
        const result = await Entry.deleteMany({ _id: { $in: ids } });
        res.json({ success: true, deleted: result.deletedCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    doc.fillColor('#fcd34d').fontSize(7).font('Helvetica-Bold').text('CIN: U62011GJ2026PTC172346', 0, 110, { align: 'right', width: W - 40, lineBreak: false });
}

// Reusable services + contact footer for all PDFs
function drawPdfFooter(doc) {
    const W = doc.page.width;
    const H = doc.page.height;
    const footerY = H - 138;
    
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
    doc.fillColor('#fcd34d').fontSize(8).font('Helvetica-Bold')
        .text('CIN: U62011GJ2026PTC172346', 0, footerY + 113, { align: 'center', width: W, lineBreak: false, height: 10 });
    doc.fillColor('#64748b').fontSize(7).font('Helvetica')
        .text('Ahmedabad, Gujarat, India  |  This is a system-generated document', 0, footerY + 123, { align: 'center', width: W, lineBreak: false, height: 10 });
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
    // Pre-fill from customer if mobile provided
    let prefillCustomer = null;
    if (req.query.mobile) {
        const mob = req.query.mobile.replace(/\D/g, '').slice(-10);
        prefillCustomer = await Customer.findOne({ mobile: new RegExp(mob + '$') }).lean();
    }
    res.render('quotation-builder', { user: req.session.user, products, quotation: null, prefillCustomer });
});

app.get('/cctv/quotation/:id/edit', requireAuth, requireAdmin, async (req, res) => {
    const products = await CCTVProduct.find({ inStock: true }).sort({ category: 1, productName: 1 });
    const quotation = await Quotation.findById(req.params.id);
    res.render('quotation-builder', { user: req.session.user, products, quotation, prefillCustomer: null });
});

// Quotation Detail / Order Management page (view-only + actions: payment, dates, vendor, status)
app.get('/cctv/quotation/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const quotation = await Quotation.findById(req.params.id).lean();
        if (!quotation) return res.status(404).send('Quotation not found');
        
        // === CUSTOMER-WIDE SUMMARY (match by mobile) ===
        const mob = (quotation.clientMobile || '').replace(/\D/g, '').slice(-10);
        let custSummary = null;
        if (mob) {
            const mobRegex = new RegExp(mob + '$');
            const [allQuotes, corpEntries, hwEntries] = await Promise.all([
                Quotation.find({ clientMobile: mobRegex }).select('quotationNumber grandTotal totalPaid balanceDue status paymentStatus totalVendorCost grossProfit createdAt projectType').sort({ createdAt: -1 }).lean(),
                CorporateEntry.find({ mobileNumber: mobRegex }).select('entryNumber grandTotal amountReceived amountDue paymentStatus createdAt serviceType').sort({ createdAt: -1 }).lean(),
                Entry.find({ mobileNumber: mobRegex }).select('entryNumber revenue amountReceived amountDue paymentStatus createdAt workType').sort({ createdAt: -1 }).lean()
            ]);
            
            // Aggregate everything for this customer
            let totalOrderValue = 0, totalPaid = 0, totalDue = 0, totalVendorCost = 0, totalProfit = 0;
            let orderCount = 0;
            
            allQuotes.forEach(q => {
                totalOrderValue += q.grandTotal || 0;
                totalPaid += q.totalPaid || 0;
                totalDue += (q.balanceDue !== undefined ? q.balanceDue : Math.max(0, (q.grandTotal || 0) - (q.totalPaid || 0)));
                totalVendorCost += q.totalVendorCost || 0;
                totalProfit += (q.grossProfit !== undefined ? q.grossProfit : (q.grandTotal || 0) - (q.totalVendorCost || 0));
                orderCount++;
            });
            corpEntries.forEach(c => {
                totalOrderValue += c.grandTotal || 0;
                totalPaid += c.amountReceived || 0;
                totalDue += c.amountDue || 0;
                orderCount++;
            });
            hwEntries.forEach(e => {
                totalOrderValue += e.revenue || 0;
                totalPaid += e.amountReceived || 0;
                totalDue += e.amountDue || 0;
                orderCount++;
            });
            
            custSummary = {
                mobile: quotation.clientMobile,
                name: quotation.clientName,
                company: quotation.clientCompany,
                orderCount,
                totalOrderValue, totalPaid, totalDue,
                totalVendorCost, totalProfit,
                quotations: allQuotes,
                corpEntries, hwEntries
            };
        }
        
        res.render('quotation-detail', { user: req.session.user, quotation, custSummary });
    } catch (e) { console.error(e); res.status(500).send(e.message); }
});

app.post('/api/quotations', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        data.quotationNumber = await genSequentialNumber(Quotation, 'SEA-Q', 'quotationNumber');
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

        // Auto-link or create customer so quotation shows in Customer 360
        const mob = (data.clientMobile || '').replace(/\D/g, '').slice(-10);
        if (mob) {
            let customer = await Customer.findOne({ mobile: new RegExp(mob + '$') });
            if (!customer) {
                customer = await Customer.create({
                    name: data.clientName, mobile: data.clientMobile, companyName: data.clientCompany || '',
                    email: data.clientEmail || '', primaryAddress: data.clientAddress || '', sourceModule: 'Quotation'
                });
            }
            data.customerId = customer._id;
        }

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
        // Recompute balance/profit since grandTotal may have changed (products added/removed)
        if (quotation && data.grandTotal !== undefined) {
            quotation.balanceDue = Math.max(0, quotation.grandTotal - (quotation.totalPaid || 0));
            quotation.grossProfit = quotation.grandTotal - (quotation.totalVendorCost || 0);
            if (quotation.totalPaid >= quotation.grandTotal && quotation.totalPaid > 0) quotation.paymentStatus = 'Fully Paid';
            else if (quotation.totalPaid > 0) quotation.paymentStatus = 'Advance Paid';
            await quotation.save();
        }
        res.json({ success: true, quotation });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/quotations/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Quotation.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === QUOTATION LIFECYCLE ACTIONS ===

// Mark as Sent
app.post('/api/quotations/:id/sent', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findByIdAndUpdate(req.params.id, 
            { status: 'Sent', sentAt: new Date() }, { new: true });
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Approve quotation (customer accepted)
app.post('/api/quotations/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        q.status = 'Approved';
        q.approvedAt = new Date();
        q.approvedBy = req.session.user.username;
        
        // Optional advance payment at approval
        if (req.body.advance) {
            const adv = Number(req.body.advance) || 0;
            q.advanceReceived = adv;
            q.advanceDate = new Date();
            q.advanceMode = req.body.advanceMode || '';
            // Log as payment transaction
            q.payments.push({
                amount: adv, date: new Date(), mode: req.body.advanceMode || 'Cash',
                type: 'Advance', note: 'Advance at approval', recordedBy: req.session.user.username
            });
            q.totalPaid = q.payments.reduce((s, p) => s + p.amount, 0);
            q.balanceDue = Math.max(0, (q.grandTotal || 0) - q.totalPaid);
            q.paymentStatus = q.totalPaid >= q.grandTotal ? 'Fully Paid' : 'Advance Paid';
        }
        q.orderReceivedDate = new Date(); // order confirmed = approval date
        q.deliveryStatus = 'In Progress';
        
        // Link/create customer
        const mob = (q.clientMobile || '').replace(/\D/g, '').slice(-10);
        if (mob) {
            let customer = await Customer.findOne({ mobile: new RegExp(mob + '$') });
            if (!customer) {
                customer = await Customer.create({
                    name: q.clientName, mobile: q.clientMobile, companyName: q.clientCompany,
                    email: q.clientEmail, primaryAddress: q.clientAddress, sourceModule: 'Quotation'
                });
            }
            q.customerId = customer._id;
        }
        
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Reject quotation
app.post('/api/quotations/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findByIdAndUpdate(req.params.id,
            { status: 'Rejected', rejectedAt: new Date(), rejectionReason: req.body.reason || '' },
            { new: true });
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== JOB COSTING & COMMISSION HELPER (Phase 1) =====
// Recomputes conveyance, commissions, net profit, and payout lock status
function computeJobCosting(q) {
    const revenue = q.grandTotal || 0;
    const vendorCost = q.totalVendorCost || 0;
    
    // Conveyance = km * rate
    q.conveyanceAllowance = (q.conveyanceKm || 0) * (q.conveyanceRate || 0);
    
    // Commission base: 'profit' (Revenue - Vendor) or 'gross' (Revenue)
    const base = q.commissionBase === 'gross' ? revenue : Math.max(0, revenue - vendorCost);
    q.leadCommissionAmount = Math.round(base * (q.leadCommissionPct || 0) / 100);
    q.engineerCommissionAmount = Math.round(base * (q.engineerCommissionPct || 0) / 100);
    
    // Net profit = Revenue - (Vendor + Conveyance + LeadComm + EngComm)
    q.netProfit = revenue - (vendorCost + q.conveyanceAllowance + q.leadCommissionAmount + q.engineerCommissionAmount);
    
    // Payout lock: unlock only when payment fully received
    const fullyPaid = (q.totalPaid || 0) >= revenue && revenue > 0;
    q.jobCostingLocked = !fullyPaid;
    if (q.payoutStatus !== 'Paid') {
        q.payoutStatus = fullyPaid ? 'Unlocked' : 'Locked';
    }
    return q;
}

// Update commission/costing settings for a quotation
app.post('/api/quotations/:id/costing', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        const { orderCategory, leadPartner, assignedEngineer, conveyanceKm, conveyanceRate,
                commissionBase, leadCommissionPct, engineerCommissionPct } = req.body;
        
        if (orderCategory !== undefined) q.orderCategory = orderCategory;
        if (leadPartner !== undefined) q.leadPartner = leadPartner.trim();
        if (assignedEngineer !== undefined) q.assignedEngineer = assignedEngineer.trim();
        if (conveyanceKm !== undefined) q.conveyanceKm = Math.max(0, Number(conveyanceKm) || 0);
        if (conveyanceRate !== undefined) q.conveyanceRate = Math.max(0, Number(conveyanceRate) || 0);
        if (commissionBase !== undefined) q.commissionBase = commissionBase === 'gross' ? 'gross' : 'profit';
        if (leadCommissionPct !== undefined) q.leadCommissionPct = Math.max(0, Math.min(100, Number(leadCommissionPct) || 0));
        if (engineerCommissionPct !== undefined) q.engineerCommissionPct = Math.max(0, Math.min(100, Number(engineerCommissionPct) || 0));
        
        computeJobCosting(q);
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mark commission as paid out (only when unlocked)
app.post('/api/quotations/:id/payout', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        computeJobCosting(q);
        if (q.jobCostingLocked) {
            return res.status(400).json({ error: 'Payout locked. Client payment not fully received yet.' });
        }
        q.payoutStatus = 'Paid';
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Record payment against approved quotation (logs transaction + tracks due)
app.post('/api/quotations/:id/payment', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        const amount = Number(req.body.amount) || 0;
        if (amount <= 0) return res.status(400).json({ error: 'Enter valid amount greater than 0' });
        
        // VALIDATION: cannot pay more than the balance due
        const currentPaid = q.payments.reduce((s, p) => s + (p.amount || 0), 0);
        const dueNow = Math.max(0, (q.grandTotal || 0) - currentPaid);
        if (amount > dueNow) {
            return res.status(400).json({ error: `Payment cannot exceed balance due. Due is Rs.${dueNow.toLocaleString('en-IN')}, you entered Rs.${amount.toLocaleString('en-IN')}` });
        }
        
        // Log the payment transaction
        q.payments.push({
            amount,
            date: req.body.date ? new Date(req.body.date) : new Date(),
            mode: req.body.mode || 'Cash',
            reference: req.body.reference || '',
            type: req.body.type || 'Payment',
            note: req.body.note || '',
            recordedBy: req.session.user.username
        });
        
        // Recompute totals
        q.totalPaid = q.payments.reduce((s, p) => s + (p.amount || 0), 0);
        // Keep advanceReceived in sync (first payment or explicitly marked advance)
        q.advanceReceived = q.payments.filter(p => p.type === 'Advance').reduce((s, p) => s + p.amount, 0);
        q.finalPaymentReceived = q.totalPaid - q.advanceReceived;
        q.balanceDue = Math.max(0, (q.grandTotal || 0) - q.totalPaid);
        q.paymentStatus = q.totalPaid >= (q.grandTotal || 0) ? 'Fully Paid' : q.totalPaid > 0 ? 'Advance Paid' : 'Pending';
        
        // Recompute job costing (payout auto-unlocks when fully paid)
        computeJobCosting(q);
        
        await q.save();
        res.json({ success: true, quotation: q, totalPaid: q.totalPaid, balanceDue: q.balanceDue });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Update quotation lifecycle dates (order/delivery/installation)
app.post('/api/quotations/:id/lifecycle', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        const { orderReceivedDate, expectedDeliveryDate, actualDeliveryDate, installationDate, installationStatus, deliveryStatus } = req.body;
        if (orderReceivedDate !== undefined) q.orderReceivedDate = orderReceivedDate ? new Date(orderReceivedDate) : null;
        if (expectedDeliveryDate !== undefined) q.expectedDeliveryDate = expectedDeliveryDate ? new Date(expectedDeliveryDate) : null;
        if (actualDeliveryDate !== undefined) q.actualDeliveryDate = actualDeliveryDate ? new Date(actualDeliveryDate) : null;
        if (installationDate !== undefined) q.installationDate = installationDate ? new Date(installationDate) : null;
        if (installationStatus !== undefined) q.installationStatus = installationStatus;
        if (deliveryStatus !== undefined) q.deliveryStatus = deliveryStatus;
        
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mark delivered
app.post('/api/quotations/:id/deliver', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findByIdAndUpdate(req.params.id,
            { deliveryStatus: 'Delivered', deliveredAt: new Date(), status: 'Converted' },
            { new: true });
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// === VENDOR PROCUREMENT (after quotation approval) ===

// Add vendor procurement line to approved quotation
app.post('/api/quotations/:id/vendor', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        const { vendorName, vendorId, productName, quantity, vendorPrice, deliveryCharges, expectedDelivery, notes } = req.body;
        const qty = Number(quantity) || 1;
        const price = Number(vendorPrice) || 0;
        const delivery = Number(deliveryCharges) || 0;
        const totalVendorCost = (qty * price) + delivery;
        
        q.vendorProcurement.push({
            vendorName, vendorId: vendorId || undefined, productName,
            quantity: qty, vendorPrice: price, deliveryCharges: delivery,
            totalVendorCost, paymentToVendor: 0, vendorPaymentStatus: 'Pending',
            deliveryStatus: 'Ordered', expectedDelivery: expectedDelivery || undefined, notes: notes || ''
        });
        
        // Recompute totals
        q.totalVendorCost = q.vendorProcurement.reduce((s, v) => s + (v.totalVendorCost || 0), 0);
        q.totalVendorPaid = q.vendorProcurement.reduce((s, v) => s + (v.paymentToVendor || 0), 0);
        q.grossProfit = (q.grandTotal || 0) - q.totalVendorCost;
        computeJobCosting(q);
        
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Update vendor procurement line (payment/delivery status)
app.put('/api/quotations/:id/vendor/:vIdx', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        
        const v = q.vendorProcurement[req.params.vIdx];
        if (!v) return res.status(404).json({ error: 'Vendor line not found' });
        
        const { paymentToVendor, deliveryStatus, receivedDate, addPayment } = req.body;
        const alreadyPaid = v.paymentToVendor || 0;
        const totalCost = v.totalVendorCost || 0;
        const dueNow = Math.max(0, totalCost - alreadyPaid);
        
        if (addPayment !== undefined) {
            const amt = Number(addPayment) || 0;
            if (amt <= 0) return res.status(400).json({ error: 'Enter a valid amount greater than 0' });
            // VALIDATION: cannot pay more than what's due
            if (amt > dueNow) {
                return res.status(400).json({ error: `Payment cannot exceed due amount. Due is Rs.${dueNow.toLocaleString('en-IN')}, you tried Rs.${amt.toLocaleString('en-IN')}` });
            }
            v.paymentToVendor = alreadyPaid + amt;
        } else if (paymentToVendor !== undefined) {
            const amt = Number(paymentToVendor) || 0;
            // VALIDATION: total paid cannot exceed total cost
            if (amt > totalCost) {
                return res.status(400).json({ error: `Total payment cannot exceed vendor cost of Rs.${totalCost.toLocaleString('en-IN')}` });
            }
            v.paymentToVendor = Math.max(0, amt);
        }
        
        v.vendorPaymentStatus = v.paymentToVendor >= v.totalVendorCost ? 'Paid' : v.paymentToVendor > 0 ? 'Partial' : 'Pending';
        if (deliveryStatus) v.deliveryStatus = deliveryStatus;
        if (deliveryStatus === 'Received') v.receivedDate = new Date();
        
        q.totalVendorPaid = q.vendorProcurement.reduce((s, vp) => s + (vp.paymentToVendor || 0), 0);
        
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete vendor procurement line
app.delete('/api/quotations/:id/vendor/:vIdx', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        q.vendorProcurement.splice(req.params.vIdx, 1);
        q.totalVendorCost = q.vendorProcurement.reduce((s, v) => s + (v.totalVendorCost || 0), 0);
        q.totalVendorPaid = q.vendorProcurement.reduce((s, v) => s + (v.paymentToVendor || 0), 0);
        q.grossProfit = (q.grandTotal || 0) - q.totalVendorCost;
        computeJobCosting(q);
        await q.save();
        res.json({ success: true, quotation: q });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get vendors list for dropdown
app.get('/api/vendors-list', requireAuth, requireAdmin, async (req, res) => {
    try {
        const vendors = await Vendor.find().select('vendorName mobile').sort({ vendorName: 1 }).lean();
        res.json({ success: true, vendors });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// All Quotations list (lifecycle dashboard)
app.get('/quotations', requireAuth, requireAdmin, async (req, res) => {
    const filter = {};
    // view mode: 'active' (default, hides approved) or 'approved' or 'all'
    const view = req.query.view || 'active';
    
    if (req.query.status) {
        // Explicit status filter overrides view
        filter.status = req.query.status;
    } else if (view === 'active') {
        // Active = not yet approved/converted (still real "quotations")
        filter.status = { $in: ['Draft', 'Sent', 'Rejected'] };
    } else if (view === 'approved') {
        filter.status = { $in: ['Approved', 'Converted'] };
    }
    // view === 'all' → no status filter
    
    const quotations = await Quotation.find(filter).select('-items').sort({ createdAt: -1 }).limit(200).lean();
    
    const allQuotes = await Quotation.find().select('status grandTotal advanceReceived finalPaymentReceived totalPaid').lean();
    const stats = {
        total: allQuotes.length,
        draft: allQuotes.filter(q => q.status === 'Draft').length,
        sent: allQuotes.filter(q => q.status === 'Sent').length,
        approved: allQuotes.filter(q => q.status === 'Approved').length,
        rejected: allQuotes.filter(q => q.status === 'Rejected').length,
        converted: allQuotes.filter(q => q.status === 'Converted').length,
        active: allQuotes.filter(q => ['Draft', 'Sent', 'Rejected'].includes(q.status)).length,
        approvedValue: allQuotes.filter(q => q.status === 'Approved' || q.status === 'Converted').reduce((s, q) => s + (q.grandTotal || 0), 0),
        collected: allQuotes.reduce((s, q) => s + (q.totalPaid || (q.advanceReceived || 0) + (q.finalPaymentReceived || 0)), 0)
    };
    
    res.render('quotations-list', { user: req.session.user, quotations, stats, query: req.query, view });
});

// CCTV Quotation PDF
app.get('/api/quotations/:id/pdf', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = await Quotation.findById(req.params.id);
        if (!q) return res.status(404).send('Not found');

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        // Block auto page additions - prevents blank overflow pages
        const _origAddPage = doc.addPage.bind(doc);
        doc.addPage = function() { return doc; };
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${q.quotationNumber}.pdf"`);
        doc.pipe(res);

        doc.rect(0, 0, doc.page.width, 90).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold').text('SEARVATOR', 40, 22);
        doc.fontSize(9).font('Helvetica').fillColor('#94a3b8').text('AI • Hardware • CCTV • Biometric Solutions', 40, 52);
        doc.fontSize(7).fillColor('#fcd34d').font('Helvetica-Bold').text('CIN: U62011GJ2026PTC172346', 40, 66);
        doc.fontSize(9).fillColor('#cbd5e1').font('Helvetica').text('QUOTATION', 0, 28, { align: 'right', width: doc.page.width - 40 });
        doc.fontSize(14).fillColor('#ffffff').font('Helvetica-Bold').text(q.quotationNumber, 0, 44, { align: 'right', width: doc.page.width - 40 });
        doc.fontSize(7).fillColor('#94a3b8').font('Helvetica').text('+91 9106959092 | www.searvator.com', 0, 66, { align: 'right', width: doc.page.width - 40 });

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
        const colX = { sno: 40, desc: 70, qty: 300, unit: 332, price: 372, warr: 432, total: 502 };

        doc.rect(40, tableTop, doc.page.width - 80, 24).fill('#0f172a');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
        doc.text('#', colX.sno, tableTop + 8);
        doc.text('Description', colX.desc, tableTop + 8);
        doc.text('Qty', colX.qty, tableTop + 8);
        doc.text('Unit', colX.unit, tableTop + 8);
        doc.text('Price', colX.price, tableTop + 8);
        doc.text('Warranty', colX.warr, tableTop + 8);
        doc.text('Total', colX.total, tableTop + 8);

        y = tableTop + 24;
        doc.fillColor('#000000').font('Helvetica').fontSize(9);

        (q.items || []).forEach((item, idx) => {
            const specText = item.specifications || '';
            const descWidth = 222;
            // Measure how tall the spec text will be when wrapped (full text, no cut)
            let specHeight = 0;
            if (specText) {
                doc.font('Helvetica').fontSize(7.5);
                specHeight = doc.heightOfString(specText, { width: descWidth });
            }
            // Measure product name height too
            doc.font('Helvetica-Bold').fontSize(9);
            const nameHeight = doc.heightOfString(item.productName || '', { width: descWidth });
            // Dynamic row height: name + spec + padding (min 22)
            const rowHeight = Math.max(22, nameHeight + specHeight + 10);
            
            // Zebra background
            if (idx % 2 === 0) {
                doc.rect(40, y, doc.page.width - 80, rowHeight).fill('#f8fafc');
            }
            doc.fillColor('#000000').font('Helvetica').fontSize(9);
            doc.text(String(idx + 1), colX.sno, y + 6, { lineBreak: false });
            // Product name (wraps if long)
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(item.productName || '', colX.desc, y + 6, { width: descWidth });
            // Full specifications (wraps, NOT cut)
            if (specText) {
                doc.font('Helvetica').fillColor('#64748b').fontSize(7.5).text(specText, colX.desc, y + 6 + nameHeight + 2, { width: descWidth });
            }
            // Other columns (aligned to top of row)
            doc.fillColor('#000000').font('Helvetica').fontSize(9);
            doc.text(String(item.quantity), colX.qty, y + 6, { lineBreak: false });
            doc.text(item.unit || 'Pcs', colX.unit, y + 6, { lineBreak: false });
            doc.text(`Rs.${(item.unitPrice||0).toLocaleString('en-IN')}`, colX.price, y + 6, { width: 55, lineBreak: false });
            doc.fillColor('#16a34a').fontSize(8).text(item.warranty || '1 Year', colX.warr, y + 6, { width: 65, lineBreak: false, ellipsis: true });
            doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text(`Rs.${Math.round(item.total||0).toLocaleString('en-IN')}`, colX.total, y + 6, { width: 60, lineBreak: false });
            doc.font('Helvetica');
            // Separator line
            doc.moveTo(40, y + rowHeight).lineTo(doc.page.width - 40, y + rowHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
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

        // ===== PAYMENT STATUS (paid + pending) =====
        const totalPaid = q.totalPaid || 0;
        const balanceDue = Math.max(0, Math.round(q.grandTotal) - totalPaid);
        if (totalPaid > 0 || q.status === 'Approved' || q.status === 'Converted') {
            // Amount Received (green)
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#16a34a');
            doc.text('Amount Received:', totalsX, y);
            doc.text(`Rs.${totalPaid.toLocaleString('en-IN')}`, totalsX + 100, y, { align: 'right', width: 75 });
            y += 18;
            // Balance Due (red box if pending)
            if (balanceDue > 0) {
                doc.rect(totalsX - 5, y, 185, 24).fill('#fef2f2').stroke('#fecaca');
                doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(11);
                doc.text('BALANCE DUE:', totalsX, y + 7);
                doc.text(`Rs.${balanceDue.toLocaleString('en-IN')}`, totalsX + 100, y + 7, { align: 'right', width: 75 });
                y += 30;
            } else {
                doc.rect(totalsX - 5, y, 185, 24).fill('#f0fdf4').stroke('#bbf7d0');
                doc.fillColor('#16a34a').font('Helvetica-Bold').fontSize(11);
                doc.text('FULLY PAID', totalsX, y + 7);
                doc.text('Rs.0', totalsX + 100, y + 7, { align: 'right', width: 75 });
                y += 30;
            }
            doc.fillColor('#000000');
        }

        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('Terms & Conditions:', 40, y, { lineBreak: false });
        y += 16;
        doc.font('Helvetica').fontSize(9);
        doc.text(`• Payment Terms: ${q.paymentTerms}`, 40, y, { lineBreak: false, width: 500, height: 11 }); y += 12;
        doc.text(`• Warranty: ${q.warranty}`, 40, y, { lineBreak: false, width: 500, height: 11 }); y += 12;
        doc.text(`• Validity: ${q.validityDays} days from quotation date`, 40, y, { lineBreak: false, height: 11 }); y += 12;
        doc.text(`• Installation charges are inclusive of basic setup. Civil work extra.`, 40, y, { lineBreak: false, height: 11 }); y += 12;
        doc.text(`• Prices are subject to change without prior notice.`, 40, y, { lineBreak: false, height: 11 }); y += 12;
        if (q.notes) {
            y += 6;
            doc.font('Helvetica-Bold').text('Notes:', 40, y, { lineBreak: false }); y += 14;
            // Cap notes height so it never overflows into a new page
            const maxNotesY = doc.page.height - 70;
            const notesHeight = Math.max(11, Math.min(60, maxNotesY - y));
            doc.font('Helvetica').fontSize(9).text(String(q.notes).slice(0, 400), 40, y, { width: doc.page.width - 80, height: notesHeight, ellipsis: true });
        }

        const footerY = doc.page.height - 55;
        doc.rect(0, footerY, doc.page.width, 55).fill('#0f172a');
        doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('Thank you for considering Searvator. We look forward to working with you.', 40, footerY + 12, { align: 'center', width: doc.page.width - 80 });
        doc.fillColor('#fcd34d').fontSize(8).font('Helvetica-Bold').text('SEARVATOR IT SOLUTIONS PVT. LTD.  |  CIN: U62011GJ2026PTC172346', 40, footerY + 28, { align: 'center', width: doc.page.width - 80 });
        doc.fillColor('#64748b').fontSize(7).font('Helvetica').text('+91 9106959092  |  info@searvator.com  |  Ahmedabad, Gujarat  |  System-generated quotation', 40, footerY + 42, { align: 'center', width: doc.page.width - 80 });

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
        // VALIDATION: customer name + mobile required
        const name = (data.customerName || data.name || '').trim();
        const mobile = (data.mobile || data.mobileNumber || '').trim();
        if (!name) {
            return res.status(400).json({ error: 'Customer name is required' });
        }
        // DUPLICATE CHECK: same mobile open lead in last 2 min
        if (mobile) {
            const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
            const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
            const dup = await Lead.findOne({
                $or: [{ mobile: mobRegex }, { mobileNumber: mobRegex }],
                createdAt: { $gte: twoMinAgo }
            }).lean();
            if (dup) {
                return res.status(409).json({ error: `Duplicate blocked: A lead for ${name} was just created (${dup.leadNumber}).` });
            }
        }
        data.leadNumber = await genSequentialNumber(Lead, 'SEA-L', 'leadNumber');
        
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

// Safe sequential number generator (race-condition resistant)
// Finds the highest existing number for a prefix and returns next
async function genSequentialNumber(Model, prefix, fieldName) {
    const field = fieldName || (Model.modelName === 'Booking' ? 'bookingNumber' : 'entryNumber');
    // Find the latest doc with this prefix
    const latest = await Model.findOne({ [field]: new RegExp('^' + prefix) })
        .sort({ createdAt: -1 }).select(field).lean();
    let maxNum = 0;
    if (latest && latest[field]) {
        const m = latest[field].match(/(\d+)$/);
        if (m) maxNum = parseInt(m[1], 10);
    }
    // Also check total count as fallback (in case of gaps)
    const count = await Model.countDocuments({ [field]: new RegExp('^' + prefix) });
    const next = Math.max(maxNum, count) + 1;
    return `${prefix}-${String(next).padStart(4, '0')}`;
}

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
    res.render('corporate-new', { user: req.session.user, agentName: req.session.user.username, editEntry: null });
});

// Edit existing corporate entry (blocked if locked)
app.get('/corporate/:id/edit', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id).lean();
        if (!entry) return res.status(404).send('Entry not found');
        if (entry.editLocked) {
            return res.redirect('/corporate/' + req.params.id + '?locked=1');
        }
        res.render('corporate-new', { 
            user: req.session.user, 
            agentName: entry.agentName || req.session.user.username,
            editEntry: entry
        });
    } catch (e) { res.status(500).send(e.message); }
});

// Agent view
app.get('/agent/corporate/new', requireAuth, (req, res) => {
    if (req.session.user.role !== 'agent') return res.redirect('/admin');
    res.render('corporate-new', { user: req.session.user, agentName: req.session.user.username, editEntry: null });
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
        const data = req.body;
        // VALIDATION: name + mobile required
        const name = (data.customerName || '').trim();
        const mobile = (data.mobileNumber || '').trim();
        if (!name || !mobile) {
            return res.status(400).json({ error: 'Customer name and mobile number are required' });
        }
        // DUPLICATE CHECK: same mobile + same grandTotal in last 2 min (double submit)
        const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
        const dup = await CorporateEntry.findOne({
            mobileNumber: mobRegex,
            createdAt: { $gte: twoMinAgo }
        }).lean();
        if (dup) {
            return res.status(409).json({ error: `Duplicate blocked: An entry for ${name} (${mobile}) was just created (${dup.entryNumber}).` });
        }
        
        data.entryNumber = await genSequentialNumber(CorporateEntry, 'SEA-CORP');
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
        
        // EDIT LOCK CHECK: if payment is done and entry is locked, block edit
        if (entry.editLocked) {
            return res.status(403).json({ 
                error: 'This entry is locked because payment is complete. Ask an admin to generate an edit-unlock token, then verify it to enable editing.',
                locked: true
            });
        }
        
        const editLogs = [];
        const wasPaid = entry.paymentStatus === 'Paid';
        
        // Track changes for simple top-level fields
        const trackedFields = ['customerName', 'companyName', 'mobileNumber', 'location', 'visitDate', 'visitTime', 'serviceType', 'overallRemarks', 'amountReceived', 'discount', 'discountReason', 'paymentMode', 'gstPercent'];
        const changedFields = [];
        trackedFields.forEach(f => {
            if (updates[f] !== undefined && String(entry[f] || '') !== String(updates[f] || '')) {
                editLogs.push({
                    editedBy: editor, field: f,
                    oldValue: entry[f], newValue: updates[f]
                });
                changedFields.push(f);
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
            changedFields.push('PC services');
            updates.pcs.forEach(p => { p.overallStatus = computePcStatus(p); });
            entry.pcs = updates.pcs;
        }
        
        editLogs.forEach(log => entry.editLogs.push(log));
        entry.lastModifiedBy = editor;
        
        // If this was a post-payment edit (unlocked via token), record it prominently
        if (entry.editUnlockedAt && entry.editUnlockTokenUsed && changedFields.length > 0) {
            entry.postPaymentEdits.push({
                editedBy: editor,
                editedAt: new Date(),
                summary: 'Edited after payment: ' + changedFields.join(', '),
                authorizedBy: entry.editUnlockedBy
            });
            // Re-lock after the edit is saved (single-use unlock)
            entry.editLocked = true;
        }
        
        computeCorporateTotals(entry);
        
        // If still fully paid after edit, keep locked
        if (entry.paymentStatus === 'Paid') {
            entry.editLocked = true;
        }
        
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
        
        // Lock editing once fully paid
        if (entry.paymentStatus === 'Paid') {
            entry.editLocked = true;
        }
        
        await entry.save();
        res.json({ success: true, entry });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ADMIN: Generate edit-unlock token (to allow editing a paid/locked entry)
app.post('/api/corporate/:id/generate-edit-token', requireAuth, requireAdmin, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        const token = Math.floor(1000 + Math.random() * 9000).toString();
        entry.editUnlockToken = token;
        entry.editUnlockTokenUsed = false;
        await entry.save();
        res.json({ success: true, token, entryNumber: entry.entryNumber, generatedBy: req.session.user.username });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Verify edit-unlock token (anyone with the token from admin can unlock for editing)
app.post('/api/corporate/:id/verify-edit-token', requireAuth, async (req, res) => {
    try {
        const entry = await CorporateEntry.findById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        const { token } = req.body;
        
        if (entry.editUnlockToken && entry.editUnlockToken === String(token).trim() && !entry.editUnlockTokenUsed) {
            entry.editLocked = false; // unlock for editing
            entry.editUnlockedAt = new Date();
            entry.editUnlockedBy = req.session.user.username;
            // token is single-use - mark used so it can't be reused
            entry.editUnlockTokenUsed = true;
            await entry.save();
            res.json({ success: true, verified: true });
        } else {
            res.json({ success: true, verified: false, error: 'Invalid or already-used token' });
        }
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
    
    // ============ SUMMARY TABLE (all PCs at a glance) ============
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('Summary - All Systems', 40, y, { lineBreak: false });
    y += 20;
    
    // Table header
    const tcol = { sno: 40, name: 75, type: 200, status: 290, issues: 380 };
    doc.rect(40, y, 515, 22).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
    doc.text('#', tcol.sno + 5, y + 7, { lineBreak: false });
    doc.text('PC Name', tcol.name, y + 7, { lineBreak: false });
    doc.text('Type', tcol.type, y + 7, { lineBreak: false });
    doc.text('Status', tcol.status, y + 7, { lineBreak: false });
    doc.text('Issues / Action Needed', tcol.issues, y + 7, { lineBreak: false });
    y += 22;
    
    // Count summary
    let goodCount = 0, attentionCount = 0, criticalCount = 0;
    
    entry.pcs.forEach((pc, idx) => {
        // Row background (alternating + new page check)
        if (y + 18 > doc.page.height - 160) {
            doc.addPage();
            drawPdfHeader(doc, 'DIAGNOSTIC REPORT', entry.entryNumber + ' (cont.)');
            y = 155;
            // re-draw table header
            doc.rect(40, y, 515, 22).fill('#0f172a');
            doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
            doc.text('#', tcol.sno + 5, y + 7, { lineBreak: false });
            doc.text('PC Name', tcol.name, y + 7, { lineBreak: false });
            doc.text('Type', tcol.type, y + 7, { lineBreak: false });
            doc.text('Status', tcol.status, y + 7, { lineBreak: false });
            doc.text('Issues / Action Needed', tcol.issues, y + 7, { lineBreak: false });
            y += 22;
        }
        
        if (idx % 2 === 0) doc.rect(40, y, 515, 18).fill('#f8fafc');
        
        // Build issues string
        const labels = { motherboard:'Motherboard', cpu:'CPU', ramStatus:'RAM', ramSlots:'RAM Slots', hddHealth:'Storage', drive:'Optical Drive', fan:'Fan', temperature:'Temp', battery:'Battery', monitor:'Monitor', webcam:'Webcam', connectors:'Connectors' };
        const repairItems = [], missingItems = [];
        Object.keys(labels).forEach(f => {
            const v = pc[f];
            if (v === 'Issue/Repair' || v === 'Overheating') repairItems.push(labels[f]);
            else if (v === 'Missing') missingItems.push(labels[f]);
        });
        
        let issuesText = '';
        if (repairItems.length === 0 && missingItems.length === 0) {
            issuesText = 'All OK - No action needed';
        } else {
            const parts = [];
            if (repairItems.length) parts.push('Repair: ' + repairItems.join(', '));
            if (missingItems.length) parts.push('Missing: ' + missingItems.join(', '));
            issuesText = parts.join(' | ');
        }
        
        const status = pc.overallStatus || 'Good';
        if (status === 'Good') goodCount++;
        else if (status === 'Needs Attention') attentionCount++;
        else criticalCount++;
        
        const sCol = status === 'Good' ? '#15803d' : status === 'Needs Attention' ? '#b45309' : '#b91c1c';
        
        doc.fillColor('#0f172a').fontSize(8).font('Helvetica');
        doc.text(String(idx + 1), tcol.sno + 5, y + 5, { lineBreak: false });
        doc.font('Helvetica-Bold').text((pc.pcName || pc.pcSrNo || `PC-${idx+1}`).slice(0, 22), tcol.name, y + 5, { width: 120, lineBreak: false, ellipsis: true });
        doc.font('Helvetica').fillColor('#64748b').text((pc.pcType || 'Desktop').slice(0, 14), tcol.type, y + 5, { width: 85, lineBreak: false });
        doc.fillColor(sCol).font('Helvetica-Bold').text(status, tcol.status, y + 5, { width: 85, lineBreak: false });
        doc.fillColor(issuesText.startsWith('All OK') ? '#15803d' : '#b91c1c').font('Helvetica').fontSize(7).text(issuesText.slice(0, 90), tcol.issues, y + 5, { width: 170, lineBreak: false, ellipsis: true });
        
        y += 18;
    });
    
    // Summary count row
    doc.rect(40, y, 515, 22).fill('#1e293b');
    doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
    doc.text(`Total: ${entry.pcs.length} PCs`, 50, y + 7, { lineBreak: false });
    doc.fillColor('#86efac').text(`Good: ${goodCount}`, 200, y + 7, { lineBreak: false });
    doc.fillColor('#fcd34d').text(`Needs Attention: ${attentionCount}`, 290, y + 7, { lineBreak: false });
    doc.fillColor('#fca5a5').text(`Critical: ${criticalCount}`, 440, y + 7, { lineBreak: false });
    y += 32;
    
    // ============ DETAILED PC CARDS ============
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('Detailed System Reports', 40, y, { lineBreak: false });
    y += 24;
    
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
        const data = req.body;
        // VALIDATION: customer name required
        const name = (data.customerName || '').trim();
        if (!name) {
            return res.status(400).json({ error: 'Customer name is required' });
        }
        // DUPLICATE CHECK: same customer + mobile in last 2 min
        const mobile = (data.mobileNumber || data.customerMobile || '').trim();
        if (mobile) {
            const mobRegex = new RegExp(mobile.replace(/\D/g, '').slice(-10) + '$');
            const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
            const dup = await Booking.findOne({
                $or: [{ mobileNumber: mobRegex }, { customerMobile: mobRegex }],
                createdAt: { $gte: twoMinAgo }
            }).lean();
            if (dup) {
                return res.status(409).json({ error: `Duplicate blocked: A booking for ${name} was just created (${dup.bookingNumber}).` });
            }
        }
        
        data.bookingNumber = await genSequentialNumber(Booking, 'SEA-BK');
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

// ============================================================
//   UNIFIED OPERATIONS DASHBOARD - all departments in one view
// ============================================================
app.get('/operations', requireAuth, requireAdmin, async (req, res) => {
    res.render('operations-dashboard', { user: req.session.user });
});

// API: fetch all operations data (filtered)
app.get('/api/operations', requireAuth, requireAdmin, async (req, res) => {
    try {
        const dept = req.query.dept || 'all'; // all, hardware, corporate, booking, cctv, quotation, amc, lead, other
        const status = req.query.status || ''; // filter by status
        const search = (req.query.search || '').trim();
        const fromDate = req.query.from ? new Date(req.query.from) : null;
        const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59') : null;
        
        // Date filter helper
        const dateFilter = {};
        if (fromDate || toDate) {
            dateFilter.createdAt = {};
            if (fromDate) dateFilter.createdAt.$gte = fromDate;
            if (toDate) dateFilter.createdAt.$lte = toDate;
        }
        
        // Search filter helper (by name/mobile)
        const searchRegex = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
        
        let items = [];
        
        // Helper to add items from a module
        const want = (d) => dept === 'all' || dept === d;
        
        // === HARDWARE ENTRIES ===
        if (want('hardware')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ customerName: searchRegex }, { mobileNumber: searchRegex }];
            const entries = await Entry.find(q).select('-beforePhoto -afterPhoto').sort({ createdAt: -1 }).limit(200).lean();
            entries.forEach(e => items.push({
                dept: 'Hardware', icon: '🔧', id: e._id,
                ref: e.entryNumber || ('HW-' + String(e._id).slice(-5)),
                customer: e.customerName, mobile: e.mobileNumber, company: '',
                title: e.workType || e.deviceType || 'Hardware Service',
                amount: e.revenue || 0, received: e.amountReceived || 0, due: e.amountDue || 0,
                status: e.jobStatus || 'Pending', paymentStatus: e.paymentStatus || 'Pending',
                date: e.createdAt, link: '/admin', remark: e.remarks || '',
                hasInvoice: true, invoiceLink: ''
            }));
        }
        
        // === CORPORATE OFFICE ===
        if (want('corporate')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ customerName: searchRegex }, { companyName: searchRegex }, { mobileNumber: searchRegex }];
            const entries = await CorporateEntry.find(q).select('-pcs.beforePhoto -pcs.afterPhoto').sort({ createdAt: -1 }).limit(200).lean();
            entries.forEach(e => items.push({
                dept: 'Corporate', icon: '🏢', id: e._id,
                ref: e.entryNumber,
                customer: e.customerName, mobile: e.mobileNumber, company: e.companyName,
                title: e.serviceType + ' (' + (e.pcs ? e.pcs.length : 0) + ' PCs)',
                amount: e.grandTotal || 0, received: e.amountReceived || 0, due: e.amountDue || 0,
                status: e.jobStatus || 'Completed', paymentStatus: e.paymentStatus || 'Pending',
                date: e.visitDate || e.createdAt, link: '/corporate/' + e._id, remark: e.overallRemarks || '',
                hasInvoice: true, invoiceLink: '/corporate/' + e._id + '/pdf?type=invoice'
            }));
        }
        
        // === BOOKINGS ===
        if (want('booking')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ customerName: searchRegex }, { mobileNumber: searchRegex }, { companyName: searchRegex }];
            const bookings = await Booking.find(q).sort({ scheduledDate: -1 }).limit(200).lean();
            bookings.forEach(b => items.push({
                dept: 'Booking', icon: '📅', id: b._id,
                ref: 'BK-' + String(b._id).slice(-5),
                customer: b.customerName, mobile: b.mobileNumber, company: b.companyName || '',
                title: b.serviceType || 'Booking',
                amount: 0, received: 0, due: 0,
                status: b.status || 'Pending', paymentStatus: '-',
                date: b.scheduledDate || b.createdAt, link: '/bookings', remark: b.description || '',
                hasInvoice: false, invoiceLink: '', assignedAgent: b.assignedAgent || ''
            }));
        }
        
        // === CCTV / QUOTATIONS ===
        if (want('quotation') || want('cctv')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ clientName: searchRegex }, { clientMobile: searchRegex }, { clientCompany: searchRegex }];
            const quotes = await Quotation.find(q).select('-items').sort({ createdAt: -1 }).limit(200).lean();
            quotes.forEach(qt => {
                const totalPaid = qt.totalPaid || ((qt.advanceReceived || 0) + (qt.finalPaymentReceived || 0));
                items.push({
                    dept: 'Quotation', icon: '📋', id: qt._id,
                    ref: qt.quotationNumber,
                    customer: qt.clientName, mobile: qt.clientMobile, company: qt.clientCompany || '',
                    title: qt.projectType,
                    amount: qt.grandTotal || 0, received: totalPaid, due: Math.max(0, (qt.grandTotal || 0) - totalPaid),
                    status: qt.status || 'Draft', paymentStatus: qt.paymentStatus || 'Pending',
                    date: qt.createdAt, link: '/cctv/quotation/' + qt._id, remark: qt.remark || '',
                    hasInvoice: true, invoiceLink: '/api/quotations/' + qt._id + '/pdf',
                    vendorCost: qt.totalVendorCost || 0, grossProfit: qt.grossProfit || 0,
                    vendorPaid: qt.totalVendorPaid || 0, vendorDue: Math.max(0, (qt.totalVendorCost || 0) - (qt.totalVendorPaid || 0)),
                    isQuotation: true
                });
            });
        }
        
        // === AMC ===
        if (want('amc')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ officeName: searchRegex }, { contactMobile: searchRegex }];
            const amcs = await AMCOffice.find(q).select('-pcs.beforePhoto -pcs.afterPhoto').sort({ createdAt: -1 }).limit(200).lean();
            amcs.forEach(a => items.push({
                dept: 'AMC', icon: '📝', id: a._id,
                ref: 'AMC-' + String(a._id).slice(-5),
                customer: a.contactPerson || a.officeName, mobile: a.contactMobile, company: a.officeName,
                title: 'AMC Contract',
                amount: a.contractValue || 0, received: 0, due: 0,
                status: a.status || 'Active', paymentStatus: '-',
                date: a.createdAt, link: '/amc', remark: a.notes || '',
                hasInvoice: false, invoiceLink: ''
            }));
        }
        
        // === LEADS ===
        if (want('lead')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ name: searchRegex }, { mobile: searchRegex }, { companyName: searchRegex }];
            const leads = await Lead.find(q).sort({ createdAt: -1 }).limit(200).lean();
            leads.forEach(l => items.push({
                dept: 'Lead', icon: '🎯', id: l._id,
                ref: 'LEAD-' + String(l._id).slice(-5),
                customer: l.name, mobile: l.mobile, company: l.companyName || '',
                title: l.requirement || l.title || 'Enquiry',
                amount: l.estimatedValue || l.wonAmount || 0, received: l.finalAmountReceived || 0, due: 0,
                status: l.status || 'New', paymentStatus: '-',
                date: l.createdAt, link: '/leads/' + l._id, remark: l.notes || '',
                hasInvoice: false, invoiceLink: '', assignedAgent: l.assignedTo || ''
            }));
        }
        
        // === OTHER BUSINESS ===
        if (want('other')) {
            const q = { ...dateFilter };
            if (searchRegex) q.$or = [{ businessName: searchRegex }, { clientName: searchRegex }];
            const others = await OtherBusiness.find(q).sort({ createdAt: -1 }).limit(200).lean();
            others.forEach(o => items.push({
                dept: 'Other', icon: '💼', id: o._id,
                ref: 'OB-' + String(o._id).slice(-5),
                customer: o.clientName || o.businessName, mobile: o.mobile || '', company: o.businessName || '',
                title: o.category || 'Other Business',
                amount: o.amount || 0, received: o.amount || 0, due: 0,
                status: o.status || 'Completed', paymentStatus: '-',
                date: o.date || o.createdAt, link: '/other-business', remark: o.notes || o.description || '',
                hasInvoice: false, invoiceLink: ''
            }));
        }
        
        // Status filter (applied after collection)
        if (status) {
            items = items.filter(i => i.status === status);
        }
        
        // Sort: latest first
        items.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Aggregate stats
        const stats = {
            total: items.length,
            totalValue: items.reduce((s, i) => s + (i.amount || 0), 0),
            totalReceived: items.reduce((s, i) => s + (i.received || 0), 0),
            totalDue: items.reduce((s, i) => s + (i.due || 0), 0),
            totalVendorDue: items.reduce((s, i) => s + (i.vendorDue || 0), 0),
            pending: items.filter(i => ['Pending','New','Draft','Scheduled','Sent'].includes(i.status)).length,
            confirmed: items.filter(i => ['Confirmed','Approved','Won','Completed','Paid','Delivered','Converted'].includes(i.status)).length,
            notConfirmed: items.filter(i => ['Rejected','Lost','Cancelled','Missed'].includes(i.status)).length
        };
        
        // Department-wise counts
        const deptCounts = {};
        items.forEach(i => { deptCounts[i.dept] = (deptCounts[i.dept] || 0) + 1; });
        
        // === CUSTOMER GROUPING ===
        // If groupBy=customer, collapse multiple entries of same customer into one group
        if (req.query.groupBy === 'customer') {
            const groups = {};
            items.forEach(i => {
                const key = (i.mobile || '').replace(/\D/g, '').slice(-10) || i.customer || 'unknown';
                if (!groups[key]) {
                    groups[key] = {
                        customer: i.customer, mobile: i.mobile, company: i.company,
                        items: [], totalValue: 0, totalReceived: 0, totalDue: 0,
                        deptSet: new Set(), latestDate: i.date
                    };
                }
                const g = groups[key];
                g.items.push(i);
                g.totalValue += i.amount || 0;
                g.totalReceived += i.received || 0;
                g.totalDue += i.due || 0;
                g.deptSet.add(i.dept);
                if (new Date(i.date) > new Date(g.latestDate)) g.latestDate = i.date;
                // Prefer a company name if available
                if (!g.company && i.company) g.company = i.company;
            });
            
            const grouped = Object.values(groups).map(g => ({
                ...g,
                depts: Array.from(g.deptSet),
                count: g.items.length
            })).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate));
            
            return res.json({ success: true, grouped, stats, deptCounts, isGrouped: true });
        }
        
        res.json({ success: true, items: items.slice(0, 300), stats, deptCounts, isGrouped: false });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// API: update status/remark of any item from the dashboard (loop-back update)
app.post('/api/operations/update', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { dept, id, status, remark, paymentStatus } = req.body;
        let result = null;
        
        const modelMap = {
            'Hardware': Entry, 'Corporate': CorporateEntry, 'Booking': Booking,
            'Quotation': Quotation, 'AMC': AMCOffice, 'Lead': Lead, 'Other': OtherBusiness
        };
        const Model = modelMap[dept];
        if (!Model) return res.status(400).json({ error: 'Unknown department' });
        
        const doc = await Model.findById(id);
        if (!doc) return res.status(404).json({ error: 'Not found' });
        
        // Update status field (different field names per model)
        if (status !== undefined && status !== '') {
            if (dept === 'Hardware' || dept === 'Corporate') doc.jobStatus = status;
            else doc.status = status;
        }
        if (remark !== undefined) {
            // Map to the right remark field
            if (dept === 'Corporate') doc.overallRemarks = remark;
            else if (dept === 'Quotation') doc.remark = remark;
            else if (dept === 'Lead' || dept === 'Hardware') doc.notes = remark;
            else if (doc.notes !== undefined) doc.notes = remark;
            else if (doc.description !== undefined) doc.description = remark;
        }
        if (paymentStatus !== undefined && paymentStatus !== '' && doc.paymentStatus !== undefined) {
            doc.paymentStatus = paymentStatus;
        }
        
        await doc.save();
        result = { id: doc._id, status, remark };
        
        res.json({ success: true, result });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});

// API: record a payment against any item from the operations hub
app.post('/api/operations/payment', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { dept, id, amount, mode, date, note } = req.body;
        const amt = Number(amount) || 0;
        if (amt <= 0) return res.status(400).json({ error: 'Enter valid amount' });
        
        if (dept === 'Quotation') {
            const q = await Quotation.findById(id);
            if (!q) return res.status(404).json({ error: 'Not found' });
            const paid = q.payments.reduce((s, p) => s + (p.amount || 0), 0);
            const due = Math.max(0, (q.grandTotal || 0) - paid);
            if (amt > due) return res.status(400).json({ error: `Payment cannot exceed due of Rs.${due.toLocaleString('en-IN')}` });
            q.payments.push({ amount: amt, date: date ? new Date(date) : new Date(), mode: mode || 'Cash', note: note || '', type: 'Payment', recordedBy: req.session.user.username });
            q.totalPaid = q.payments.reduce((s, p) => s + p.amount, 0);
            q.balanceDue = Math.max(0, (q.grandTotal || 0) - q.totalPaid);
            q.paymentStatus = q.totalPaid >= q.grandTotal ? 'Fully Paid' : q.totalPaid > 0 ? 'Advance Paid' : 'Pending';
            await q.save();
            return res.json({ success: true, totalPaid: q.totalPaid, balanceDue: q.balanceDue });
        }
        
        if (dept === 'Corporate') {
            const c = await CorporateEntry.findById(id);
            if (!c) return res.status(404).json({ error: 'Not found' });
            const due = Math.max(0, (c.grandTotal || 0) - (c.amountReceived || 0));
            if (amt > due) return res.status(400).json({ error: `Payment cannot exceed due of Rs.${due.toLocaleString('en-IN')}` });
            c.amountReceived = (c.amountReceived || 0) + amt;
            c.amountDue = Math.max(0, (c.grandTotal || 0) - c.amountReceived);
            c.paymentStatus = c.amountReceived >= c.grandTotal ? 'Paid' : c.amountReceived > 0 ? 'Partial' : 'Pending';
            if (!c.paymentMode) c.paymentMode = mode || 'Cash';
            c.editLogs = c.editLogs || [];
            c.editLogs.push({ editedBy: req.session.user.username, field: 'payment', oldValue: '', newValue: `+${amt} via ${mode}`, note: note || 'Payment via Ops Hub' });
            if (c.paymentStatus === 'Paid') c.editLocked = true;
            await c.save();
            return res.json({ success: true, totalPaid: c.amountReceived, balanceDue: c.amountDue });
        }
        
        if (dept === 'Hardware') {
            const e = await Entry.findById(id);
            if (!e) return res.status(404).json({ error: 'Not found' });
            const due = Math.max(0, (e.revenue || 0) - (e.amountReceived || 0));
            if (amt > due) return res.status(400).json({ error: `Payment cannot exceed due of Rs.${due.toLocaleString('en-IN')}` });
            e.amountReceived = (e.amountReceived || 0) + amt;
            e.amountDue = Math.max(0, (e.revenue || 0) - e.amountReceived);
            e.paymentStatus = e.amountReceived >= (e.revenue || 0) ? 'Paid' : e.amountReceived > 0 ? 'Partial' : 'Pending';
            await e.save();
            return res.json({ success: true, totalPaid: e.amountReceived, balanceDue: e.amountDue });
        }
        
        return res.status(400).json({ error: 'Payment not supported for ' + dept });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});

// ===== EXECUTIVE PROFITABILITY DASHBOARD (Phase 3) =====
app.get('/executive-dashboard', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Time filter
        const period = req.query.period || 'all';
        const now = new Date();
        let fromDate = null;
        if (period === 'month') { fromDate = new Date(now.getFullYear(), now.getMonth(), 1); }
        else if (period === 'quarter') { fromDate = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); }
        else if (period === 'year') { fromDate = new Date(now.getFullYear(), 0, 1); }
        
        const matchQuery = { status: { $in: ['Approved', 'Converted'] } };
        if (fromDate) matchQuery.createdAt = { $gte: fromDate };
        
        const quotes = await Quotation.find(matchQuery)
            .select('quotationNumber clientName grandTotal totalPaid totalVendorCost orderCategory leadPartner assignedEngineer leadCommissionAmount engineerCommissionAmount conveyanceAllowance netProfit payoutStatus createdAt')
            .lean();
        
        // ===== OVERALL TOTALS =====
        let totalSales = 0, totalCollected = 0, totalVendorCost = 0, totalConveyance = 0;
        let totalLeadComm = 0, totalEngComm = 0, totalNetProfit = 0;
        
        // ===== CATEGORY-WISE =====
        const categories = {}; // cat -> { sales, vendorCost, netProfit, count, collected }
        function ensureCat(c) {
            if (!categories[c]) categories[c] = { name: c, sales: 0, vendorCost: 0, netProfit: 0, count: 0, collected: 0 };
            return categories[c];
        }
        
        // ===== TOP EARNERS =====
        const engineers = {}; // name -> earned commission
        const leadPartners = {};
        
        quotes.forEach(q => {
            const sales = q.grandTotal || 0;
            const vendorCost = q.totalVendorCost || 0;
            const conveyance = q.conveyanceAllowance || 0;
            const leadComm = q.leadCommissionAmount || 0;
            const engComm = q.engineerCommissionAmount || 0;
            const netProfit = q.netProfit !== undefined ? q.netProfit : (sales - vendorCost - conveyance - leadComm - engComm);
            
            totalSales += sales;
            totalCollected += (q.totalPaid || 0);
            totalVendorCost += vendorCost;
            totalConveyance += conveyance;
            totalLeadComm += leadComm;
            totalEngComm += engComm;
            totalNetProfit += netProfit;
            
            // Category
            const cat = q.orderCategory || 'CCTV';
            const c = ensureCat(cat);
            c.sales += sales; c.vendorCost += vendorCost; c.netProfit += netProfit; c.count += 1; c.collected += (q.totalPaid || 0);
            
            // Top earners (only count commission where payment is done or partially)
            if (q.assignedEngineer && engComm > 0) {
                engineers[q.assignedEngineer] = (engineers[q.assignedEngineer] || 0) + engComm;
            }
            if (q.leadPartner && leadComm > 0) {
                leadPartners[q.leadPartner] = (leadPartners[q.leadPartner] || 0) + leadComm;
            }
        });
        
        const categoryList = Object.values(categories).sort((a, b) => b.netProfit - a.netProfit);
        const topEngineers = Object.entries(engineers).map(([name, amt]) => ({ name, amount: amt })).sort((a, b) => b.amount - a.amount).slice(0, 5);
        const topLeadPartners = Object.entries(leadPartners).map(([name, amt]) => ({ name, amount: amt })).sort((a, b) => b.amount - a.amount).slice(0, 5);
        
        const profitMargin = totalSales > 0 ? ((totalNetProfit / totalSales) * 100).toFixed(1) : 0;
        const collectionRate = totalSales > 0 ? ((totalCollected / totalSales) * 100).toFixed(1) : 0;
        
        res.render('executive-dashboard', {
            user: req.session.user,
            period,
            totals: {
                totalSales, totalCollected, totalVendorCost, totalConveyance,
                totalLeadComm, totalEngComm, totalNetProfit, totalCommission: totalLeadComm + totalEngComm,
                profitMargin, collectionRate, orderCount: quotes.length
            },
            categoryList,
            topEngineers,
            topLeadPartners
        });
    } catch (e) { console.error(e); res.status(500).send(e.message); }
});

// ===== COMMISSION LEDGER (Phase 2) =====
// Derives per-person commission wallet from quotations (single source of truth, no duplicates)
app.get('/commission-ledger', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Only quotations that have commissions assigned
        const quotes = await Quotation.find({
            $or: [
                { leadPartner: { $nin: ['', null] } },
                { assignedEngineer: { $nin: ['', null] } }
            ]
        }).select('quotationNumber clientName grandTotal totalPaid totalVendorCost leadPartner assignedEngineer leadCommissionAmount engineerCommissionAmount payoutStatus orderCategory createdAt commissionBase leadCommissionPct engineerCommissionPct').sort({ createdAt: -1 }).lean();
        
        // Build per-person wallet
        const people = {}; // name -> { name, roles:Set, pending, earned, paid, orders:[] }
        
        function ensure(name) {
            if (!people[name]) people[name] = { name, roles: new Set(), pending: 0, earned: 0, paid: 0, totalCommission: 0, orders: [] };
            return people[name];
        }
        
        quotes.forEach(q => {
            const fullyPaid = (q.totalPaid || 0) >= (q.grandTotal || 0) && (q.grandTotal || 0) > 0;
            const isPaidOut = q.payoutStatus === 'Paid';
            
            // Lead partner commission
            if (q.leadPartner && (q.leadCommissionAmount || 0) > 0) {
                const p = ensure(q.leadPartner);
                p.roles.add('Lead');
                const amt = q.leadCommissionAmount;
                p.totalCommission += amt;
                let state;
                if (isPaidOut) { p.paid += amt; state = 'Paid'; }
                else if (fullyPaid) { p.earned += amt; state = 'Earned'; }
                else { p.pending += amt; state = 'Pending'; }
                p.orders.push({ id: q._id, num: q.quotationNumber, client: q.clientName, role: 'Lead', category: q.orderCategory, amount: amt, state, date: q.createdAt, orderValue: q.grandTotal });
            }
            
            // Engineer commission
            if (q.assignedEngineer && (q.engineerCommissionAmount || 0) > 0) {
                const p = ensure(q.assignedEngineer);
                p.roles.add('Engineer');
                const amt = q.engineerCommissionAmount;
                p.totalCommission += amt;
                let state;
                if (isPaidOut) { p.paid += amt; state = 'Paid'; }
                else if (fullyPaid) { p.earned += amt; state = 'Earned'; }
                else { p.pending += amt; state = 'Pending'; }
                p.orders.push({ id: q._id, num: q.quotationNumber, client: q.clientName, role: 'Engineer', category: q.orderCategory, amount: amt, state, date: q.createdAt, orderValue: q.grandTotal });
            }
        });
        
        // Convert to array + finalize
        const ledger = Object.values(people).map(p => ({
            ...p,
            roles: Array.from(p.roles).join(' + '),
            balanceOwed: p.earned // earned but not yet paid out
        })).sort((a, b) => (b.pending + b.earned + b.paid) - (a.pending + a.earned + a.paid));
        
        // Grand totals
        const totals = {
            people: ledger.length,
            totalPending: ledger.reduce((s, p) => s + p.pending, 0),
            totalEarned: ledger.reduce((s, p) => s + p.earned, 0),
            totalPaid: ledger.reduce((s, p) => s + p.paid, 0),
            totalCommission: ledger.reduce((s, p) => s + p.totalCommission, 0)
        };
        
        res.render('commission-ledger', { user: req.session.user, ledger, totals });
    } catch (e) { console.error(e); res.status(500).send(e.message); }
});

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
//   CUSTOMER 360 - Unified view linking ALL modules by mobile
// ============================================================
app.get('/customers/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const customer = await Customer.findById(req.params.id).lean();
        if (!customer) return res.status(404).send('Customer not found');
        
        // Normalize mobile (last 10 digits) for cross-module matching
        const mob = (customer.mobile || '').replace(/\D/g, '').slice(-10);
        const mobRegex = new RegExp(mob + '$');
        
        // Pull EVERYTHING linked to this customer across all modules (by mobile)
        const [bookings, leads, quotations, corporateEntries, hardwareEntries, amcOffices] = await Promise.all([
            Booking.find({ mobileNumber: mobRegex }).sort({ scheduledDate: -1 }).limit(50).lean(),
            Lead.find({ mobile: mobRegex }).sort({ createdAt: -1 }).limit(50).lean(),
            Quotation.find({ clientMobile: mobRegex }).select('-items').sort({ createdAt: -1 }).limit(50).lean(),
            CorporateEntry.find({ mobileNumber: mobRegex }).select('-pcs.beforePhoto -pcs.afterPhoto').sort({ createdAt: -1 }).limit(50).lean(),
            Entry.find({ mobileNumber: mobRegex }).select('-beforePhoto -afterPhoto').sort({ createdAt: -1 }).limit(50).lean(),
            AMCOffice.find({ contactMobile: mobRegex }).select('-pcs.beforePhoto -pcs.afterPhoto').sort({ createdAt: -1 }).limit(50).lean()
        ]);
        
        // Build unified timeline (all events sorted by date)
        const timeline = [];
        bookings.forEach(b => timeline.push({ type: 'Booking', date: b.scheduledDate || b.createdAt, status: b.status, title: b.serviceType || 'Booking', amount: 0, link: '/bookings', id: b._id, icon: '📅' }));
        leads.forEach(l => timeline.push({ type: 'Lead', date: l.createdAt, status: l.status, title: l.title || l.requirement || 'Lead', amount: l.wonAmount || 0, link: '/leads/' + l._id, id: l._id, icon: '🎯' }));
        quotations.forEach(q => timeline.push({ type: 'Quotation', date: q.createdAt, status: q.status, title: q.projectType + ' (' + q.quotationNumber + ')', amount: q.grandTotal || 0, link: '/cctv/quotation/' + q._id + '/edit', id: q._id, icon: '📋' }));
        corporateEntries.forEach(c => timeline.push({ type: 'Corporate Service', date: c.visitDate || c.createdAt, status: c.paymentStatus, title: c.serviceType + ' (' + (c.pcs ? c.pcs.length : 0) + ' PCs)', amount: c.grandTotal || 0, link: '/corporate/' + c._id, id: c._id, icon: '🏢' }));
        hardwareEntries.forEach(e => timeline.push({ type: 'Hardware Service', date: e.createdAt, status: e.jobStatus, title: e.workType || 'Repair', amount: e.totalAmount || 0, link: '/admin', id: e._id, icon: '🔧' }));
        amcOffices.forEach(a => timeline.push({ type: 'AMC', date: a.createdAt, status: a.status || 'Active', title: a.officeName || 'AMC Contract', amount: a.contractValue || 0, link: '/amc', id: a._id, icon: '📝' }));
        
        timeline.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Aggregate stats
        const stats = {
            totalBookings: bookings.length,
            totalLeads: leads.length,
            totalQuotations: quotations.length,
            approvedQuotations: quotations.filter(q => q.status === 'Approved').length,
            totalServices: corporateEntries.length + hardwareEntries.length,
            totalAMC: amcOffices.length,
            lifetimeRevenue: corporateEntries.reduce((s, c) => s + (c.amountReceived || 0), 0) + 
                             leads.filter(l => l.status === 'Won').reduce((s, l) => s + (l.finalAmountReceived || 0), 0),
            pendingDue: corporateEntries.reduce((s, c) => s + (c.amountDue || 0), 0),
            quotationValue: quotations.filter(q => q.status === 'Approved').reduce((s, q) => s + (q.grandTotal || 0), 0)
        };
        
        res.render('customer-detail', {
            user: req.session.user,
            customer, timeline, stats,
            bookings, leads, quotations, corporateEntries, hardwareEntries, amcOffices
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading customer: ' + e.message);
    }
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
