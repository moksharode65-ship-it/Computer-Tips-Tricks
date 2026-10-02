require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'swapnil-computer-tips-secret-2024';

// --- MongoDB Connection ---
let db;
let client;

async function connectDB() {
    if (db) return db;
    if (!MONGO_URI) throw new Error('MONGO_URI environment variable is not set.');
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('computerTips');
    console.log('✅ Connected to MongoDB Atlas');

    // Ensure admin exists on startup
    const users = db.collection('users');
    const adminExists = await users.findOne({ role: 'admin' });
    if (!adminExists) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        await users.insertOne({
            name: 'Swapnil (Admin)',
            email: 'admin@computertips.com',
            password: hashedPassword,
            role: 'admin',
            createdAt: new Date().toISOString()
        });
        console.log('✅ Default admin created: admin@computertips.com / admin123');
    }

    return db;
}

// --- Middleware ---
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Helper to get collections
async function getCollections() {
    const database = await connectDB();
    return {
        users: database.collection('users'),
        enrollments: database.collection('enrollments'),
        contacts: database.collection('contacts')
    };
}

// ==========================================
//  STUDENT APIs
// ==========================================

// Student Signup
app.post('/api/signup', async (req, res) => {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    try {
        const { users } = await getCollections();
        if (await users.findOne({ email })) {
            return res.status(400).json({ error: 'This email is already registered.' });
        }
        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = await users.insertOne({
            name,
            email,
            phone: phone || '',
            password: hashedPassword,
            role: 'student',
            createdAt: new Date().toISOString()
        });
        const newUser = { id: result.insertedId.toString(), name, email };
        req.session.userId = result.insertedId.toString();
        req.session.role = 'student';
        res.json({ success: true, user: newUser });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Student Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { users } = await getCollections();
        const user = await users.findOne({ email, role: 'student' });
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        req.session.userId = user._id.toString();
        req.session.role = 'student';
        res.json({ success: true, user: { id: user._id.toString(), name: user.name, email: user.email } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Student Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get current student profile
app.get('/api/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    try {
        const { users, enrollments } = await getCollections();
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const allEnrollments = await enrollments.find({ userId: req.session.userId }).toArray();
        const approvedEnrollments = allEnrollments.filter(e => e.status === 'APPROVED' || e.status === 'PAID');
        const pendingEnrollments = allEnrollments.filter(e => e.status === 'PENDING');

        res.json({
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            enrollments: approvedEnrollments,
            pendingEnrollments
        });
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// Student Enrollment Request
app.post('/api/enroll', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const { courseId, courseName, amount, paymentMethod, transactionId } = req.body;
    try {
        const { users, enrollments } = await getCollections();
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });

        const existing = await enrollments.findOne({
            userId: req.session.userId,
            courseId,
            status: { $in: ['APPROVED', 'PENDING'] }
        });
        if (existing) {
            if (existing.status === 'PENDING') {
                return res.status(400).json({ error: 'Your enrollment request is already pending admin approval.' });
            }
            return res.status(400).json({ error: 'You are already enrolled in this course.' });
        }

        const enrollment = {
            userId: req.session.userId,
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

        const result = await enrollments.insertOne(enrollment);
        res.json({ success: true, message: 'Enrollment request submitted! The admin will verify your payment and approve your access.', enrollment: { ...enrollment, id: result.insertedId.toString() } });
    } catch (err) {
        console.error('Enroll error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});


// ==========================================
//  ADMIN APIs
// ==========================================

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { users } = await getCollections();
        const admin = await users.findOne({ email, role: 'admin' });
        if (!admin || !bcrypt.compareSync(password, admin.password)) {
            return res.status(401).json({ error: 'Invalid admin credentials.' });
        }
        req.session.userId = admin._id.toString();
        req.session.role = 'admin';
        res.json({ success: true, user: { name: admin.name } });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// Admin Auth Middleware
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    next();
}

// Get all students (Admin Only)
app.get('/api/admin/students', requireAdmin, async (req, res) => {
    try {
        const { users } = await getCollections();
        const students = await users.find({ role: 'student' }, { projection: { password: 0 } }).toArray();
        res.json(students.map(u => ({ id: u._id.toString(), name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt })));
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// Get all enrollments (Admin Only)
app.get('/api/admin/enrollments', requireAdmin, async (req, res) => {
    try {
        const { enrollments } = await getCollections();
        const all = await enrollments.find().sort({ createdAt: -1 }).toArray();
        res.json(all.map(e => ({ ...e, id: e._id.toString() })));
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// Get dashboard stats (Admin Only)
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const { users, enrollments } = await getCollections();
        const totalStudents = await users.countDocuments({ role: 'student' });
        const allEnrollments = await enrollments.find().toArray();
        const totalEnrollments = allEnrollments.filter(e => e.status === 'APPROVED').length;
        const pendingEnrollments = allEnrollments.filter(e => e.status === 'PENDING');
        const totalRevenue = allEnrollments.filter(e => e.status === 'APPROVED').reduce((sum, e) => sum + (e.amount || 0), 0);
        const recentStudents = await users.find({ role: 'student' }, { projection: { password: 0 } })
            .sort({ createdAt: -1 }).limit(10).toArray();

        res.json({
            totalStudents,
            totalEnrollments,
            pendingEnrollments: pendingEnrollments.map(e => ({ ...e, id: e._id.toString() })),
            totalRevenue,
            recentStudents: recentStudents.map(u => ({ id: u._id.toString(), name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// Approve an enrollment (Admin Only)
app.put('/api/admin/enrollments/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { enrollments } = await getCollections();
        const result = await enrollments.findOneAndUpdate(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'APPROVED', approvedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );
        if (!result) return res.status(404).json({ error: 'Enrollment not found.' });
        res.json({ success: true, enrollment: { ...result, id: result._id.toString() } });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// Reject an enrollment (Admin Only)
app.put('/api/admin/enrollments/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { enrollments } = await getCollections();
        const result = await enrollments.findOneAndUpdate(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'REJECTED', rejectedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );
        if (!result) return res.status(404).json({ error: 'Enrollment not found.' });
        res.json({ success: true, enrollment: { ...result, id: result._id.toString() } });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// Delete a student (Admin Only)
app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
    try {
        const { users, enrollments } = await getCollections();
        await users.deleteOne({ _id: new ObjectId(req.params.id), role: 'student' });
        await enrollments.deleteMany({ userId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
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
    console.log(`   🌐 Port: ${PORT}`);
    console.log('   ======================================');
    console.log('');
});

module.exports = app;
