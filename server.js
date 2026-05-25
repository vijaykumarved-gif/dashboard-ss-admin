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

// 1. Diagnostic Report PDF
app.get('/report/:id', async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        if (!entry) return res.status(404).send('Report not found');
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        res.setHeader('Content-disposition', `attachment; filename=Report_${entry.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        doc.rect(0, 0, doc.page.width, 100).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold').text('SEARVATOR IT SOLUTIONS', 0, 35, { align: 'center' });
        doc.fontSize(10).font('Helvetica').text('Diagnostic & Health Report', 0, 65, { align: 'center' });

        doc.rect(40, 120, 515, 70).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.fillColor('#1e293b').fontSize(12).font('Helvetica-Bold').text(`Customer: ${entry.customerName}`, 50, 130);
        doc.font('Helvetica').fontSize(10).text(`Location: ${entry.location}`, 50, 150);
        doc.text(`Mobile: ${entry.mobileNumber}`, 50, 170);
        doc.font('Helvetica-Bold').text(`Date: ${entry.createdAt.toLocaleDateString()}`, 400, 130);
        doc.font('Helvetica').text(`System: ${entry.pcModel}`, 400, 150);

        doc.rect(40, 210, 515, 30).fill('#3b82f6');
        doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold').text('Hardware Component Status', 50, 218);

        let startY = 250;
        const drawRow = (label1, val1, label2, val2) => {
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#475569').text(label1 + ':', 50, startY, { width: 110 });
            doc.font('Helvetica').fillColor(val1 === 'Good' || val1 === 'Normal' ? '#16a34a' : '#dc2626').text(val1, 160, startY, { width: 140 });
            doc.font('Helvetica-Bold').fillColor('#475569').text(label2 + ':', 310, startY, { width: 110 });
            doc.font('Helvetica').fillColor(val2 === 'Good' || val2 === 'Normal' ? '#16a34a' : '#dc2626').text(val2, 420, startY, { width: 130 });
            doc.moveTo(40, startY + 15).lineTo(555, startY + 15).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
            startY += 25;
        };
        drawRow('Motherboard', entry.motherboard, 'CPU/Processor', entry.cpu);
        drawRow('RAM Status', entry.ramStatus, 'RAM Slots', entry.ramSlot);
        drawRow('Storage', entry.hddHealth, 'Optical Drive', entry.drive);
        drawRow('Cooling Fan', entry.fan, 'System Temp', entry.temperature);
        drawRow('Connectors', entry.connectors, 'Monitor/Screen', entry.monitor);
        drawRow('Battery Health', entry.battery, 'Charger', entry.charger);
        drawRow('Power Cable', entry.powerCable, 'Webcam/Mic', entry.webcam);

        startY += 20;
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#1e293b').text('Engineer Remarks:', 40, startY);
        doc.font('Helvetica').fontSize(10).fillColor('#475569').text(entry.remarks, 40, startY + 20, { width: 515, align: 'justify' });

        const footerY = doc.page.height - 100;
        doc.rect(0, footerY, doc.page.width, 100).fill('#0f172a');
        doc.fillColor('#38bdf8').fontSize(14).font('Helvetica-Bold').text('SEARVATOR IT SOLUTIONS PVT. LTD.', 0, footerY + 20, { align: 'center' });
        doc.fillColor('#ffffff').fontSize(10).text('www.searvator.com | Ahmedabad, Gujarat', 0, footerY + 50, { align: 'center' });
        doc.end();
    } catch (err) { res.status(500).send('Error generating report'); }
});

// 2. Service Invoice PDF
app.get('/invoice/:id', async (req, res) => {
    try {
        const entry = await Entry.findById(req.params.id);
        if (!entry) return res.status(404).send('Invoice not found');
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-disposition', `attachment; filename=Invoice_${entry.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        doc.fontSize(22).fillColor('#2563eb').font('Helvetica-Bold').text('SEARVATOR IT SOLUTIONS', 50, 50);
        doc.fontSize(10).fillColor('#64748b').font('Helvetica').text('Ahmedabad, Gujarat, India\nWebsite: www.searvator.com', 50, 80);
        doc.fontSize(24).font('Helvetica-Bold').fillColor('#0f172a').text('INVOICE', 50, 115, { align: 'right' });

        doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('Bill To:', 50, 160);
        doc.fontSize(10).font('Helvetica').fillColor('#334155').text(entry.customerName, 50, 175).text(entry.location, 50, 190).text(`Ph: ${entry.mobileNumber}`, 50, 205);
        doc.fontSize(10).font('Helvetica-Bold').text(`Invoice Date: ${entry.createdAt.toLocaleDateString()}`, 400, 160);
        doc.text(`Payment Mode: ${entry.paymentMode || 'Cash'}`, 400, 175);

        doc.rect(50, 240, 495, 25).fill('#e2e8f0');
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Description', 60, 247).text('Qty', 350, 247).text('Amount (INR)', 430, 247);
        doc.font('Helvetica').text(entry.serviceTaken, 60, 280).text('1', 355, 280).text(`Rs. ${entry.revenue}`, 435, 280);
        doc.moveTo(50, 310).lineTo(545, 310).strokeColor('#cbd5e1').stroke();
        doc.font('Helvetica-Bold').text('TOTAL AMOUNT:', 300, 330).fillColor('#16a34a').fontSize(14).text(`Rs. ${entry.revenue}`, 430, 328);

        doc.fontSize(10).fillColor('#64748b').font('Helvetica').text('Thank you for your business!', 50, 420, { align: 'center' });
        doc.end();
    } catch (err) { res.status(500).send('Error generating invoice'); }
});

// 3. Order Invoice PDF
app.get('/order-invoice/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send('Invoice not found');
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-disposition', `attachment; filename=Tax_Invoice_${order.customerName.replace(/\s+/g, '_')}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        doc.fontSize(22).fillColor('#2563eb').font('Helvetica-Bold').text('SEARVATOR IT SOLUTIONS', 50, 50);
        doc.fontSize(10).fillColor('#64748b').font('Helvetica').text('Ahmedabad, Gujarat, India\nWebsite: www.searvator.com', 50, 80);
        doc.fontSize(20).font('Helvetica-Bold').fillColor('#0f172a').text('TAX INVOICE - PRODUCT', 50, 115, { align: 'right' });

        doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('Billed To:', 50, 160);
        doc.fontSize(10).font('Helvetica').fillColor('#334155').text(order.customerName, 50, 175).text(order.location, 50, 190).text(`Ph: ${order.mobileNumber}`, 50, 205);
        doc.fontSize(10).font('Helvetica-Bold').text(`Invoice Date: ${order.createdAt.toLocaleDateString()}`, 400, 160);
        doc.text(`Warranty: ${order.warranty || 'N/A'}`, 400, 175);

        doc.rect(50, 240, 495, 25).fill('#e2e8f0');
        doc.fillColor('#0f172a').font('Helvetica-Bold').text('Product/Service Description', 60, 247).text('Qty', 350, 247).text('Amount (INR)', 430, 247);
        doc.font('Helvetica').text(order.description, 60, 280, { width: 280 }).text('1', 355, 280).text(`Rs. ${order.sellingPrice}`, 435, 280);
        doc.moveTo(50, 310).lineTo(545, 310).strokeColor('#cbd5e1').stroke();
        doc.font('Helvetica-Bold').text('TOTAL AMOUNT:', 300, 330).fillColor('#16a34a').fontSize(14).text(`Rs. ${order.sellingPrice}`, 430, 328);
        doc.end();
    } catch (err) { res.status(500).send('Error generating invoice'); }
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

// ============ START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Searvator CRM running on port ${PORT}`));
