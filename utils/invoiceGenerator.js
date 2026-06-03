const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// Number to words (Indian style)
function numberToWords(num) {
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    
    function inWords(n) {
        if (n < 20) return a[n];
        if (n < 100) return b[Math.floor(n/10)] + (n%10 ? ' ' + a[n%10] : '');
        if (n < 1000) return a[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' ' + inWords(n%100) : '');
        if (n < 100000) return inWords(Math.floor(n/1000)) + ' Thousand' + (n%1000 ? ' ' + inWords(n%1000) : '');
        if (n < 10000000) return inWords(Math.floor(n/100000)) + ' Lakh' + (n%100000 ? ' ' + inWords(n%100000) : '');
        return inWords(Math.floor(n/10000000)) + ' Crore' + (n%10000000 ? ' ' + inWords(n%10000000) : '');
    }
    
    if (!num) return 'Zero';
    return 'Indian Rupees ' + inWords(Math.floor(num)) + ' Only';
}

/**
 * Generate Software Invoice PDF
 * @param {Object} invoice - SoftwareInvoice document
 * @param {Object} options - { isPaid: bool, outputPath: string }
 */
function generateSoftwareInvoicePDF(invoice, options = {}) {
    const isPaid = options.isPaid || invoice.status === 'Fully Paid';
    const outputPath = options.outputPath;
    
    const doc = new PDFDocument({
        margin: 0, size: 'A4',
        bufferPages: true, autoFirstPage: true,
        info: {
            Title: 'Invoice - ' + invoice.invoiceNumber,
            Author: 'Searvator IT Solutions',
            Subject: invoice.softwareName
        }
    });
    
    // Block extra pages
    doc.addPage = function() { return doc; };
    
    if (outputPath) doc.pipe(fs.createWriteStream(outputPath));
    
    const W = doc.page.width;
    const H = doc.page.height;
    const ACCENT = isPaid ? '#10b981' : '#3b82f6';
    
    function txt(text, x, y, opts) {
        opts = opts || {};
        opts.lineBreak = false;
        doc.text(text, x, y, opts);
    }
    
    // === HEADER ===
    doc.rect(0, 0, W, 125).fill('#0f172a');
    doc.rect(0, 0, W, 70).fill('#1e293b');
    doc.rect(0, 125, W, 3).fill(ACCENT);
    
    // Logo
    doc.roundedRect(35, 22, 60, 60, 8).fill('#ffffff');
    const logoPath = path.join(__dirname, '..', 'public', 'logo-icon.png');
    try {
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 38, 25, { fit: [54, 54] });
        }
    } catch (e) {
        doc.fillColor('#0f172a').fontSize(32).font('Helvetica-Bold');
        txt('S', 55, 38);
    }
    
    // Company
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold');
    txt('SEARVATOR', 110, 28);
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica');
    txt('IT SOLUTIONS PVT. LTD.', 110, 52);
    doc.fillColor('#cbd5e1').fontSize(7);
    txt('AI Software * Operations * IT Infrastructure', 110, 64);
    doc.fillColor('#fb923c').fontSize(6.5).font('Helvetica-Bold');
    txt('SEARCH AND FACILITATOR', 110, 76);
    doc.fillColor('#cbd5e1').fontSize(7).font('Helvetica');
    txt('+91 9106959092  |  info@searvator.com  |  www.searvator.com', 110, 88);
    doc.fillColor('#fcd34d').fontSize(7).font('Helvetica-Bold');
    txt('CIN: U62011GJ2026PTC172346', 110, 102);
    
    // Invoice label (right)
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold');
    txt('INVOICE', W - 145, 30);
    doc.fillColor(isPaid ? '#10b981' : '#60a5fa').fontSize(9).font('Helvetica');
    txt('# ' + invoice.invoiceNumber, W - 200, 60);
    doc.fillColor('#94a3b8').fontSize(8);
    txt('Date: ' + new Date(invoice.invoiceDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), W - 200, 78);
    
    let y = 140;
    
    // === PAID watermark ===
    if (isPaid) {
        doc.save();
        doc.translate(W / 2, H / 2);
        doc.rotate(-25);
        doc.fillColor('#10b981').fontSize(120).font('Helvetica-Bold').opacity(0.10);
        txt('PAID', -160, -70);
        doc.opacity(1);
        doc.restore();
        
        // Banner
        doc.rect(35, y, 525, 28).fill('#10b981');
        doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold');
        txt('PAYMENT RECEIVED IN FULL', 50, y + 9);
        doc.fontSize(10).font('Helvetica');
        if (invoice.paymentDate) {
            txt('Paid on: ' + new Date(invoice.paymentDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), W - 240, y + 10);
        }
        y += 36;
    }
    
    // === BILL TO + STATUS ===
    doc.roundedRect(35, y, 255, 90, 6).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Bold');
    txt('BILL TO', 45, y + 8);
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold');
    txt(invoice.clientName, 45, y + 22);
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica');
    let by = y + 38;
    if (invoice.clientCompany) { txt(invoice.clientCompany, 45, by); by += 11; }
    if (invoice.clientId) { txt('ID: ' + invoice.clientId, 45, by); by += 11; }
    if (invoice.clientMobile) { txt('Mobile: ' + invoice.clientMobile, 45, by); by += 11; }
    txt('Software: ' + invoice.softwareName, 45, by); by += 11;
    if (invoice.billingPeriodLabel) txt('Period: ' + invoice.billingPeriodLabel, 45, by);
    
    // Status box
    const statusBg = isPaid ? '#f0fdf4' : '#eff6ff';
    const statusBorder = isPaid ? '#86efac' : '#bfdbfe';
    const statusText = isPaid ? '#166534' : '#1e40af';
    doc.roundedRect(305, y, 255, 90, 6).fillAndStroke(statusBg, statusBorder);
    doc.fillColor(statusText).fontSize(7.5).font('Helvetica-Bold');
    txt(isPaid ? 'PAYMENT STATUS' : 'INVOICE DETAILS', 315, y + 8);
    
    doc.fillColor('#475569').fontSize(8).font('Helvetica');
    txt('Invoice Date:', 315, y + 24);
    doc.fillColor('#0f172a').font('Helvetica-Bold');
    txt(new Date(invoice.invoiceDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), 400, y + 24);
    
    if (isPaid && invoice.paymentDate) {
        doc.fillColor('#475569').font('Helvetica');
        txt('Payment Date:', 315, y + 38);
        doc.fillColor('#166534').font('Helvetica-Bold');
        txt(new Date(invoice.paymentDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), 400, y + 38);
        
        doc.fillColor('#475569').font('Helvetica');
        txt('Amount Paid:', 315, y + 52);
        doc.fillColor('#166534').font('Helvetica-Bold');
        txt('Rs. ' + invoice.grandTotal.toLocaleString('en-IN'), 400, y + 52);
        
        doc.fillColor('#475569').font('Helvetica');
        txt('Mode:', 315, y + 66);
        doc.fillColor('#166534').font('Helvetica-Bold');
        txt(invoice.paymentMode || 'Bank Transfer', 400, y + 66);
        
        doc.fillColor('#475569').font('Helvetica');
        txt('Status:', 315, y + 80);
        doc.fillColor('#16a34a').fontSize(10).font('Helvetica-Bold');
        txt('FULLY PAID', 400, y + 78);
    } else {
        doc.fillColor('#475569').font('Helvetica');
        txt('Service Type:', 315, y + 38);
        doc.fillColor('#0f172a').font('Helvetica-Bold');
        txt(invoice.softwareName.length > 25 ? invoice.softwareName.slice(0, 25) + '...' : invoice.softwareName, 400, y + 38);
        
        doc.fillColor('#475569').font('Helvetica');
        txt('Currency:', 315, y + 52);
        doc.fillColor('#0f172a').font('Helvetica-Bold');
        txt('INR (Rs.)', 400, y + 52);
        
        if (invoice.dueDate) {
            doc.fillColor('#475569').font('Helvetica');
            txt('Due Date:', 315, y + 66);
            doc.fillColor('#0f172a').font('Helvetica-Bold');
            txt(new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), 400, y + 66);
        }
        
        doc.fillColor('#475569').font('Helvetica');
        txt('Status:', 315, y + 80);
        doc.fillColor('#b91c1c').font('Helvetica-Bold');
        txt(invoice.status.toUpperCase(), 400, y + 80);
    }
    
    y += 100;
    
    // === ITEMS TABLE ===
    doc.rect(35, y, 525, 22).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
    txt('#', 45, y + 7);
    txt('DATE / DESCRIPTION', 70, y + 7);
    txt('QTY', 330, y + 7, { width: 60, align: 'center' });
    txt('RATE', 395, y + 7, { width: 60, align: 'right' });
    txt('AMOUNT', 460, y + 7, { width: 95, align: 'right' });
    y += 22;
    
    // Group items by section
    const sections = {};
    invoice.items.forEach(item => {
        const key = item.section + '|' + (item.sectionTitle || '');
        if (!sections[key]) sections[key] = { section: item.section, title: item.sectionTitle, items: [] };
        sections[key].items.push(item);
    });
    
    const sectionColors = {
        'A': { bg: '#eff6ff', text: '#1e40af', accent: '#dbeafe' },
        'B': { bg: '#fef3c7', text: '#92400e', accent: '#fde68a' },
        'C': { bg: '#f0fdf4', text: '#166534', accent: '#dcfce7' },
        'D': { bg: '#fce7f3', text: '#9f1239', accent: '#fbcfe8' }
    };
    
    let serial = 1;
    const rowH = 13;
    const maxBodyHeight = H - y - 280; // leave room for totals + footer
    
    Object.values(sections).forEach(sec => {
        const colors = sectionColors[sec.section] || sectionColors['A'];
        
        // Section header
        doc.rect(35, y, 525, 16).fill(colors.bg);
        doc.fillColor(colors.text).fontSize(7.5).font('Helvetica-Bold');
        txt(sec.section + '. ' + (sec.title || 'Items').toUpperCase(), 45, y + 5);
        y += 16;
        
        // Section items
        let sectionTotal = 0;
        sec.items.forEach((item, idx) => {
            if (idx % 2 === 0) doc.rect(35, y, 525, rowH).fill('#f8fafc');
            
            doc.fillColor('#475569').fontSize(7.5).font('Helvetica');
            txt(String(serial++), 45, y + 3);
            doc.fillColor('#0f172a');
            // Build description: if has date, prefix with it
            let desc = item.description;
            if (item.itemDate) {
                desc = new Date(item.itemDate).toISOString().slice(0, 10) + ' - ' + desc;
            }
            txt(desc.length > 50 ? desc.slice(0, 50) : desc, 70, y + 3);
            doc.font('Helvetica-Bold');
            txt(String(item.quantity), 330, y + 3, { width: 60, align: 'center' });
            doc.fillColor('#475569').font('Helvetica');
            txt('Rs. ' + (item.rate || 0).toLocaleString('en-IN'), 395, y + 3, { width: 60, align: 'right' });
            doc.fillColor('#0f172a').font('Helvetica-Bold');
            txt('Rs. ' + (item.amount || 0).toLocaleString('en-IN'), 460, y + 3, { width: 95, align: 'right' });
            
            sectionTotal += item.amount || 0;
            y += rowH;
        });
        
        // Section subtotal
        doc.rect(35, y, 525, 18).fill(colors.accent);
        doc.fillColor(colors.text).fontSize(8.5).font('Helvetica-Bold');
        txt('Subtotal - ' + (sec.title || 'Section ' + sec.section), 70, y + 6);
        const qtyTotal = sec.items.reduce((s, i) => s + (i.quantity || 0), 0);
        if (sec.items.length > 1) {
            txt(String(qtyTotal) + ' ' + (sec.items[0].unit || 'units'), 330, y + 6, { width: 60, align: 'center' });
        }
        txt('Rs. ' + sectionTotal.toLocaleString('en-IN'), 460, y + 6, { width: 95, align: 'right' });
        y += 22;
    });
    
    // === PAYMENT INFO + TOTAL ===
    doc.roundedRect(35, y, 250, 100, 8).fillAndStroke('#f0fdf4', '#86efac');
    doc.fillColor('#166534').fontSize(8.5).font('Helvetica-Bold');
    txt(isPaid ? 'PAYMENT RECEIVED FROM' : 'PAYMENT DETAILS', 47, y + 10);
    
    let py = y + 26;
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica');
    txt('Bank Name:', 47, py);
    doc.fillColor('#0f172a').font('Helvetica-Bold');
    txt(invoice.receivingBank || 'IndusInd Bank', 120, py);
    py += 14;
    
    doc.fillColor('#475569').font('Helvetica');
    txt('Account Name:', 47, py);
    doc.fillColor('#0f172a').font('Helvetica-Bold');
    txt(invoice.receivingAccountName || 'Vijay Ved', 120, py);
    py += 14;
    
    doc.fillColor('#475569').font('Helvetica');
    txt('Account No:', 47, py);
    doc.fillColor('#0f172a').font('Helvetica-Bold');
    txt(invoice.receivingAccount || '157984959275', 120, py);
    py += 14;
    
    doc.fillColor('#475569').font('Helvetica');
    txt('IFSC Code:', 47, py);
    doc.fillColor('#0f172a').font('Helvetica-Bold');
    txt(invoice.receivingIFSC || 'INDB0000622', 120, py);
    
    // Totals box - green if PAID, dark otherwise
    const totalBg = isPaid ? '#10b981' : '#0f172a';
    const totalLabel = isPaid ? '#dcfce7' : '#94a3b8';
    doc.roundedRect(295, y, 265, 100, 8).fillAndStroke(totalBg, totalBg);
    
    let ty = y + 12;
    
    // Show first 2 section subtotals or just subtotal
    doc.fillColor(totalLabel).fontSize(8.5).font('Helvetica');
    txt('Subtotal:', 310, ty);
    doc.fillColor('#ffffff').font('Helvetica-Bold');
    txt('Rs. ' + invoice.subtotal.toLocaleString('en-IN'), 310, ty, { width: 240, align: 'right' });
    ty += 14;
    
    if (invoice.gstAmount > 0) {
        doc.fillColor(totalLabel).font('Helvetica');
        txt('GST (' + invoice.gstPercent + '%):', 310, ty);
        doc.fillColor('#ffffff').font('Helvetica-Bold');
        txt('Rs. ' + invoice.gstAmount.toLocaleString('en-IN'), 310, ty, { width: 240, align: 'right' });
        ty += 14;
    }
    
    if (invoice.discount > 0) {
        doc.fillColor(totalLabel).font('Helvetica');
        txt('Discount:', 310, ty);
        doc.fillColor('#ffffff').font('Helvetica-Bold');
        txt('- Rs. ' + invoice.discount.toLocaleString('en-IN'), 310, ty, { width: 240, align: 'right' });
        ty += 14;
    }
    
    doc.moveTo(310, ty).lineTo(545, ty).strokeColor(isPaid ? '#86efac' : '#475569').stroke();
    ty += 6;
    
    doc.fillColor(totalLabel).fontSize(10).font('Helvetica-Bold');
    txt(isPaid ? 'TOTAL PAID:' : 'GRAND TOTAL:', 310, ty);
    doc.fillColor(isPaid ? '#ffffff' : '#fb923c').fontSize(18);
    txt('Rs. ' + invoice.grandTotal.toLocaleString('en-IN'), 310, ty - 4, { width: 240, align: 'right' });
    ty += 22;
    
    doc.fillColor(totalLabel).fontSize(6.5).font('Helvetica');
    txt('(' + (invoice.amountInWords || numberToWords(invoice.grandTotal)) + ')', 310, ty, { width: 240, align: 'center' });
    
    y += 110;
    
    // === NOTES ===
    const notesBg = isPaid ? '#f0fdf4' : '#fffbeb';
    const notesBorder = isPaid ? '#10b981' : '#fcd34d';
    const notesTitleColor = isPaid ? '#166534' : '#92400e';
    
    doc.roundedRect(35, y, 525, 50, 6).fillAndStroke(notesBg, notesBorder);
    doc.fillColor(notesTitleColor).fontSize(8).font('Helvetica-Bold');
    txt(isPaid ? 'PAYMENT RECEIPT - ACKNOWLEDGEMENT' : 'NOTES & TERMS', 45, y + 8);
    doc.fillColor(isPaid ? '#14532d' : '#451a03').fontSize(7).font('Helvetica');
    
    if (isPaid) {
        txt('* We hereby acknowledge receipt of Rs. ' + invoice.grandTotal.toLocaleString('en-IN') + ' from ' + invoice.clientName + '.', 45, y + 22);
        txt('* Full payment received towards Invoice No. ' + invoice.invoiceNumber + '.', 45, y + 32);
        txt('* No outstanding balance pending. Thank you for your prompt payment!', 45, y + 42);
    } else {
        txt('* Payment due within 7 working days of invoice receipt.', 45, y + 22);
        txt('* Mention Invoice No. (' + invoice.invoiceNumber + ') in payment reference.', 45, y + 32);
        txt('* Queries: +91 9106959092 or info@searvator.com', 45, y + 42);
    }
    
    y += 56;
    
    // === SIGNATURE ===
    doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica');
    txt('Authorized Signatory', W - 170, y, { width: 130, align: 'right' });
    doc.fillColor(isPaid ? '#16a34a' : '#1e40af').fontSize(13).font('Helvetica-Bold');
    txt('VIJAY VED', W - 170, y + 12, { width: 130, align: 'right' });
    doc.fillColor('#64748b').fontSize(6.5).font('Helvetica');
    txt('Searvator IT Solutions Pvt. Ltd.', W - 170, y + 30, { width: 130, align: 'right' });
    
    // === FOOTER ===
    doc.rect(0, H - 32, W, 32).fill('#0f172a');
    doc.fillColor('#fcd34d').fontSize(6.5).font('Helvetica-Bold');
    txt('CIN: U62011GJ2026PTC172346', 0, H - 25, { width: W, align: 'center' });
    doc.fillColor('#94a3b8').fontSize(6.5).font('Helvetica');
    txt(isPaid ? 'This is a computer-generated PAID invoice receipt.' : 'This is a computer-generated invoice. No signature required for digital records.', 0, H - 16, { width: W, align: 'center' });
    doc.fillColor(isPaid ? '#10b981' : '#fb923c').font('Helvetica-Bold');
    txt(isPaid ? 'Payment Received - Thank you for your business! - Team Searvator' : 'Thank you for your business! - Team Searvator', 0, H - 8, { width: W, align: 'center' });
    
    doc.end();
    
    return doc;
}

module.exports = { generateSoftwareInvoicePDF, numberToWords };
