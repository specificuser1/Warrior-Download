const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database('data.db');

// Uploads directory
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-').toLowerCase()}`)
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Initialize database tables
db.exec(`
    CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, link TEXT, thumb TEXT);
    CREATE TABLE IF NOT EXISTS socials (platform TEXT PRIMARY KEY, link TEXT);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, password TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Seed default data
const adminExists = db.prepare('SELECT id FROM admin').get();
if (!adminExists) {    db.prepare('INSERT INTO admin (id, password) VALUES (1, ?)').run(bcrypt.hashSync('admin123', 10));
    ['discord', 'telegram', 'youtube'].forEach(p =>
        db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run(p, '#')
    );
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('site_title', 'Warrior Download');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('footer_text', 'Secure Tools. Direct Access. No Compromises.');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('logo', '');
}

// Middleware
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'warrior_sec_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));

// Auth middleware
const requireAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.redirect('/admin/login');
};

// Helper: Get all settings as object
const getSettings = () => {
    const rows = db.prepare('SELECT * FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
};

// Routes
app.get('/', (req, res) => {
    const tools = db.prepare('SELECT * FROM tools').all();
    const socials = db.prepare('SELECT * FROM socials').all();
    res.render('public', { tools, socials, ...getSettings() });
});

app.get('/admin/login', (req, res) => {
    res.render('login');
});

app.post('/admin/login', (req, res) => {
    const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
    if (admin && bcrypt.compareSync(req.body.password, admin.password)) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }    res.render('login', { error: 'Invalid credentials.' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/admin', requireAuth, (req, res) => {
    res.render('admin', {
        tools: db.prepare('SELECT * FROM tools').all(),
        socials: db.prepare('SELECT * FROM socials').all(),
        settings: getSettings(),
        editing: null
    });
});

// Handle Add/Edit Tool
app.post('/admin/tool', requireAuth, upload.single('thumbFile'), (req, res) => {
    try {
        const { id, name, desc, link, thumbUrl } = req.body;
        let thumb = '/placeholder.png';

        if (req.file) {
            thumb = `/uploads/${req.file.filename}`;
        } else if (thumbUrl && thumbUrl.trim() !== '') {
            thumb = thumbUrl.trim();
        } else if (id) {
            const existing = db.prepare('SELECT thumb FROM tools WHERE id = ?').get(id);
            thumb = existing ? existing.thumb : thumb;
        }

        if (id) {
            db.prepare('UPDATE tools SET name=?, desc=?, link=?, thumb=? WHERE id=?').run(name, desc, link, thumb, id);
        } else {
            db.prepare('INSERT INTO tools (name, desc, link, thumb) VALUES (?, ?, ?, ?)').run(name, desc, link, thumb);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving tool.');
    }
});

// Handle Delete Tool
app.post('/admin/tool/delete', requireAuth, (req, res) => {
    try {
        const tool = db.prepare('SELECT thumb FROM tools WHERE id = ?').get(req.body.id);
        if (tool && tool.thumb && tool.thumb.startsWith('/uploads/')) {
            const filePath = path.join(__dirname, 'public', tool.thumb);            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        db.prepare('DELETE FROM tools WHERE id = ?').run(req.body.id);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Handle Settings Update
app.post('/admin/settings', requireAuth, upload.single('logoFile'), (req, res) => {
    try {
        const { site_title, footer_text } = req.body;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_title', site_title);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('footer_text', footer_text);

        if (req.file) {
            const oldLogo = getSettings().logo;
            if (oldLogo && oldLogo.startsWith('/uploads/')) {
                const oldPath = path.join(__dirname, 'public', oldLogo);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo', `/uploads/${req.file.filename}`);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Handle Socials Update
app.post('/admin/socials', requireAuth, (req, res) => {
    try {
        Object.entries(req.body).forEach(([key, value]) => {
            db.prepare('INSERT OR REPLACE INTO socials (platform, link) VALUES (?, ?)').run(key, value);
        });
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Handle Password Change
app.post('/admin/password', requireAuth, (req, res) => {
    try {
        const { oldPass, newPass } = req.body;
        const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();        if (bcrypt.compareSync(oldPass, admin.password)) {
            db.prepare('UPDATE admin SET password = ? WHERE id = 1').run(bcrypt.hashSync(newPass, 10));
            res.redirect('/admin');
        } else {
            res.render('admin', {
                tools: db.prepare('SELECT * FROM tools').all(),
                socials: db.prepare('SELECT * FROM socials').all(),
                settings: getSettings(),
                error: 'Current password is incorrect.'
            });
        }
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Warrior Download running on port ${PORT}`);
});
