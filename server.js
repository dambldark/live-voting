const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `bg_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Default state
const defaultState = {
  questions: [],
  currentQuestionId: null,
  broadcastMode: 'qr',
  displaySettings: {
    showMode: 'percentage',
    layout: 'rows',
    columns: 2,
    showAnswered: true
  },
  votingOpen: false,
  backgroundSettings: {
    type: 'transparent',
    color: '#1a1d2e',
    imageUrl: null
  },
  fontSettings: {
    family: 'Segoe UI, Arial, sans-serif',
    sizeScale: 1.0,
    color: '#ffffff',
    bold: false,
    italic: false
  },
  baseUrl: null
};

let state = { ...defaultState };
if (fs.existsSync(DATA_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = {
      ...defaultState,
      ...loaded,
      displaySettings: { ...defaultState.displaySettings, ...(loaded.displaySettings || {}) },
      backgroundSettings: { ...defaultState.backgroundSettings, ...(loaded.backgroundSettings || {}) },
      fontSettings: { ...defaultState.fontSettings, ...(loaded.fontSettings || {}) }
    };
  } catch (e) {
    state = { ...defaultState };
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function getCurrentQuestion() {
  return state.questions.find(q => q.id === state.currentQuestionId) || null;
}

function getPublicState() {
  return {
    currentQuestion: getCurrentQuestion(),
    broadcastMode: state.broadcastMode,
    displaySettings: state.displaySettings,
    votingOpen: state.votingOpen,
    backgroundSettings: state.backgroundSettings,
    fontSettings: state.fontSettings,
    baseUrl: state.baseUrl
  };
}

app.set('trust proxy', 1); // Behind nginx
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

app.get('/vote', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vote.html'));
});

// Network info
app.get('/api/network-info', (req, res) => {
  const addresses = [{ label: 'localhost', url: `http://localhost:${PORT}` }];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ label: `${name}  ${iface.address}`, url: `http://${iface.address}:${PORT}` });
      }
    }
  }
  res.json({ addresses, port: PORT });
});

// QR code image endpoint
app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const buffer = await QRCode.toBuffer(url, {
      width: parseInt(req.query.size) || 300,
      margin: 2,
      color: { dark: '#ffffff', light: '#0f111e' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

// Image upload
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  res.json({ url });
});

// Submit vote
app.post('/api/vote', (req, res) => {
  const { questionId, optionIds } = req.body;
  if (!state.votingOpen) return res.json({ success: false, error: 'Голосование закрыто' });

  const question = state.questions.find(q => q.id === questionId);
  if (!question || question.id !== state.currentQuestionId)
    return res.json({ success: false, error: 'Вопрос не найден или не активен' });

  const ids = Array.isArray(optionIds) ? optionIds : [optionIds];
  if (question.type === 'single' && ids.length > 1)
    return res.json({ success: false, error: 'Можно выбрать только один вариант' });

  ids.forEach(optId => {
    const opt = question.options.find(o => o.id === optId);
    if (opt) opt.votes += 1;
  });

  saveState();
  io.emit('state_update', getPublicState());
  res.json({ success: true });
});

io.on('connection', (socket) => {
  socket.emit('state_update', getPublicState());
  socket.emit('questions_update', state.questions);

  socket.on('admin_get_state', () => {
    socket.emit('admin_state', state);
    socket.emit('questions_update', state.questions);
  });

  socket.on('add_question', (data) => {
    const question = { id: uuidv4(), text: data.text || 'Новый вопрос', options: [], type: data.type || 'single' };
    state.questions.push(question);
    saveState();
    io.emit('questions_update', state.questions);
    socket.emit('admin_state', state);
  });

  socket.on('update_question', (data) => {
    const q = state.questions.find(q => q.id === data.id);
    if (q) {
      if (data.text !== undefined) q.text = data.text;
      if (data.type !== undefined) q.type = data.type;
      saveState();
      io.emit('questions_update', state.questions);
      io.emit('state_update', getPublicState());
    }
  });

  socket.on('delete_question', (id) => {
    state.questions = state.questions.filter(q => q.id !== id);
    if (state.currentQuestionId === id) { state.currentQuestionId = null; state.votingOpen = false; }
    saveState();
    io.emit('questions_update', state.questions);
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('add_option', (data) => {
    const q = state.questions.find(q => q.id === data.questionId);
    if (q) {
      q.options.push({ id: uuidv4(), text: data.text || 'Вариант', votes: 0 });
      saveState();
      io.emit('questions_update', state.questions);
      io.emit('state_update', getPublicState());
    }
  });

  socket.on('update_option', (data) => {
    state.questions.forEach(q => {
      const opt = q.options.find(o => o.id === data.id);
      if (opt && data.text !== undefined) opt.text = data.text;
    });
    saveState();
    io.emit('questions_update', state.questions);
    io.emit('state_update', getPublicState());
  });

  socket.on('delete_option', (data) => {
    const q = state.questions.find(q => q.id === data.questionId);
    if (q) {
      q.options = q.options.filter(o => o.id !== data.optionId);
      saveState();
      io.emit('questions_update', state.questions);
      io.emit('state_update', getPublicState());
    }
  });

  socket.on('set_current_question', (id) => {
    state.currentQuestionId = id;
    state.votingOpen = false;
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('set_voting_open', (open) => {
    state.votingOpen = open;
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('reset_votes', (questionId) => {
    const q = state.questions.find(q => q.id === questionId);
    if (q) {
      q.options.forEach(o => o.votes = 0);
      saveState();
      io.emit('questions_update', state.questions);
      io.emit('state_update', getPublicState());
    }
  });

  socket.on('set_broadcast_mode', (mode) => {
    state.broadcastMode = mode;
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('update_display_settings', (settings) => {
    state.displaySettings = { ...state.displaySettings, ...settings };
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('update_background_settings', (settings) => {
    state.backgroundSettings = { ...state.backgroundSettings, ...settings };
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('set_base_url', (url) => {
    state.baseUrl = url || null;
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });

  socket.on('update_font_settings', (settings) => {
    state.fontSettings = { ...state.fontSettings, ...settings };
    saveState();
    io.emit('state_update', getPublicState());
    socket.emit('admin_state', state);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`   Управление:  http://localhost:${PORT}/admin.html`);
  console.log(`   Эфир:        http://localhost:${PORT}/broadcast.html`);
  console.log(`   Голосование: http://localhost:${PORT}/vote\n`);
});
