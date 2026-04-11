const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database('data.db');

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-').toLowerCase()}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.zip', '.rar', '.exe', '.dmg', '.apk'].includes(ext)) cb(null, true);
        else cb(new Error('Invalid file type'));
    }
});

try { db.exec(`ALTER TABLE tools ADD COLUMN status TEXT DEFAULT 'stable';`); } catch(e) {}
db.exec(`
    CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, link TEXT, thumb TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS socials (platform TEXT PRIMARY KEY, link TEXT);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, password TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

if (!db.prepare('SELECT id FROM admin').get()) {
    db.prepare('INSERT INTO admin (id, password) VALUES (1, ?)').run(bcrypt.hashSync('admin123', 10));
    ['discord', 'telegram', 'youtube'].forEach(p => db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run(p, '#'));
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('site_title', 'Warrior Download');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('footer_text', 'Secure Tools. Direct Access. No Compromises.');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('logo', '');
}

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({    secret: process.env.SESSION_SECRET || 'warrior_sec_2026',
    resave: false, saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));

const requireAuth = (req, res, next) => req.session.isAdmin ? next() : res.status(401).json({ error: 'Unauthorized' });
const getSettings = () => Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(r => [r.key, r.value]));

// Public & Auth Routes
app.get('/', (req, res) => res.render('public', { tools: db.prepare('SELECT * FROM tools').all(), socials: db.prepare('SELECT * FROM socials').all(), ...getSettings() }));
app.get('/admin/login', (req, res) => res.render('login'));
app.post('/admin/login', (req, res) => {
    const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
    if (bcrypt.compareSync(req.body.password, admin.password)) { req.session.isAdmin = true; return res.redirect('/admin'); }
    res.render('login', { error: 'Invalid credentials.' });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/admin', requireAuth, (req, res) => {
    const s = getSettings();
    res.render('admin', { tools: db.prepare('SELECT * FROM tools').all(), socials: db.prepare('SELECT * FROM socials').all(), settings: s, site_title: s.site_title });
});

// API Routes (AJAX)
app.get('/api/admin/tools', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM tools').all()));

app.post('/api/admin/tools', requireAuth, upload.single('thumbFile'), (req, res) => {
    try {
        const { name, desc, link, thumbUrl, status } = req.body;
        let thumb = '/placeholder.png';
        if (req.file) thumb = `/uploads/${req.file.filename}`;
        else if (thumbUrl?.trim()) thumb = thumbUrl.trim();
        
        db.prepare('INSERT INTO tools (name, desc, link, thumb, status) VALUES (?, ?, ?, ?, ?)')
          .run(name, desc, link, thumb, status === 'updating' ? 'updating' : 'stable');
        res.json({ success: true, message: 'Tool added.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tools/edit', requireAuth, upload.single('thumbFile'), (req, res) => {
    try {
        const { id, name, desc, link, thumbUrl, currentThumb, status } = req.body;
        let thumb = currentThumb || '/placeholder.png';
        if (req.file) thumb = `/uploads/${req.file.filename}`;
        else if (thumbUrl?.trim()) thumb = thumbUrl.trim();

        db.prepare('UPDATE tools SET name=?, desc=?, link=?, thumb=?, status=? WHERE id=?')
          .run(name, desc, link, thumb, status === 'updating' ? 'updating' : 'stable', id);
        res.json({ success: true, message: 'Tool updated.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/tools/delete', requireAuth, (req, res) => {
    try {
        const tool = db.prepare('SELECT thumb FROM tools WHERE id = ?').get(req.body.id);
        if (tool?.thumb?.startsWith('/uploads/')) {
            try { fs.unlinkSync(path.join(__dirname, 'public', tool.thumb)); } catch(e) {}
        }
        db.prepare('DELETE FROM tools WHERE id = ?').run(req.body.id);
        res.json({ success: true, message: 'Tool deleted.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/settings', requireAuth, upload.single('logoFile'), (req, res) => {
    try {
        const { site_title, footer_text } = req.body;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_title', site_title);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('footer_text', footer_text);
        if (req.file) {
            const old = getSettings().logo;
            if (old?.startsWith('/uploads/')) try { fs.unlinkSync(path.join(__dirname, 'public', old)); } catch(e) {}
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo', `/uploads/${req.file.filename}`);
        }
        res.redirect('/admin');
    } catch(e) { console.error(e); res.redirect('/admin'); }
});
app.post('/admin/socials', requireAuth, (req, res) => {
    Object.entries(req.body).forEach(([k,v]) => db.prepare('INSERT OR REPLACE INTO socials (platform, link) VALUES (?, ?)').run(k,v));
    res.redirect('/admin');
});
app.post('/admin/password', requireAuth, (req, res) => {
    const { oldPass, newPass } = req.body;
    const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
    if (bcrypt.compareSync(oldPass, admin.password)) {
        db.prepare('UPDATE admin SET password = ? WHERE id = 1').run(bcrypt.hashSync(newPass, 10));
    }
    res.redirect('/admin');
});

app.listen(PORT, () => console.log(`🚀 Warrior Download running on port ${PORT}`));
