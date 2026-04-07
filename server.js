const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const multer   = require('multer');
const QRCode   = require('qrcode');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const USERS_FILE  = path.join(__dirname, 'users.json');
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const JWT_SECRET = process.env.JWT_SECRET || 'live-voting-secret-change-me';
const JWT_EXPIRY = '30d';

function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); } catch { return {users:[]}; } }
function saveUsers(s) { fs.writeFileSync(USERS_FILE, JSON.stringify(s,null,2)); }
function findUser(u) { return loadUsers().users.find(x => x.username.toLowerCase()===u.toLowerCase()); }

const defaultState = () => ({
  questions:[], currentQuestionId:null, broadcastMode:'qr',
  displaySettings:{ showMode:'percentage', layout:'rows', columns:2, showAnswered:true },
  votingOpen:false,
  backgroundSettings:{ type:'transparent', color:'#1a1d2e', imageUrl:null },
  fontSettings:{ family:"'Segoe UI', Arial, sans-serif", sizeScale:1.0, color:'#ffffff', bold:false, italic:false },
  baseUrl:null
});

const userStates = {};
function dataFile(u) { return path.join(DATA_DIR, u.toLowerCase()+'.json'); }
function loadUserState(u) {
  if (userStates[u]) return userStates[u];
  const def = defaultState();
  try {
    const loaded = JSON.parse(fs.readFileSync(dataFile(u),'utf8'));
    userStates[u] = { ...def,...loaded,
      displaySettings:    {...def.displaySettings,    ...(loaded.displaySettings    ||{})},
      backgroundSettings: {...def.backgroundSettings, ...(loaded.backgroundSettings ||{})},
      fontSettings:       {...def.fontSettings,       ...(loaded.fontSettings       ||{})}
    };
  } catch { userStates[u] = {...def}; }
  return userStates[u];
}
function saveUserState(u) { fs.writeFileSync(dataFile(u), JSON.stringify(userStates[u],null,2)); }
function getCurrentQuestion(s) { return s.questions.find(q=>q.id===s.currentQuestionId)||null; }
function getPublicState(s) {
  return { currentQuestion:getCurrentQuestion(s), broadcastMode:s.broadcastMode,
    displaySettings:s.displaySettings, votingOpen:s.votingOpen,
    backgroundSettings:s.backgroundSettings, fontSettings:s.fontSettings, baseUrl:s.baseUrl };
}
const room = u => 'user:'+u.toLowerCase();

const storage = multer.diskStorage({
  destination:(req,file,cb)=>cb(null,UPLOADS_DIR),
  filename:(req,file,cb)=>{ const ext=path.extname(file.originalname); cb(null,(req.user?.username||'anon')+'_bg_'+Date.now()+ext); }
});
const upload = multer({ storage, limits:{fileSize:20*1024*1024}, fileFilter:(req,file,cb)=>{ if(file.mimetype.startsWith('image/'))cb(null,true); else cb(new Error('Images only')); } });

app.set('trust proxy',1);
app.use(express.static(path.join(__dirname,'public')));
app.use(express.json());

function authMiddleware(req,res,next) {
  const token=(req.headers.authorization||'').replace('Bearer ','');
  if(!token) return res.status(401).json({error:'Unauthorized'});
  try { req.user=jwt.verify(token,JWT_SECRET); next(); } catch { res.status(401).json({error:'Invalid token'}); }
}

app.get('/',(req,res)=>res.redirect('/login.html'));
app.get('/u/:username',(req,res)=>res.redirect('/vote.html?user='+encodeURIComponent(req.params.username)));

app.post('/api/auth/register', async (req,res)=>{
  const {username,password,displayName}=req.body;
  if(!username||!password) return res.status(400).json({error:'Username and password required'});
  const clean=username.trim().toLowerCase();
  if(!/^[a-z0-9_]{3,30}$/.test(clean)) return res.status(400).json({error:'Username: 3-30 chars, letters/digits/underscore'});
  if(password.length<6) return res.status(400).json({error:'Password min 6 chars'});
  const store=loadUsers();
  if(store.users.find(u=>u.username.toLowerCase()===clean)) return res.status(409).json({error:'Username already taken'});
  const hashed=await bcrypt.hash(password,10);
  const user={id:uuidv4(),username:clean,displayName:(displayName||clean).trim(),password:hashed,createdAt:new Date().toISOString()};
  store.users.push(user); saveUsers(store);
  const token=jwt.sign({id:user.id,username:user.username,displayName:user.displayName},JWT_SECRET,{expiresIn:JWT_EXPIRY});
  res.json({token,user:{id:user.id,username:user.username,displayName:user.displayName}});
});

app.post('/api/auth/login', async (req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'Username and password required'});
  const user=findUser(username.trim());
  if(!user) return res.status(401).json({error:'Invalid username or password'});
  const ok=await bcrypt.compare(password,user.password);
  if(!ok) return res.status(401).json({error:'Invalid username or password'});
  const token=jwt.sign({id:user.id,username:user.username,displayName:user.displayName},JWT_SECRET,{expiresIn:JWT_EXPIRY});
  res.json({token,user:{id:user.id,username:user.username,displayName:user.displayName}});
});

app.get('/api/auth/me', authMiddleware, (req,res)=>{
  res.json({id:req.user.id,username:req.user.username,displayName:req.user.displayName});
});

app.get('/api/network-info',(req,res)=>{
  const addresses=[{label:'localhost',url:'http://localhost:'+PORT}];
  const ifaces=os.networkInterfaces();
  for(const [name,list] of Object.entries(ifaces))
    for(const iface of list)
      if(iface.family==='IPv4'&&!iface.internal)
        addresses.push({label:name+'  '+iface.address,url:'http://'+iface.address+':'+PORT});
  res.json({addresses,port:PORT});
});

app.get('/api/qr', async (req,res)=>{
  const url=req.query.url; if(!url) return res.status(400).send('Missing url');
  try {
    const buffer=await QRCode.toBuffer(url,{width:parseInt(req.query.size)||300,margin:2,color:{dark:'#ffffff',light:'#0f111e'}});
    res.setHeader('Content-Type','image/png'); res.setHeader('Cache-Control','no-store'); res.send(buffer);
  } catch { res.status(500).send('QR error'); }
});

app.post('/api/upload', authMiddleware, upload.single('image'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  res.json({url:'/uploads/'+req.file.filename});
});

app.post('/api/vote',(req,res)=>{
  const {questionId,optionIds,previousOptionIds,user:username}=req.body;
  if(!username) return res.json({success:false,error:'Missing user'});
  const state=loadUserState(username);
  if(!state.votingOpen) return res.json({success:false,error:'Голосование закрыто'});
  const question=state.questions.find(q=>q.id===questionId);
  if(!question||question.id!==state.currentQuestionId) return res.json({success:false,error:'Вопрос не найден или не активен'});
  const ids=Array.isArray(optionIds)?optionIds:[optionIds];
  if(question.type==='single'&&ids.length>1) return res.json({success:false,error:'Можно выбрать только один вариант'});
  // Decrement previous votes if re-voting
  if(Array.isArray(previousOptionIds)&&previousOptionIds.length>0){
    previousOptionIds.forEach(id=>{ const opt=question.options.find(o=>o.id===id); if(opt&&opt.votes>0) opt.votes-=1; });
  }
  ids.forEach(id=>{ const opt=question.options.find(o=>o.id===id); if(opt) opt.votes+=1; });
  saveUserState(username);
  io.to(room(username)).emit('state_update',getPublicState(state));
  res.json({success:true});
});

io.use((socket,next)=>{
  const {token,publicUser}=socket.handshake.auth;
  if(publicUser) {
    if(findUser(publicUser)) { socket.username=publicUser.toLowerCase(); socket.isPublic=true; return next(); }
    return next(new Error('User not found'));
  }
  if(token) {
    try { const d=jwt.verify(token,JWT_SECRET); socket.username=d.username.toLowerCase(); socket.isPublic=false; return next(); }
    catch { return next(new Error('Invalid token')); }
  }
  next(new Error('Authentication required'));
});

io.on('connection',(socket)=>{
  const u=socket.username;
  socket.join(room(u));
  const s=loadUserState(u);
  socket.emit('state_update',getPublicState(s));
  if(!socket.isPublic) socket.emit('questions_update',s.questions);

  const guard=()=>socket.isPublic;

  socket.on('admin_get_state',()=>{ if(guard())return; socket.emit('admin_state',s); socket.emit('questions_update',s.questions); });
  socket.on('add_question',(d)=>{ if(guard())return; const q={id:uuidv4(),text:d.text||'Новый вопрос',options:[],type:d.type||'single'}; s.questions.push(q); saveUserState(u); io.to(room(u)).emit('questions_update',s.questions); socket.emit('admin_state',s); });
  socket.on('update_question',(d)=>{ if(guard())return; const q=s.questions.find(q=>q.id===d.id); if(q){if(d.text!==undefined)q.text=d.text;if(d.type!==undefined)q.type=d.type;saveUserState(u);io.to(room(u)).emit('questions_update',s.questions);io.to(room(u)).emit('state_update',getPublicState(s));} });
  socket.on('delete_question',(id)=>{ if(guard())return; s.questions=s.questions.filter(q=>q.id!==id); if(s.currentQuestionId===id){s.currentQuestionId=null;s.votingOpen=false;} saveUserState(u); io.to(room(u)).emit('questions_update',s.questions); io.to(room(u)).emit('state_update',getPublicState(s)); socket.emit('admin_state',s); });
  socket.on('add_option',(d)=>{ if(guard())return; const q=s.questions.find(q=>q.id===d.questionId); if(q){q.options.push({id:uuidv4(),text:d.text||'Вариант',votes:0});saveUserState(u);io.to(room(u)).emit('questions_update',s.questions);io.to(room(u)).emit('state_update',getPublicState(s));} });
  socket.on('update_option',(d)=>{ if(guard())return; s.questions.forEach(q=>{const o=q.options.find(o=>o.id===d.id);if(o&&d.text!==undefined)o.text=d.text;}); saveUserState(u); io.to(room(u)).emit('questions_update',s.questions); io.to(room(u)).emit('state_update',getPublicState(s)); });
  socket.on('delete_option',(d)=>{ if(guard())return; const q=s.questions.find(q=>q.id===d.questionId); if(q){q.options=q.options.filter(o=>o.id!==d.optionId);saveUserState(u);io.to(room(u)).emit('questions_update',s.questions);io.to(room(u)).emit('state_update',getPublicState(s));} });
  socket.on('set_current_question',(id)=>{ if(guard())return; s.currentQuestionId=id;s.votingOpen=false;saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('set_voting_open',(open)=>{ if(guard())return; s.votingOpen=open;saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('reset_votes',(qid)=>{ if(guard())return; const q=s.questions.find(q=>q.id===qid); if(q){q.options.forEach(o=>o.votes=0);saveUserState(u);io.to(room(u)).emit('questions_update',s.questions);io.to(room(u)).emit('state_update',getPublicState(s));} });
  socket.on('set_broadcast_mode',(m)=>{ if(guard())return; s.broadcastMode=m;saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('update_display_settings',(d)=>{ if(guard())return; s.displaySettings={...s.displaySettings,...d};saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('update_background_settings',(d)=>{ if(guard())return; s.backgroundSettings={...s.backgroundSettings,...d};saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('set_base_url',(url)=>{ if(guard())return; s.baseUrl=url||null;saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
  socket.on('update_font_settings',(d)=>{ if(guard())return; s.fontSettings={...s.fontSettings,...d};saveUserState(u);io.to(room(u)).emit('state_update',getPublicState(s));socket.emit('admin_state',s); });
});

const PORT=process.env.PORT||8080;
server.listen(PORT,()=>{
  console.log('Server: http://localhost:'+PORT);
  console.log('Login: http://localhost:'+PORT+'/login.html');
});
