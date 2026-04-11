const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const db = new Database('data.db');
const PORT = process.env.PORT || 3000;

// DB Tables Init
db.exec(`
  CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, link TEXT, img TEXT);
  CREATE TABLE IF NOT EXISTS socials (platform TEXT PRIMARY KEY, link TEXT);
  CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, password TEXT);
`);

// Default Admin Password: admin123 (hashed)
const adminExists = db.prepare('SELECT id FROM admin').get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admin (id, password) VALUES (1, ?)').run(hash);
  // Default Socials
  db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run('discord', '#');
  db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run('telegram', '#');
  db.prepare('INSERT OR IGNORE INTO socials (platform, link) VALUES (?, ?)').run('youtube', '#');
}

// Middleware
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'warrior_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

// Routes
app.get('/', (req, res) => {
  const tools = db.prepare('SELECT * FROM tools').all();  const socials = db.prepare('SELECT * FROM socials').all();
  res.render('public', { tools, socials, title: 'Warrior Download' });
});

app.get('/admin/login', (req, res) => res.render('login'));

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
  if (bcrypt.compareSync(password, admin.password)) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Galat password!' });
});

app.get('/admin', requireAuth, (req, res) => {
  const tools = db.prepare('SELECT * FROM tools').all();
  const socials = db.prepare('SELECT * FROM socials').all();
  res.render('admin', { tools, socials });
});

app.post('/admin/add-tool', requireAuth, (req, res) => {
  const { name, desc, link, img } = req.body;
  db.prepare('INSERT INTO tools (name, desc, link, img) VALUES (?, ?, ?, ?)').run(name, desc, link, img || '/placeholder.png');
  res.redirect('/admin');
});

app.post('/admin/delete-tool', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tools WHERE id = ?').run(req.body.id);
  res.redirect('/admin');
});

app.post('/admin/update-social', requireAuth, (req, res) => {
  for (const [platform, link] of Object.entries(req.body)) {
    if (platform !== '_method') {
      db.prepare('INSERT OR REPLACE INTO socials (platform, link) VALUES (?, ?)').run(platform, link);
    }
  }
  res.redirect('/admin');
});

app.post('/admin/change-password', requireAuth, (req, res) => {
  const { oldPass, newPass } = req.body;
  const admin = db.prepare('SELECT password FROM admin WHERE id = 1').get();
  if (bcrypt.compareSync(oldPass, admin.password)) {
    const hash = bcrypt.hashSync(newPass, 10);
    db.prepare('UPDATE admin SET password = ? WHERE id = 1').run(hash);
    res.redirect('/admin');
  } else {    res.render('admin', { tools: db.prepare('SELECT * FROM tools').all(), socials: db.prepare('SELECT * FROM socials').all(), error: 'Old password galat hai!' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Warrior Download running on port ${PORT}`));
