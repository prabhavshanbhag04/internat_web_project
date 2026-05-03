const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'file-manager-secret-key',
  resave: true,
  saveUninitialized: true,
  rolling: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Storage configuration
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fsSync.existsSync(uploadDir)) {
      await fs.mkdir(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  // Return JSON for API/fetch requests, redirect for page requests
  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/check-duplicate') || req.path.startsWith('/bulk-upload') || req.path.startsWith('/versions') || req.path.startsWith('/activity') || req.path.startsWith('/dashboard-stats') || req.path.startsWith('/qr') || req.path.startsWith('/file') || req.path.startsWith('/recycle') || req.path.startsWith('/restore') || req.path.startsWith('/recycle-bin')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

// Routes
app.get('/', isAuthenticated, async (req, res) => {
  const files = await getFileList(req.session.userId);
  const user = await getUserById(req.session.userId);
  res.render('index', { files, user });
});

app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getUserByEmail(email);
  
  if (user && await bcrypt.compare(password, user.password)) {
    req.session.userId = user.id;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Invalid email or password' });
  }
});

app.get('/signup', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  
  if (await getUserByEmail(email)) {
    return res.render('signup', { error: 'Email already exists' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = await createUser({ name, email, password: hashedPassword });
  req.session.userId = userId;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/profile', isAuthenticated, async (req, res) => {
  const user = await getUserById(req.session.userId);
  res.render('profile', { user, success: null, error: null });
});

app.post('/profile', isAuthenticated, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  const user = await getUserById(req.session.userId);
  
  if (newPassword && currentPassword) {
    if (await bcrypt.compare(currentPassword, user.password)) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await updateUser(req.session.userId, { name, email, password: hashedPassword });
      return res.render('profile', { user: { ...user, name, email }, success: 'Profile updated successfully', error: null });
    } else {
      return res.render('profile', { user, success: null, error: 'Current password is incorrect' });
    }
  }
  
  await updateUser(req.session.userId, { name, email });
  res.render('profile', { user: { ...user, name, email }, success: 'Profile updated successfully', error: null });
});

// Check for duplicate before upload
app.post('/check-duplicate', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const { originalname, path: tempPath, size } = req.file;
    const incomingHash = await hashFile(tempPath);

    const metadata = await getFileList(req.session.userId);
    const fileKey = Object.keys(metadata).find(
      k => metadata[k].originalName === originalname
    );

    if (fileKey) {
      const versions = metadata[fileKey].versions;
      if (versions.length > 0) {
        const latestVersion = versions[versions.length - 1];
        const latestPath = path.join('uploads', latestVersion.filename);
        try {
          const latestHash = await hashFile(latestPath);
          if (incomingHash === latestHash) {
            // Clean up temp file
            await fs.unlink(tempPath);
            return res.json({ duplicate: true, filename: originalname });
          }
        } catch {
          // Latest file missing, allow upload
        }
      }
    }

    // Not a duplicate — save the version now since file is already on disk
    await saveFileVersion(req.file, originalname, req.session.userId);
    await logActivity('upload', originalname, req.file.filename, req.session.userId);
    res.json({ duplicate: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk upload with per-file duplicate check
app.post('/bulk-upload', isAuthenticated, upload.array('files', 20), async (req, res) => {
  const results = [];
  for (const file of req.files) {
    try {
      const incomingHash = await hashFile(file.path);
      const metadata = await getFileList(req.session.userId);
      const fileKey = Object.keys(metadata).find(k => metadata[k].originalName === file.originalname);
      let duplicate = false;
      if (fileKey) {
        const versions = metadata[fileKey].versions;
        if (versions.length > 0) {
          try {
            const latestHash = await hashFile(path.join('uploads', versions[versions.length - 1].filename));
            if (incomingHash === latestHash) { await fs.unlink(file.path); duplicate = true; }
          } catch { /* missing, allow */ }
        }
      }
      if (!duplicate) {
        await saveFileVersion(file, file.originalname, req.session.userId);
        await logActivity('upload', file.originalname, file.filename, req.session.userId);
      }
      results.push({ name: file.originalname, duplicate, success: !duplicate });
    } catch (err) {
      results.push({ name: file.originalname, duplicate: false, success: false, error: err.message });
    }
  }
  res.json({ results });
});

app.post('/upload', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const { originalname } = req.file;
    await saveFileVersion(req.file, originalname, req.session.userId);
    await logActivity('upload', originalname, req.file.filename, req.session.userId);
    res.redirect('/');
  } catch (error) {
    res.status(500).send('Upload failed: ' + error.message);
  }
});

app.get('/versions/:filename', isAuthenticated, async (req, res) => {
  const versions = await getFileVersions(req.params.filename, req.session.userId);
  res.json(versions);
});

app.get('/download/:version', isAuthenticated, async (req, res) => {
  const filePath = path.join('uploads', req.params.version);
  res.download(filePath);
});

app.get('/activity', isAuthenticated, async (req, res) => {
  const logs = await getActivityLog(req.session.userId);
  res.json(logs);
});

// Activity Dashboard page
app.get('/dashboard', isAuthenticated, async (req, res) => {
  const user = await getUserById(req.session.userId);
  res.render('dashboard', { user });
});

// Dashboard stats API
app.get('/dashboard-stats', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const files = await getFileList(userId);
    const rawLogs = await getActivityLog(userId);

    // Parse logs into structured objects
    const logs = rawLogs.map(line => {
      const parts = line.split(' | ');
      return parts.length >= 4
        ? { date: parts[0], action: parts[2], filename: parts[3] }
        : null;
    }).filter(Boolean);

    // File type breakdown
    const typeCount = {};
    Object.values(files).forEach(f => {
      const ext = f.originalName.split('.').pop().toLowerCase();
      const group = getFileGroup(ext);
      typeCount[group] = (typeCount[group] || 0) + 1;
    });

    // Uploads per day (last 7 days)
    const uploadsPerDay = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      uploadsPerDay[d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })] = 0;
    }
    logs.filter(l => l.action === 'upload').forEach(l => {
      const d = new Date(l.date);
      const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (key in uploadsPerDay) uploadsPerDay[key]++;
    });

    // Recent uploads (last 8)
    const recentUploads = logs.filter(l => l.action === 'upload').slice(0, 8);

    // Recent edits = uploads to existing files (version > 1)
    const recentEdits = [];
    Object.values(files).forEach(f => {
      if (f.versions.length > 1) {
        recentEdits.push({
          filename: f.originalName,
          versions: f.versions.length,
          lastEdit: f.versions[f.versions.length - 1].uploadDate
        });
      }
    });
    recentEdits.sort((a, b) => new Date(b.lastEdit) - new Date(a.lastEdit));

    // Top files by version count
    const topFiles = Object.values(files)
      .sort((a, b) => b.versions.length - a.versions.length)
      .slice(0, 5)
      .map(f => ({ name: f.originalName, versions: f.versions.length, size: f.versions.reduce((s, v) => s + v.size, 0) }));

    // Action breakdown
    const actionCount = {};
    logs.forEach(l => { actionCount[l.action] = (actionCount[l.action] || 0) + 1; });

    res.json({
      totalFiles: Object.keys(files).length,
      totalVersions: Object.values(files).reduce((s, f) => s + f.versions.length, 0),
      totalStorage: Object.values(files).reduce((s, f) => s + f.versions.reduce((a, v) => a + v.size, 0), 0),
      totalActions: logs.length,
      typeCount,
      uploadsPerDay,
      recentUploads,
      recentEdits: recentEdits.slice(0, 8),
      topFiles,
      actionCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getFileGroup(ext) {
  if (['pdf','doc','docx','txt','csv','xls','xlsx','ppt','pptx'].includes(ext)) return 'Documents';
  if (['jpg','jpeg','png','gif','svg','webp'].includes(ext)) return 'Images';
  if (['mp4','mov','avi','mkv'].includes(ext)) return 'Videos';
  if (['mp3','wav','aac'].includes(ext)) return 'Audio';
  if (['zip','rar','7z'].includes(ext)) return 'Archives';
  if (['js','ts','py','html','css','json','java','cpp','c'].includes(ext)) return 'Code';
  return 'Other';
}

// Generate QR code for latest version of a file
app.get('/qr/:filename', isAuthenticated, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const versions = await getFileVersions(filename, req.session.userId);

    if (!versions.versions || versions.versions.length === 0) {
      return res.status(404).json({ error: 'No versions found' });
    }

    const latest = versions.versions[versions.versions.length - 1];
    const downloadUrl = `${req.protocol}://${req.get('host')}/download/${latest.filename}`;
    const qrDataUrl = await QRCode.toDataURL(downloadUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#6366f1', light: '#ffffff' }
    });

    res.json({ qr: qrDataUrl, url: downloadUrl, filename });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recycle Bin page
app.get('/recycle-bin', isAuthenticated, async (req, res) => {
  const user = await getUserById(req.session.userId);
  res.render('recycle', { user });
});

// ── Recycle Bin routes ────────────────────────────────────────

// Move file to recycle bin
app.delete('/file/:filename', isAuthenticated, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userId = req.session.userId;
    const fileKey = `${userId}_${filename}`;

    const metadataPath = 'metadata.json';
    const data = await fs.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(data);

    if (!metadata[fileKey]) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Add to recycle bin
    const recycle = await getRecycleBin(userId);
    recycle[fileKey] = {
      ...metadata[fileKey],
      deletedAt: new Date().toISOString()
    };
    await saveRecycleBin(userId, recycle);

    // Remove from active metadata
    delete metadata[fileKey];
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    await logActivity('delete', filename, '-', userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recycle bin contents
app.get('/recycle', isAuthenticated, async (req, res) => {
  const bin = await getRecycleBin(req.session.userId);
  res.json(bin);
});

// Restore file from recycle bin
app.post('/restore/:filename', isAuthenticated, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userId = req.session.userId;
    const fileKey = `${userId}_${filename}`;

    const recycle = await getRecycleBin(userId);
    if (!recycle[fileKey]) {
      return res.status(404).json({ error: 'File not found in recycle bin' });
    }

    // Restore to active metadata
    const metadataPath = 'metadata.json';
    let metadata = {};
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(data);
    } catch {}

    const { deletedAt, ...fileData } = recycle[fileKey];
    metadata[fileKey] = fileData;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Remove from recycle bin
    delete recycle[fileKey];
    await saveRecycleBin(userId, recycle);

    await logActivity('restore', filename, '-', userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Permanently delete from recycle bin
app.delete('/recycle/:filename', isAuthenticated, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userId = req.session.userId;
    const fileKey = `${userId}_${filename}`;

    const recycle = await getRecycleBin(userId);
    if (!recycle[fileKey]) {
      return res.status(404).json({ error: 'File not found in recycle bin' });
    }

    // Delete all physical version files
    for (const version of recycle[fileKey].versions) {
      try {
        await fs.unlink(path.join('uploads', version.filename));
      } catch { /* file may already be missing */ }
    }

    delete recycle[fileKey];
    await saveRecycleBin(userId, recycle);

    await logActivity('permanent-delete', filename, '-', userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Helper functions
async function getUsersData() {
  const usersPath = 'users.json';
  try {
    const data = await fs.readFile(usersPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveUsersData(users) {
  await fs.writeFile('users.json', JSON.stringify(users, null, 2));
}

async function getUserByEmail(email) {
  const users = await getUsersData();
  return users.find(u => u.email === email);
}

async function getUserById(id) {
  const users = await getUsersData();
  return users.find(u => u.id === id);
}

async function createUser(userData) {
  const users = await getUsersData();
  const newUser = {
    id: Date.now().toString(),
    ...userData,
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  await saveUsersData(users);
  return newUser.id;
}

async function updateUser(userId, updates) {
  const users = await getUsersData();
  const index = users.findIndex(u => u.id === userId);
  if (index !== -1) {
    users[index] = { ...users[index], ...updates };
    await saveUsersData(users);
  }
}

async function getFileList(userId) {
  const metadataPath = 'metadata.json';
  try {
    const data = await fs.readFile(metadataPath, 'utf8');
    const allFiles = JSON.parse(data);
    const userFiles = {};
    for (let [filename, fileData] of Object.entries(allFiles)) {
      if (fileData.userId === userId) {
        userFiles[filename] = fileData;
      }
    }
    return userFiles;
  } catch {
    return {};
  }
}

async function saveFileVersion(file, originalName, userId) {
  const metadataPath = 'metadata.json';
  let metadata = {};
  try {
    const data = await fs.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(data);
  } catch {}
  
  const fileKey = `${userId}_${originalName}`;
  
  if (!metadata[fileKey]) {
    metadata[fileKey] = {
      originalName,
      userId,
      versions: []
    };
  }
  
  metadata[fileKey].versions.push({
    filename: file.filename,
    uploadDate: new Date().toISOString(),
    size: file.size
  });
  
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

async function getFileVersions(filename, userId) {
  const metadataPath = 'metadata.json';
  try {
    const data = await fs.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(data);
    const fileKey = `${userId}_${filename}`;
    return metadata[fileKey] || { versions: [] };
  } catch {
    return { versions: [] };
  }
}

async function logActivity(action, originalName, filename, userId) {
  const logPath = 'activity.log';
  const logEntry = `${new Date().toISOString()} | ${userId} | ${action} | ${originalName} | ${filename}\n`;
  await fs.appendFile(logPath, logEntry);
}

async function getActivityLog(userId) {
  try {
    const data = await fs.readFile('activity.log', 'utf8');
    return data.split('\n')
      .filter(line => line && line.includes(`| ${userId} |`))
      .reverse()
      .slice(0, 50);
  } catch {
    return [];
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function getRecycleBin(userId) {
  try {
    const data = await fs.readFile('recycle.json', 'utf8');
    const all = JSON.parse(data);
    // Return only this user's deleted files
    const userBin = {};
    for (const [key, val] of Object.entries(all)) {
      if (val.userId === userId) userBin[key] = val;
    }
    return userBin;
  } catch {
    return {};
  }
}

async function saveRecycleBin(userId, userBin) {
  let all = {};
  try {
    const data = await fs.readFile('recycle.json', 'utf8');
    all = JSON.parse(data);
  } catch {}
  // Remove old entries for this user, then merge updated ones
  for (const key of Object.keys(all)) {
    if (all[key].userId === userId) delete all[key];
  }
  Object.assign(all, userBin);
  await fs.writeFile('recycle.json', JSON.stringify(all, null, 2));
}
