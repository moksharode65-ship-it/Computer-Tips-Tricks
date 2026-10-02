const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'swapnil-computer-tips-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve the public site (student-facing pages)
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Serve the admin panel (only HTML/CSS/JS, API checks auth)
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

// --- Database Helpers ---
function readDB() {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
}

function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// --- Initialize default admin account on first run ---
(function initAdmin() {
    const db = readDB();
    const adminExists = db.users.find(u => u.role === 'admin');
    if (!adminExists) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        db.users.push({
            id: 1,
            name: 'Swapnil (Admin)',
            email: 'admin@computertips.com',
            password: hashedPassword,
            role: 'admin',
            createdAt: new Date().toISOString()
        });
        writeDB(db);
        console.log('✅ Default admin created: admin@computertips.com / admin123');
    }
})();

// ==========================================
//  STUDENT APIs
// ==========================================

// Student Signup
app.post('/api/signup', (req, res) => {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const db = readDB();
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'This email is already registered.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = {
        id: db.users.length + 1,
        name,
        email,
        phone: phone || '',
        password: hashedPassword,
        role: 'student',
        createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    writeDB(db);

    req.session.userId = newUser.id;
    req.session.role = 'student';
    res.json({ success: true, user: { id: newUser.id, name: newUser.name, email: newUser.email } });
});

// Student Login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.email === email && u.role === 'student');

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid email or password.' });
    }

    req.session.userId = user.id;
    req.session.role = 'student';
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
});

// Student Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get current student profile (and enrollments)
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    
    // Only count APPROVED enrollments as active
    const approvedEnrollments = db.enrollments ? db.enrollments.filter(e => e.userId === req.session.userId && (e.status === 'APPROVED' || e.status === 'PAID')) : [];
    const pendingEnrollments = db.enrollments ? db.enrollments.filter(e => e.userId === req.session.userId && e.status === 'PENDING') : [];
    
    res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, enrollments: approvedEnrollments, pendingEnrollments });
});

// Student Enrollment Request (creates a PENDING request for admin to verify)
app.post('/api/enroll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const { courseId, courseName, amount, paymentMethod, transactionId } = req.body;
    
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    // Check if already enrolled or has a pending request
    const existing = db.enrollments.find(e => e.userId === user.id && e.courseId === courseId && (e.status === 'APPROVED' || e.status === 'PENDING'));
    if (existing) {
        if (existing.status === 'PENDING') {
            return res.status(400).json({ error: 'Your enrollment request is already pending admin approval.' });
        }
        return res.status(400).json({ error: 'You are already enrolled in this course.' });
    }

    const maxId = db.enrollments.length > 0 ? Math.max(...db.enrollments.map(e => e.id)) : 0;
    const enrollment = {
        id: maxId + 1,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        userPhone: user.phone || '',
        courseId,
        courseName,
        amount,
        paymentMethod: paymentMethod || 'Not specified',
        transactionId: transactionId || '',
        status: 'PENDING',
        createdAt: new Date().toISOString()
    };
    
    db.enrollments.push(enrollment);
    writeDB(db);
    
    res.json({ success: true, message: 'Enrollment request submitted! The admin will verify your payment and approve your access.', enrollment });
});


// ==========================================
//  ADMIN APIs
// ==========================================

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    const db = readDB();
    const admin = db.users.find(u => u.email === email && u.role === 'admin');

    if (!admin || !bcrypt.compareSync(password, admin.password)) {
        return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    req.session.userId = admin.id;
    req.session.role = 'admin';
    res.json({ success: true, user: { name: admin.name } });
});

// Admin Auth Middleware
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    next();
}

// Get all students (Admin Only)
app.get('/api/admin/students', requireAdmin, (req, res) => {
    const db = readDB();
    const students = db.users
        .filter(u => u.role === 'student')
        .map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt }));
    res.json(students);
});

// Get all enrollments (Admin Only)
app.get('/api/admin/enrollments', requireAdmin, (req, res) => {
    const db = readDB();
    res.json(db.enrollments);
});

// Get dashboard stats (Admin Only)
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const db = readDB();
    const totalStudents = db.users.filter(u => u.role === 'student').length;
    const totalEnrollments = db.enrollments.filter(e => e.status === 'APPROVED').length;
    const pendingEnrollments = db.enrollments.filter(e => e.status === 'PENDING');
    const totalRevenue = db.enrollments.filter(e => e.status === 'APPROVED').reduce((sum, e) => sum + (e.amount || 0), 0);
    const recentStudents = db.users
        .filter(u => u.role === 'student')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt }));
    
    res.json({ totalStudents, totalEnrollments, pendingEnrollments, totalRevenue, recentStudents });
});

// Approve an enrollment (Admin Only)
app.put('/api/admin/enrollments/:id/approve', requireAdmin, (req, res) => {
    const db = readDB();
    const id = parseInt(req.params.id);
    const enrollment = db.enrollments.find(e => e.id === id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found.' });
    enrollment.status = 'APPROVED';
    enrollment.approvedAt = new Date().toISOString();
    writeDB(db);
    res.json({ success: true, enrollment });
});

// Reject an enrollment (Admin Only)
app.put('/api/admin/enrollments/:id/reject', requireAdmin, (req, res) => {
    const db = readDB();
    const id = parseInt(req.params.id);
    const enrollment = db.enrollments.find(e => e.id === id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found.' });
    enrollment.status = 'REJECTED';
    enrollment.rejectedAt = new Date().toISOString();
    writeDB(db);
    res.json({ success: true, enrollment });
});

// Delete a student (Admin Only)
app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
    const db = readDB();
    const id = parseInt(req.params.id);
    db.users = db.users.filter(u => !(u.id === id && u.role === 'student'));
    db.enrollments = db.enrollments.filter(e => e.userId !== id);
    writeDB(db);
    res.json({ success: true });
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});


// ==========================================
//  START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 ======================================');
    console.log(`   Computer Tips & Tricks Server`);
    console.log('   ======================================');
    console.log(`   🌐 Public Site:  http://localhost:${PORT}`);
    console.log(`   🔒 Admin Panel:  http://localhost:${PORT}/admin`);
    console.log('   ======================================');
    console.log('');
});
