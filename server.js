require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const exceljs = require('exceljs');
const PDFDocument = require('pdfkit');

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

const app = express();

app.set('view engine', 'ejs');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));
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

    res.render('agent', {
        agentName: req.session.user.username,
        entries,
        pendingJobs,
        orders,
        selectedDate: req.query.date || ''
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
    
    // Dark gradient-like header background (3 shades layered)
    doc.rect(0, 0, W, 130).fill('#0f172a');
    doc.rect(0, 0, W, 80).fill('#1e293b');
    doc.rect(0, 0, W, 40).fill('#334155');
    
    // Accent line at bottom of header
    doc.rect(0, 130, W, 4).fill('#3b82f6');
    
    // Logo circle (left)
    doc.circle(75, 65, 28).fillAndStroke('#3b82f6', '#60a5fa');
    doc.fillColor('#ffffff').fontSize(32).font('Helvetica-Bold').text('S', 65, 48);
    
    // Company name & tagline
    doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold').text('SEARVATOR', 115, 45);
    doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text('IT SOLUTIONS PVT. LTD.', 115, 73);
    doc.fillColor('#cbd5e1').fontSize(8).text('CCTV • Biometric • AI Software • Hardware • Operations', 115, 87);
    
    // Document type & number (right)
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold').text(docType, 0, 50, { align: 'right', width: W - 40 });
    if (docNumber) {
        doc.fillColor('#60a5fa').fontSize(10).font('Helvetica').text('# ' + docNumber, 0, 78, { align: 'right', width: W - 40 });
    }
    doc.fillColor('#94a3b8').fontSize(8).text('www.searvator.com', 0, 95, { align: 'right', width: W - 40 });
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

    const entries = await Entry.find(query).sort({ createdAt: -1 });
    const allEntries = await Entry.find();
    const allOrders = await Order.find().sort({ createdAt: -1 });

    let targets = await Target.findOne();
    if (!targets) targets = { dailyTarget: 10000, weeklyTarget: 70000, monthlyTarget: 300000 };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const todayRevenue = allEntries.filter(e => e.createdAt >= startOfToday && e.jobStatus === 'Completed').reduce((s, e) => s + e.revenue, 0)
        + allOrders.filter(o => o.createdAt >= startOfToday && o.status === 'Completed').reduce((s, o) => s + o.sellingPrice, 0);
    const weekRevenue = allEntries.filter(e => e.createdAt >= startOfWeek && e.jobStatus === 'Completed').reduce((s, e) => s + e.revenue, 0)
        + allOrders.filter(o => o.createdAt >= startOfWeek && o.status === 'Completed').reduce((s, o) => s + o.sellingPrice, 0);
    const monthRevenue = allEntries.filter(e => e.createdAt >= startOfMonth && e.jobStatus === 'Completed').reduce((s, e) => s + e.revenue, 0)
        + allOrders.filter(o => o.createdAt >= startOfMonth && o.status === 'Completed').reduce((s, o) => s + o.sellingPrice, 0);

    const totalRevenue = entries.filter(e => e.jobStatus === 'Completed').reduce((s, e) => s + (e.revenue || 0), 0)
        + allOrders.filter(o => o.status === 'Completed').reduce((s, o) => s + o.sellingPrice, 0);
    const totalExpense = entries.reduce((s, e) => s + (e.travelExpense || 0), 0)
        + allOrders.filter(o => o.status === 'Completed').reduce((s, o) => s + o.costPrice, 0);

    const followUpRevenue = allEntries.filter(e => e.callStatus === 'Done' && e.conversionStatus === 'Converted').reduce((s, e) => s + (e.revenue || 0), 0);

    let sources = { CCTV: 0, Networking: 0, 'Software AI': 0, AMC: 0, '79 Service': 0 };
    let conversionCounts = { Converted: 0, TotalCalls: 0 };
    allEntries.filter(e => e.jobStatus === 'Completed').forEach(e => {
        sources['79 Service'] += e.revenue;
        e.interestedServices.forEach(s => { if (sources[s] !== undefined) sources[s] += 1000; });
        if (e.followUpDate) { conversionCounts.TotalCalls++; if (e.conversionStatus === 'Converted') conversionCounts.Converted++; }
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
    const entries = await Entry.find().sort({ createdAt: -1 });
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
    const projects = await AIProject.find().sort({ createdAt: -1 });
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
    const products = await CCTVProduct.find().sort({ category: 1, productName: 1 });
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
    const items = await OtherBusiness.find().sort({ createdAt: -1 });
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
    const offices = await AMCOffice.find().sort({ createdAt: -1 });
    
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
    const vendors = await Vendor.find().sort({ createdAt: -1 });
    
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
    const items = await StockItem.find().sort({ category: 1, productName: 1 });
    
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
    const items = await StockItem.find().sort({ category: 1, productName: 1 });
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
    const tools = await Tool.find().sort({ createdAt: -1 });
    
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
    const leads = await Lead.find().sort({ createdAt: -1 });
    
    const stats = {
        total: leads.length,
        new: leads.filter(l => l.status === 'New').length,
        contacted: leads.filter(l => l.status === 'Contacted').length,
        meeting: leads.filter(l => l.status === 'Meeting Scheduled').length,
        quoteSent: leads.filter(l => l.status === 'Quote Sent').length,
        won: leads.filter(l => l.status === 'Won').length,
        lost: leads.filter(l => l.status === 'Lost').length,
        totalValue: leads.reduce((s, l) => s + (l.estimatedValue || 0), 0),
        wonValue: leads.filter(l => l.status === 'Won').reduce((s, l) => s + (l.estimatedValue || 0), 0)
    };
    
    // Today's follow-ups
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const todayFollowUps = [];
    leads.forEach(lead => {
        (lead.followUps || []).forEach(f => {
            const fd = new Date(f.date);
            if (fd >= today && fd < tomorrow && f.status === 'Scheduled') {
                todayFollowUps.push({ ...f.toObject(), leadId: lead._id, leadName: lead.leadName, mobile: lead.mobile });
            }
        });
    });
    
    res.render('leads', { user: req.session.user, leads, stats, todayFollowUps });
});

app.get('/leads/:id', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) return res.status(404).send('Lead not found');
        res.render('lead-detail', { user: req.session.user, lead });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
    try {
        const data = req.body;
        const count = await Lead.countDocuments();
        data.leadNumber = `SEA-L-${String(count + 1).padStart(4, '0')}`;
        const lead = new Lead(data);
        await lead.save();
        res.json({ success: true, lead });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
    try {
        const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, lead });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Lead.findByIdAndDelete(req.params.id);
        res.json({ success: true });
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

// ============ START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Searvator CRM running on port ${PORT}`));
