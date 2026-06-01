const mongoose = require('mongoose');

// Daily attendance entry
const attendanceSchema = new mongoose.Schema({
    date: { type: Date, required: true },
    status: { type: String, default: 'Present' }, // Present, Absent, Half Day, Leave, Holiday
    
    // Time tracking
    checkIn: { type: String, default: '' },
    checkOut: { type: String, default: '' },
    workHours: { type: Number, default: 0 },
    
    // What did they do?
    visitsCount: { type: Number, default: 0 }, // service entries count
    revenue: { type: Number, default: 0 }, // revenue generated that day
    notes: { type: String, default: '' }
}, { _id: true, timestamps: true });

// Leave request
const leaveSchema = new mongoose.Schema({
    leaveType: { type: String, default: 'Casual' }, // Casual, Sick, Paid, Unpaid
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    days: { type: Number, default: 1 },
    reason: { type: String, default: '' },
    status: { type: String, default: 'Pending' }, // Pending, Approved, Rejected
    appliedOn: { type: Date, default: Date.now },
    approvedBy: { type: String, default: '' },
    notes: { type: String, default: '' }
}, { _id: true });

// Advance/Loan
const advanceSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    requestDate: { type: Date, default: Date.now },
    purpose: { type: String, default: '' },
    
    status: { type: String, default: 'Pending' }, // Pending, Paid, Adjusted, Cancelled
    paidDate: { type: Date },
    paymentMode: { type: String, default: '' },
    
    // Deduction
    adjustedAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    
    notes: { type: String, default: '' }
}, { _id: true });

// Salary payment record
const salaryPaymentSchema = new mongoose.Schema({
    month: { type: String, required: true }, // "2026-05"
    monthName: { type: String, default: '' }, // "May 2026"
    
    // Calculation
    daysWorked: { type: Number, default: 0 },
    daysAbsent: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    leaves: { type: Number, default: 0 },
    
    // Earnings
    baseSalary: { type: Number, default: 0 },
    incentive: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    overtimePay: { type: Number, default: 0 },
    
    // Deductions
    advanceDeducted: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    deductionReason: { type: String, default: '' },
    
    // Final
    grossPay: { type: Number, default: 0 },
    netPay: { type: Number, default: 0 },
    
    // Performance metrics for the month
    revenueGenerated: { type: Number, default: 0 },
    visitsCompleted: { type: Number, default: 0 },
    expensesIncurred: { type: Number, default: 0 },
    profitToCompany: { type: Number, default: 0 }, // revenue - salary - expenses
    
    paymentDate: { type: Date },
    paymentMode: { type: String, default: '' },
    paymentRef: { type: String, default: '' },
    status: { type: String, default: 'Pending' }, // Pending, Paid
    notes: { type: String, default: '' }
}, { _id: true, timestamps: true });

const employeeSchema = new mongoose.Schema({
    // Basic info
    employeeCode: { type: String, unique: true },
    name: { type: String, required: true },
    username: { type: String, default: '' }, // linked CRM username (vijay/rahul)
    
    role: { type: String, default: 'Engineer' }, // Engineer, Admin, Manager, Helper
    department: { type: String, default: 'Service' },
    
    mobile: { type: String, required: true },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    emergencyContact: { type: String, default: '' },
    
    // ID proofs
    aadhaarNumber: { type: String, default: '' },
    panNumber: { type: String, default: '' },
    
    // Bank details
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    
    // Employment
    joiningDate: { type: Date, default: Date.now },
    leavingDate: { type: Date },
    
    // Salary structure
    baseSalary: { type: Number, default: 0 }, // monthly fixed
    salaryType: { type: String, default: 'Monthly' }, // Monthly, Daily, Commission
    incentivePercent: { type: Number, default: 0 }, // % of revenue as incentive
    leavesPerMonth: { type: Number, default: 2 },
    
    // Tracking
    attendance: [attendanceSchema],
    leaves: [leaveSchema],
    advances: [advanceSchema],
    salaryPayments: [salaryPaymentSchema],
    
    status: { type: String, default: 'Active' }, // Active, Inactive, Resigned, Terminated
    photo: { type: String, default: '' },
    notes: { type: String, default: '' }
}, { timestamps: true });


// Performance indexes
employeeSchema.index({ status: 1, name: 1 });
employeeSchema.index({ username: 1 });
employeeSchema.index({ employeeCode: 1 });

module.exports = mongoose.model('Employee', employeeSchema);
