require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Persistent Paths (Railway Volume /data mounts here)
const DB_PATH = IS_PROD ? '/data/data.db' : 'data.db';
const BASE_DIR = IS_PROD ? '/data' : path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');
const DOWNLOAD_DIR = path.join(BASE_DIR, 'downloads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'downloadFile' ? DOWNLOAD_DIR : UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-').toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // Faster & safer for concurrent reads

// Safe Schema Init
db.exec(`
    CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, thumb TEXT, status TEXT, visible INTEGER, download_type TEXT, download_value TEXT, downloads INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS socials (platform TEXT PRIMARY KEY, link TEXT);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, password TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Safe Migrations
['visible', 'download_type', 'download_value', 'downloads', 'created_at'].forEach(col => {
    try { db.exec(`ALTER TABLE tools ADD COLUMN ${col} ${col==='visible'?'INTEGER DEFAULT 1': col==='downloads'?'INTEGER DEFAULT 0': col==='created_at'?'DATETIME DEFAULT CURRENT_TIMESTAMP': "TEXT DEFAULT ''"};`); } catch(e){}
});

if (!db.prepare('SELECT id FROM admin').get()) {
    db.prepare('INSERT INTO admin (id, password) VALUES (1, ?)').run(bcrypt.hashSync('admin123', 10));
    ['discord', 'telegram', 'youtube'].forEach(p => db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run(p, '#'));
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('site_title', 'Warrior Download');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('footer_text', 'Secure Tools. Direct Access. No Compromises.');
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('logo', '');    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('maintenance', '0');
}

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOAD_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'warrior_sec_2026',
    resave: false, saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));

const requireAuth = (req, res, next) => req.session.isAdmin ? next() : res.status(401).json({ error: 'Unauthorized' });
const getSettings = () => Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(r => [r.key, r.value]));

// Maintenance Middleware
app.use((req, res, next) => {
    if (!req.path.startsWith('/admin') && !req.path.startsWith('/api') && !req.path.includes('.')) {
        if (getSettings().maintenance === '1') return res.render('maintenance');
    }
    next();
});

// Routes
app.get('/', (req, res) => {
    const tools = db.prepare('SELECT * FROM tools WHERE visible = 1 ORDER BY id DESC').all();
    const socials = db.prepare('SELECT * FROM socials').all();
    res.render('public', { tools, socials, ...getSettings() });
});

app.get('/admin/login', (req, res) => res.render('login'));
app.post('/admin/login', (req, res) => {
    const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
    if (bcrypt.compareSync(req.body.password, admin.password)) { req.session.isAdmin = true; return res.redirect('/admin'); }
    res.render('login', { error: 'Invalid credentials.' });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.get('/admin', requireAuth, (req, res) => {
    const s = getSettings();
    res.render('admin', {
        tools: db.prepare('SELECT * FROM tools ORDER BY id DESC').all(),
        socials: db.prepare('SELECT * FROM socials').all(),
        settings: s, site_title: s.site_title, maintenance: s.maintenance === '1',
        uptime: process.uptime(),
        dbSize: fs.existsSync(DB_PATH) ? (fs.statSync(DB_PATH).size / 1024).toFixed(2) : '0'
    });
});
// APIs
app.get('/api/admin/tools', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM tools ORDER BY id DESC').all()));
app.get('/api/admin/system', requireAuth, (req, res) => {
    res.json({
        tools: db.prepare('SELECT COUNT(*) as c FROM tools').get().c,
        visible: db.prepare('SELECT COUNT(*) as c FROM tools WHERE visible=1').get().c,
        totalDownloads: db.prepare('SELECT SUM(downloads) as t FROM tools').get().t || 0,
        storageUsed: (getDirSize(UPLOAD_DIR) + getDirSize(DOWNLOAD_DIR)).toFixed(2),
        dbSize: (fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size / 1024 : 0).toFixed(2)
    });
});

function getDirSize(dir) {
    if (!fs.existsSync(dir)) return 0;
    let size = 0;
    fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        size += fs.statSync(p).size;
    });
    return size / 1024;
}

app.post('/api/admin/tools', requireAuth, upload.fields([{ name: 'thumbFile', maxCount: 1 }, { name: 'downloadFile', maxCount: 1 }]), (req, res) => {
    try {
        const { name, desc, downloadUrl, status, visible } = req.body;
        let thumb = '/placeholder.png', dlType = 'url', dlValue = downloadUrl || '#';
        if (req.files?.thumbFile?.[0]) thumb = `/uploads/${req.files.thumbFile[0].filename}`;
        if (req.files?.downloadFile?.[0]) { dlType = 'file'; dlValue = `/downloads/${req.files.downloadFile[0].filename}`; }
        db.prepare('INSERT INTO tools (name, desc, thumb, status, visible, download_type, download_value, downloads) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
          .run(name, desc, thumb, status || 'stable', visible ? 1 : 0, dlType, dlValue);
        res.json({ success: true, message: 'Tool added.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tools/update', requireAuth, upload.fields([{ name: 'thumbFile', maxCount: 1 }, { name: 'downloadFile', maxCount: 1 }]), (req, res) => {
    try {
        const { id, name, desc, downloadUrl, currentThumb, currentDownload, status, visible } = req.body;
        let thumb = currentThumb || '/placeholder.png', dlType = req.body.downloadType || 'url', dlValue = downloadUrl || currentDownload || '#';
        if (req.files?.thumbFile?.[0]) thumb = `/uploads/${req.files.thumbFile[0].filename}`;
        if (req.files?.downloadFile?.[0]) { dlType = 'file'; dlValue = `/downloads/${req.files.downloadFile[0].filename}`; }
        db.prepare('UPDATE tools SET name=?, desc=?, thumb=?, status=?, visible=?, download_type=?, download_value=? WHERE id=?')
          .run(name, desc, thumb, status, visible ? 1 : 0, dlType, dlValue, id);
        res.json({ success: true, message: 'Tool updated.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tools/delete', requireAuth, (req, res) => {
    try {
        const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.body.id);        if (tool) {
            if (tool.thumb?.startsWith('/uploads/')) try { fs.unlinkSync(path.join(__dirname, IS_PROD ? '/data' : 'public', tool.thumb)); } catch(e){}
            if (tool.download_type === 'file' && tool.download_value?.startsWith('/downloads/')) try { fs.unlinkSync(path.join(__dirname, IS_PROD ? '/data' : 'public', tool.download_value)); } catch(e){}
            db.prepare('DELETE FROM tools WHERE id = ?').run(req.body.id);
        }
        res.json({ success: true, message: 'Tool deleted.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backup & Import
app.post('/api/admin/backup', requireAuth, (req, res) => {
    try {
        const data = {
            tools: db.prepare('SELECT * FROM tools').all(),
            socials: db.prepare('SELECT * FROM socials').all(),
            settings: db.prepare('SELECT * FROM settings').all()
        };
        res.json({ success: true, data, message: 'Backup generated.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/import', requireAuth, (req, res) => {
    try {
        const { tools, socials, settings } = req.body;
        const stmt = db.transaction(() => {
            db.prepare('DELETE FROM tools').run();
            db.prepare('DELETE FROM socials').run();
            db.prepare('DELETE FROM settings').run();
            if(tools) tools.forEach(t => db.prepare('INSERT INTO tools (id, name, desc, thumb, status, visible, download_type, download_value, downloads, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(t.id, t.name, t.desc, t.thumb, t.status, t.visible, t.download_type, t.download_value, t.downloads, t.created_at));
            if(socials) socials.forEach(s => db.prepare('INSERT OR REPLACE INTO socials (platform, link) VALUES (?,?)').run(s.platform, s.link));
            if(settings) settings.forEach(s => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(s.key, s.value));
        });
        stmt();
        res.json({ success: true, message: 'Data imported successfully.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/toggle-maintenance', requireAuth, (req, res) => {
    const { enabled } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('maintenance', enabled ? '1' : '0');
    res.json({ success: true, maintenance: enabled });
});

app.post('/admin/settings', requireAuth, upload.single('logoFile'), (req, res) => {
    const { site_title, footer_text } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_title', site_title);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('footer_text', footer_text);
    if (req.file) {
        const old = getSettings().logo;
        if (old?.startsWith('/uploads/')) try { fs.unlinkSync(path.join(__dirname, IS_PROD ? '/data' : 'public', old)); } catch(e){}        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo', `/uploads/${req.file.filename}`);
    }
    res.redirect('/admin');
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
