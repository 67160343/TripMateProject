require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET is required and must be at least 32 characters. Set it in your local .env file.');
}
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Safe additive migration for existing databases; does not reset or delete payment records.
const paymentSchemaReady = pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS slip_path TEXT');
const activitySchemaReady = pool.query('ALTER TABLE activities ADD COLUMN IF NOT EXISTS google_maps_url TEXT');
// Additive checkpoint migration for existing volumes; never resets trip data.
const checkpointSchemaReady = pool.query(`CREATE TABLE IF NOT EXISTS checkpoints (id SERIAL PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE, name TEXT NOT NULL, google_maps_url TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
checkpointSchemaReady.then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_checkpoints_trip_order ON checkpoints(trip_id, sort_order, id)')).catch(err => console.error('Checkpoint schema migration failed:', err.message));

// Additive password_resets migration
const resetSchemaReady = pool.query(`CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, token VARCHAR(255) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
resetSchemaReady.catch(err => console.error('Password resets schema migration failed:', err.message));

// Nodemailer Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500').split(',').map(x => x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(cors({ origin(origin, callback) {
  // Requests without Origin include curl and server-to-server calls.
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed by CORS'));
} }));
app.use(express.json({ limit: '1mb' }));

// Payment slips are private files: never expose the uploads folder as public static content.
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
fs.mkdirSync(uploadDir, { recursive: true });
const slipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) return cb(new Error('INVALID_SLIP_TYPE'));
    cb(null, true);
  }
});
const slipExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const asyncHandler = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const publicUser = r => ({ id:r.id, username:r.username, email:r.email, display_name:r.display_name, avatar_url:r.avatar_url, created_at:r.created_at });
// Directory/profile responses omit email; only the signed-in user's own profile exposes it.
const directoryUser = r => ({ id:r.id, username:r.username, display_name:r.display_name, avatar_url:r.avatar_url, created_at:r.created_at });
function signToken(user, sessionId){ return jwt.sign({ sub:user.id, username:user.username, sid:sessionId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }); }

async function auth(req,res,next){
  try {
    const h=req.headers.authorization||'';
    if(!h.startsWith('Bearer ')) return res.status(401).json({error:'UNAUTHORIZED',message:'Bearer token required'});
    const decoded=jwt.verify(h.slice(7), JWT_SECRET);
    const s=await pool.query('SELECT * FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW()',[decoded.sid,decoded.sub]);
    if(!s.rowCount) return res.status(401).json({error:'SESSION_EXPIRED',message:'Session is invalid or expired'});
    const u=await pool.query('SELECT * FROM users WHERE id=$1',[decoded.sub]);
    if(!u.rowCount) return res.status(401).json({error:'USER_NOT_FOUND',message:'User no longer exists'});
    req.user=u.rows[0]; req.session=s.rows[0]; next();
  } catch(e){ return res.status(401).json({error:'INVALID_TOKEN',message:'Invalid or expired token'}); }
}
async function tripAccess(req,res,next){
  const id=Number(req.params.id||req.params.tripId); if(!Number.isInteger(id)) return res.status(400).json({error:'INVALID_ID'});
  const q=await pool.query(`SELECT t.*, CASE WHEN t.owner_id=$2 THEN 'owner' ELSE tm.role END AS role, CASE WHEN t.owner_id=$2 THEN 'joined' ELSE tm.status END AS status FROM trips t LEFT JOIN trip_members tm ON tm.trip_id=t.id AND tm.user_id=$2 WHERE t.id=$1 AND (t.owner_id=$2 OR (tm.user_id=$2 AND tm.status='joined'))`,[id,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:'TRIP_NOT_FOUND_OR_FORBIDDEN',message:'Trip not found or you are not a member'});
  req.trip=q.rows[0]; next();
}
function isGoogleMapsUrl(value){try{const u=new URL(value);return u.protocol==='https:' && ['google.com','www.google.com','maps.google.com','maps.app.goo.gl','goo.gl'].includes(u.hostname) && (u.hostname!=='goo.gl'||u.pathname.startsWith('/maps'));}catch{return false;}}
function isWebUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol);}catch{return false;}}
function validateDateRange(start,end){ const s=new Date(start+'T00:00:00'), e=new Date(end+'T00:00:00'), today=new Date(); today.setHours(0,0,0,0); return {valid:start&&end&&!Number.isNaN(s.getTime())&&!Number.isNaN(e.getTime())&&s>=today&&e>=s}; }

app.get('/health',(req,res)=>res.json({status:'ok',service:'tripmate-api',time:new Date().toISOString()}));

// Hotel discovery uses external Google Maps/Booking.com search links in the frontend; no paid hotel API key is required.

// Authentication
app.post('/api/auth/register', asyncHandler(async(req,res)=>{
  const body=req.body||{}; const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  const password=typeof body.password==='string'?body.password:'';
  const display_name=typeof body.display_name==='string'?body.display_name.trim():'';
  if(!username||!email||!password||!display_name)return res.status(400).json({error:'VALIDATION_ERROR',message:'username, email, password and display_name are required'});
  if(!/^[a-z0-9_.-]{3,50}$/.test(username))return res.status(400).json({error:'INVALID_USERNAME',message:'Username must be 3-50 characters and contain only letters, numbers, dot, underscore or hyphen'});
  if(email.length>120||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'INVALID_EMAIL',message:'Please provide a valid email address'});
  if(password.length<8||password.length>128)return res.status(400).json({error:'WEAK_PASSWORD',message:'Password must be between 8 and 128 characters'});
  if(display_name.length>100)return res.status(400).json({error:'INVALID_DISPLAY_NAME',message:'display_name must be at most 100 characters'});
  const hash=await bcrypt.hash(password,12);
  try {
    const u=(await pool.query('INSERT INTO users(username,email,password_hash,display_name) VALUES($1,$2,$3,$4) RETURNING *',[username,email,hash,display_name])).rows[0];
    const sid=crypto.randomUUID(); await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[sid,u.id]);
    res.status(201).json({user:publicUser(u),token:signToken(u,sid),token_type:'Bearer'});
  } catch(e){if(e.code==='23505')return res.status(409).json({error:'DUPLICATE_USER',message:'Username or email already exists'});throw e;}
}));

app.post('/api/auth/login', asyncHandler(async(req,res)=>{
  const {login,password}=req.body||{};
  if(typeof login!=='string'||typeof password!=='string'||!login.trim()||!password)return res.status(400).json({error:'VALIDATION_ERROR',message:'login and password are required'});
  const normalized=login.trim().toLowerCase();
  const q=await pool.query('SELECT * FROM users WHERE LOWER(username)=$1 OR LOWER(email)=$1',[normalized]);
  if(!q.rowCount||!(await bcrypt.compare(password,q.rows[0].password_hash)))return res.status(401).json({error:'INVALID_CREDENTIALS',message:'Invalid login or password'});
  const u=q.rows[0],sid=crypto.randomUUID(); await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[sid,u.id]);
  res.json({user:publicUser(u),token:signToken(u,sid),token_type:'Bearer'});
}));
app.post('/api/auth/logout',auth,asyncHandler(async(req,res)=>{await pool.query('UPDATE sessions SET revoked_at=NOW() WHERE id=$1',[req.session.id]);res.json({message:'Logged out'});}));
app.post('/api/auth/change-password',auth,asyncHandler(async(req,res)=>{
  const {current_password,new_password}=req.body||{};
  if(typeof current_password!=='string'||typeof new_password!=='string'||new_password.length<8||new_password.length>128)return res.status(400).json({error:'VALIDATION_ERROR',message:'Current password and a new password of 8-128 characters are required'});
  if(!(await bcrypt.compare(current_password,req.user.password_hash)))return res.status(400).json({error:'WRONG_PASSWORD',message:'Current password is incorrect'});
  if(await bcrypt.compare(new_password,req.user.password_hash))return res.status(400).json({error:'PASSWORD_UNCHANGED',message:'New password must be different from current password'});
  const h=await bcrypt.hash(new_password,12); const c=await pool.connect();
  try {await c.query('BEGIN');await c.query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[h,req.user.id]);await c.query('UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id]);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  res.json({message:'Password changed. All sessions have been logged out; please login again.'});
}));

// Forgot Password / Reset Password
app.post('/api/auth/forgot-password', asyncHandler(async(req, res) => {
  const { email } = req.body || {};
  if(!email) return res.status(400).json({error: 'VALIDATION_ERROR', message: 'กรุณากรอกอีเมล'});

  const u = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if(u.rowCount > 0) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query("INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')", [email.toLowerCase(), token]);

    const resetLink = `http://localhost:5500/reset-password.html?token=${token}`;
    
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'TripMate - รีเซ็ตรหัสผ่านของคุณ',
      html: `<p>คุณได้ขอรีเซ็ตรหัสผ่าน กรุณากดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ (ลิงก์มีอายุ 1 ชั่วโมง):</p>
             <a href="${resetLink}">ตั้งรหัสผ่านใหม่คลิกที่นี่</a>`
    });
  }
  res.json({ message: 'หากอีเมลนี้อยู่ในระบบ ลิงก์รีเซ็ตรหัสผ่านได้ถูกส่งไปแล้ว' });
}));

app.post('/api/auth/reset-password', asyncHandler(async(req, res) => {
  const { token, new_password } = req.body || {};
  if(!token || !new_password || new_password.length < 8) return res.status(400).json({error: 'VALIDATION_ERROR', message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร'});

  const q = await pool.query('SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW()', [token]);
  if(!q.rowCount) return res.status(400).json({error: 'INVALID_TOKEN', message: 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว'});

  const email = q.rows[0].email;
  const hash = await bcrypt.hash(new_password, 12);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const userQ = await c.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE email=$2 RETURNING id', [hash, email]);
    if(userQ.rowCount > 0) await c.query('UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [userQ.rows[0].id]);
    await c.query('DELETE FROM password_resets WHERE email=$1', [email]);
    await c.query('COMMIT');
  } catch(e) {
    await c.query('ROLLBACK'); throw e;
  } finally { c.release(); }
  res.json({ message: 'เปลี่ยนรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่' });
}));

// User management: users can view the directory, but only edit or delete their own account.
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.get('/api/check-username/:name',asyncHandler(async(req,res)=>{const name=String(req.params.name||'').trim();const q=await pool.query('SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)',[name]);res.json({username:name,available:!q.rowCount});}));
app.get('/api/users',auth,asyncHandler(async(req,res)=>{
  const pageRaw=req.query.page===undefined?'1':String(req.query.page), limitRaw=req.query.limit===undefined?'20':String(req.query.limit);
  if(!/^\d+$/.test(pageRaw)||Number(pageRaw)<1)return res.status(400).json({error:'INVALID_PAGE',message:'page must be a positive integer'});
  if(!/^\d+$/.test(limitRaw)||Number(limitRaw)<1||Number(limitRaw)>100)return res.status(400).json({error:'INVALID_LIMIT',message:'limit must be an integer between 1 and 100'});
  const page=Number(pageRaw),limit=Number(limitRaw),offset=(page-1)*limit;
  if(!Number.isSafeInteger(offset))return res.status(400).json({error:'INVALID_PAGE',message:'page is too large'});
  const search=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
  const pattern=`%${search}%`;
  const [rows,count]=await Promise.all([
    pool.query("SELECT id,username,display_name,avatar_url,created_at FROM users WHERE ($1='' OR username ILIKE $2 OR display_name ILIKE $2) ORDER BY id DESC LIMIT $3 OFFSET $4",[search,pattern,limit,offset]),
    pool.query("SELECT COUNT(*)::int AS total FROM users WHERE ($1='' OR username ILIKE $2 OR display_name ILIKE $2)",[search,pattern])
  ]);
  const total=count.rows[0].total,total_pages=Math.ceil(total/limit);
  res.json({data:rows.rows,pagination:{page,limit,total,total_pages,has_previous:page>1,has_next:page<total_pages}});
}));
app.get('/api/users/:id',auth,asyncHandler(async(req,res)=>{
  if(!/^\d+$/.test(String(req.params.id))||Number(req.params.id)<1)return res.status(400).json({error:'INVALID_USER_ID'});
  const q=await pool.query('SELECT id,username,email,display_name,avatar_url,created_at,updated_at FROM users WHERE id=$1',[Number(req.params.id)]);
  if(!q.rowCount)return res.status(404).json({error:'USER_NOT_FOUND'});
  const u=q.rows[0]; if(Number(req.params.id)!==req.user.id)delete u.email;
  res.json({user:u});
}));
app.put('/api/users/:id',auth,asyncHandler(async(req,res)=>{
  if(!/^\d+$/.test(String(req.params.id))||Number(req.params.id)<1)return res.status(400).json({error:'INVALID_USER_ID'});
  if(Number(req.params.id)!==req.user.id)return res.status(403).json({error:'FORBIDDEN',message:'You can only update your own account'});
  const body=req.body||{}; const displayName=body.display_name===undefined?null:(typeof body.display_name==='string'?body.display_name.trim():null);
  const email=body.email===undefined?null:(typeof body.email==='string'?body.email.trim().toLowerCase():null);
  const avatarUrl=body.avatar_url===undefined?null:(body.avatar_url===null?null:(typeof body.avatar_url==='string'?body.avatar_url.trim():null));
  if(body.display_name!==undefined&&(!displayName||displayName.length>100))return res.status(400).json({error:'INVALID_DISPLAY_NAME'});
  if(body.email!==undefined&&(!email||email.length>120||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return res.status(400).json({error:'INVALID_EMAIL'});
  if(body.avatar_url!==undefined&&avatarUrl!==null&&avatarUrl&&!isWebUrl(avatarUrl))return res.status(400).json({error:'INVALID_AVATAR_URL'});
  try {
    const q=await pool.query('UPDATE users SET display_name=COALESCE($1,display_name),email=COALESCE($2,email),avatar_url=$3,updated_at=NOW() WHERE id=$4 RETURNING *',[displayName,email,body.avatar_url===undefined?req.user.avatar_url:avatarUrl,req.user.id]);
    res.json({user:publicUser(q.rows[0])});
  } catch(e){if(e.code==='23505')return res.status(409).json({error:'DUPLICATE_EMAIL',message:'Email already exists'});throw e;}
}));
app.delete('/api/users/:id',auth,asyncHandler(async(req,res)=>{
  if(!/^\d+$/.test(String(req.params.id))||Number(req.params.id)<1)return res.status(400).json({error:'INVALID_USER_ID'});
  if(Number(req.params.id)!==req.user.id)return res.status(403).json({error:'FORBIDDEN',message:'You can only delete your own account'});
  const {password}=req.body||{};
  if(typeof password!=='string'||!password)return res.status(400).json({error:'PASSWORD_REQUIRED',message:'Provide your current password to delete your account'});
  if(!(await bcrypt.compare(password,req.user.password_hash)))return res.status(400).json({error:'WRONG_PASSWORD',message:'Password is incorrect'});
  await pool.query('DELETE FROM users WHERE id=$1',[req.user.id]);
  res.json({message:'Account deleted'});
}));

// Trips
app.post('/api/trips',auth,asyncHandler(async(req,res)=>{const {name,destination,start_date,end_date,description,fund_target}=req.body||{};const d=validateDateRange(start_date,end_date);if(!name||!destination||!d.valid)return res.status(400).json({error:'INVALID_TRIP_DATES',message:'Trip name, destination and valid future date range are required. End date must be on/after start date.'});const c=await pool.connect();try{await c.query('BEGIN');const t=(await c.query('INSERT INTO trips(owner_id,name,destination,start_date,end_date,description,fund_target) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.user.id,name,destination,start_date,end_date,description||null,Number(fund_target)||0])).rows[0];await c.query("INSERT INTO trip_members(trip_id,user_id,role,status) VALUES($1,$2,'owner','joined')",[t.id,req.user.id]);await c.query('COMMIT');res.status(201).json({trip:t});}catch(e){await c.query('ROLLBACK');throw e}finally{c.release();}}));
app.get('/api/trips',auth,asyncHandler(async(req,res)=>{const q=await pool.query(`SELECT DISTINCT t.*, CASE WHEN t.owner_id=$1 THEN 'owner' ELSE tm.role END role FROM trips t LEFT JOIN trip_members tm ON tm.trip_id=t.id AND tm.user_id=$1 WHERE t.owner_id=$1 OR tm.user_id=$1 ORDER BY t.start_date`,[req.user.id]);res.json({data:q.rows});}));
app.get('/api/trips/:id',auth,tripAccess,asyncHandler(async(req,res)=>{await Promise.all([activitySchemaReady,checkpointSchemaReady]);const [members,activities,accommodations,payments,checkpoints]=await Promise.all([pool.query('SELECT u.id,u.username,u.display_name,tm.role,tm.status,tm.joined_at FROM trip_members tm JOIN users u ON u.id=tm.user_id WHERE tm.trip_id=$1 ORDER BY tm.role DESC,u.display_name',[req.trip.id]),pool.query('SELECT * FROM activities WHERE trip_id=$1 ORDER BY activity_date,start_time NULLS LAST,id',[req.trip.id]),pool.query('SELECT * FROM accommodations WHERE trip_id=$1 ORDER BY check_in',[req.trip.id]),pool.query('SELECT p.*,u.display_name FROM payments p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 ORDER BY p.paid_at DESC',[req.trip.id]),pool.query('SELECT * FROM checkpoints WHERE trip_id=$1 ORDER BY sort_order,id',[req.trip.id])]);res.json({trip:req.trip,members:members.rows,activities:activities.rows,accommodations:accommodations.rows,payments:payments.rows,checkpoints:checkpoints.rows});}));
app.put('/api/trips/:id',auth,tripAccess,asyncHandler(async(req,res)=>{if(req.trip.owner_id!==req.user.id)return res.status(403).json({error:'OWNER_ONLY'});const {name,destination,start_date,end_date,description,fund_target}=req.body||{};const s=start_date||req.trip.start_date.toISOString().slice(0,10),e=end_date||req.trip.end_date.toISOString().slice(0,10);if(!validateDateRange(s,e).valid)return res.status(400).json({error:'INVALID_TRIP_DATES',message:'Trip dates must be today or later and end date must be on/after start date'});const q=await pool.query('UPDATE trips SET name=COALESCE($1,name),destination=COALESCE($2,destination),start_date=$3,end_date=$4,description=COALESCE($5,description),fund_target=COALESCE($6,fund_target),updated_at=NOW() WHERE id=$7 RETURNING *',[name,destination,s,e,description,fund_target,req.trip.id]);res.json({trip:q.rows[0]});}));
app.delete('/api/trips/:id',auth,tripAccess,asyncHandler(async(req,res)=>{if(req.trip.owner_id!==req.user.id)return res.status(403).json({error:'OWNER_ONLY'});await pool.query('DELETE FROM trips WHERE id=$1',[req.trip.id]);res.json({message:'Trip deleted'});}));

// Members
app.post('/api/trips/:id/members',auth,tripAccess,asyncHandler(async(req,res)=>{if(req.trip.owner_id!==req.user.id)return res.status(403).json({error:'OWNER_ONLY'});const {user_id}=req.body||{};const u=await pool.query('SELECT id,username,display_name FROM users WHERE id=$1',[user_id]);if(!u.rowCount)return res.status(404).json({error:'USER_NOT_FOUND'});try{const q=await pool.query("INSERT INTO trip_members(trip_id,user_id,role,status) VALUES($1,$2,'member','joined') RETURNING *",[req.trip.id,user_id]);res.status(201).json({member:{...q.rows[0],user:u.rows[0]}});}catch(e){if(e.code==='23505')return res.status(409).json({error:'ALREADY_MEMBER'});throw e;}}));
app.delete('/api/trips/:id/members/:userId',auth,tripAccess,asyncHandler(async(req,res)=>{if(req.trip.owner_id!==req.user.id)return res.status(403).json({error:'OWNER_ONLY'});if(Number(req.params.userId)===req.trip.owner_id)return res.status(400).json({error:'CANNOT_REMOVE_OWNER'});await pool.query('DELETE FROM trip_members WHERE trip_id=$1 AND user_id=$2',[req.trip.id,req.params.userId]);res.json({message:'Member removed'});}));

// Activities - date must be inside existing trip range
app.post('/api/trips/:id/activities',auth,tripAccess,asyncHandler(async(req,res)=>{await activitySchemaReady;const {title,activity_date,start_time,end_time,category,description,location,google_maps_url}=req.body||{};const d=activity_date&&activity_date>=new Date(req.trip.start_date).toISOString().slice(0,10)&&activity_date<=new Date(req.trip.end_date).toISOString().slice(0,10);if(!title||!d)return res.status(400).json({error:'INVALID_ACTIVITY_DATE',message:'Activity date must be one of the dates inside this trip'});if(start_time&&end_time&&start_time>=end_time)return res.status(400).json({error:'INVALID_TIME_RANGE',message:'End time must be after start time'});if(google_maps_url&&!isGoogleMapsUrl(google_maps_url))return res.status(400).json({error:'INVALID_MAP_URL',message:'Please use a valid Google Maps URL'});const q=await pool.query('INSERT INTO activities(trip_id,title,activity_date,start_time,end_time,category,description,location,google_maps_url,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[req.trip.id,title,activity_date,start_time||null,end_time||null,category||'other',description||null,location||null,google_maps_url||null,req.user.id]);res.status(201).json({activity:q.rows[0]});}));
app.get('/api/trips/:id/activities',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query('SELECT * FROM activities WHERE trip_id=$1 ORDER BY activity_date,start_time NULLS LAST,id',[req.trip.id]);res.json({data:q.rows});}));
app.put('/api/trips/:id/activities/:activityId',auth,tripAccess,asyncHandler(async(req,res)=>{await activitySchemaReady;const {title,activity_date,start_time,end_time,category,description,location,google_maps_url}=req.body||{};if(activity_date && (activity_date<new Date(req.trip.start_date).toISOString().slice(0,10)||activity_date>new Date(req.trip.end_date).toISOString().slice(0,10)))return res.status(400).json({error:'INVALID_ACTIVITY_DATE',message:'Activity date must be inside this trip'});if(start_time&&end_time&&start_time>=end_time)return res.status(400).json({error:'INVALID_TIME_RANGE'});if(google_maps_url&&!isGoogleMapsUrl(google_maps_url))return res.status(400).json({error:'INVALID_MAP_URL',message:'Please use a valid Google Maps URL'});const q=await pool.query('UPDATE activities SET title=COALESCE($1,title),activity_date=COALESCE($2,activity_date),start_time=COALESCE($3,start_time),end_time=COALESCE($4,end_time),category=COALESCE($5,category),description=COALESCE($6,description),location=COALESCE($7,location),google_maps_url=COALESCE($8,google_maps_url),updated_at=NOW() WHERE id=$9 AND trip_id=$10 RETURNING *',[title,activity_date,start_time,end_time,category,description,location,google_maps_url,req.params.activityId,req.trip.id]);if(!q.rowCount)return res.status(404).json({error:'ACTIVITY_NOT_FOUND'});res.json({activity:q.rows[0]});}));
app.delete('/api/trips/:id/activities/:activityId',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query('DELETE FROM activities WHERE id=$1 AND trip_id=$2 RETURNING id',[req.params.activityId,req.trip.id]);if(!q.rowCount)return res.status(404).json({error:'ACTIVITY_NOT_FOUND'});res.json({message:'Activity deleted'});}));

// Trip checkpoints: plain-text place name + Google Maps share URL.
app.get('/api/trips/:id/checkpoints',auth,tripAccess,asyncHandler(async(req,res)=>{await checkpointSchemaReady;const q=await pool.query('SELECT * FROM checkpoints WHERE trip_id=$1 ORDER BY sort_order,id',[req.trip.id]);res.json({data:q.rows});}));
app.post('/api/trips/:id/checkpoints',auth,tripAccess,asyncHandler(async(req,res)=>{await checkpointSchemaReady;const {name,google_maps_url}=req.body||{};if(typeof name!=='string'||!name.trim())return res.status(400).json({error:'CHECKPOINT_NAME_REQUIRED',message:'กรุณากรอกชื่อสถานที่'});if(!isGoogleMapsUrl(google_maps_url))return res.status(400).json({error:'INVALID_MAP_URL',message:'กรุณาวางลิงก์แชร์จาก Google Maps'});const order=await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM checkpoints WHERE trip_id=$1',[req.trip.id]);const q=await pool.query('INSERT INTO checkpoints(trip_id,name,google_maps_url,sort_order,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.trip.id,name.trim(),google_maps_url.trim(),order.rows[0].next_order,req.user.id]);res.status(201).json({checkpoint:q.rows[0]});}));
app.put('/api/trips/:id/checkpoints/:checkpointId',auth,tripAccess,asyncHandler(async(req,res)=>{await checkpointSchemaReady;const {name,google_maps_url,sort_order}=req.body||{};if(name!==undefined&&(!String(name).trim()))return res.status(400).json({error:'CHECKPOINT_NAME_REQUIRED'});if(google_maps_url!==undefined&&!isGoogleMapsUrl(google_maps_url))return res.status(400).json({error:'INVALID_MAP_URL'});const q=await pool.query('UPDATE checkpoints SET name=COALESCE($1,name),google_maps_url=COALESCE($2,google_maps_url),sort_order=COALESCE($3,sort_order),updated_at=NOW() WHERE id=$4 AND trip_id=$5 RETURNING *',[name===undefined?null:String(name).trim(),google_maps_url===undefined?null:String(google_maps_url).trim(),Number.isInteger(Number(sort_order))&&sort_order!==undefined?Number(sort_order):null,req.params.checkpointId,req.trip.id]);if(!q.rowCount)return res.status(404).json({error:'CHECKPOINT_NOT_FOUND'});res.json({checkpoint:q.rows[0]});}));
app.delete('/api/trips/:id/checkpoints/:checkpointId',auth,tripAccess,asyncHandler(async(req,res)=>{await checkpointSchemaReady;const q=await pool.query('DELETE FROM checkpoints WHERE id=$1 AND trip_id=$2 RETURNING id',[req.params.checkpointId,req.trip.id]);if(!q.rowCount)return res.status(404).json({error:'CHECKPOINT_NOT_FOUND'});res.json({message:'Checkpoint deleted'});}));

// Accommodation
app.post('/api/trips/:id/accommodations',auth,tripAccess,asyncHandler(async(req,res)=>{const {name,address,check_in,check_out,price,booking_url}=req.body||{};if(booking_url&&!isWebUrl(booking_url))return res.status(400).json({error:'INVALID_BOOKING_URL'});const s=check_in,e=check_out;const valid=s&&e&&s>=new Date(req.trip.start_date).toISOString().slice(0,10)&&e<=new Date(req.trip.end_date).toISOString().slice(0,10)&&e>=s;if(!name||!valid)return res.status(400).json({error:'INVALID_ACCOMMODATION_DATES',message:'Accommodation dates must be within the trip dates and check-out must be on/after check-in'});const q=await pool.query('INSERT INTO accommodations(trip_id,name,address,check_in,check_out,price,booking_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.trip.id,name,address||null,s,e,Number(price)||0,booking_url||null]);res.status(201).json({accommodation:q.rows[0]});}));
app.get('/api/trips/:id/accommodations',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query('SELECT * FROM accommodations WHERE trip_id=$1 ORDER BY check_in',[req.trip.id]);res.json({data:q.rows});}));
app.put('/api/trips/:id/accommodations/:accommodationId',auth,tripAccess,asyncHandler(async(req,res)=>{if(req.body.booking_url&&!isWebUrl(req.body.booking_url))return res.status(400).json({error:'INVALID_BOOKING_URL'});const old=(await pool.query('SELECT * FROM accommodations WHERE id=$1 AND trip_id=$2',[req.params.accommodationId,req.trip.id])).rows[0];if(!old)return res.status(404).json({error:'ACCOMMODATION_NOT_FOUND'});const s=req.body.check_in||new Date(old.check_in).toISOString().slice(0,10),e=req.body.check_out||new Date(old.check_out).toISOString().slice(0,10);if(s<new Date(req.trip.start_date).toISOString().slice(0,10)||e>new Date(req.trip.end_date).toISOString().slice(0,10)||e<s)return res.status(400).json({error:'INVALID_ACCOMMODATION_DATES'});const q=await pool.query('UPDATE accommodations SET name=COALESCE($1,name),address=COALESCE($2,address),check_in=$3,check_out=$4,price=COALESCE($5,price),booking_url=COALESCE($6,booking_url),status=COALESCE($7,status) WHERE id=$8 AND trip_id=$9 RETURNING *',[req.body.name,req.body.address,s,e,req.body.price,req.body.booking_url,req.body.status,req.params.accommodationId,req.trip.id]);res.json({accommodation:q.rows[0]});}));
app.delete('/api/trips/:id/accommodations/:accommodationId',auth,tripAccess,asyncHandler(async(req,res)=>{await pool.query('DELETE FROM accommodations WHERE id=$1 AND trip_id=$2',[req.params.accommodationId,req.trip.id]);res.json({message:'Accommodation deleted'});}));

// Fund / payments
// Idempotent schema update supports existing Docker volumes; no data is dropped.
app.post('/api/trips/:id/payments',auth,tripAccess,slipUpload.single('slip'),asyncHandler(async(req,res)=>{
  const {user_id,amount,note}=req.body||{}; const payerId=Number(user_id||req.user.id);
  if(!Number.isInteger(payerId)||payerId<=0)return res.status(400).json({error:'INVALID_USER_ID'});
  if(!Number.isFinite(Number(amount))||Number(amount)<=0)return res.status(400).json({error:'INVALID_AMOUNT'});
  if(payerId!==req.user.id && Number(req.trip.owner_id)!==req.user.id)return res.status(403).json({error:'CANNOT_RECORD_PAYMENT_FOR_OTHER_MEMBER',message:'Only the trip owner can record a payment on behalf of another member'});
  const member=await pool.query("SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND status='joined'",[req.trip.id,payerId]);
  if(!member.rowCount)return res.status(400).json({error:'NOT_TRIP_MEMBER',message:'Payment user must be a joined member of this trip'});
  let slipPath=null;
  if(req.file){
    // Check the actual file signature, not only the browser-provided MIME type.
    const b=req.file.buffer;
    const valid=(req.file.mimetype==='image/jpeg'&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) ||
      (req.file.mimetype==='image/png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
      (req.file.mimetype==='image/webp'&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP');
    if(!valid)return res.status(400).json({error:'INVALID_SLIP_FILE',message:'ไฟล์ไม่ใช่รูปภาพที่รองรับ'});
    const filename=crypto.randomUUID()+slipExt[req.file.mimetype];
    await fs.promises.writeFile(path.join(uploadDir,filename),b,{flag:'wx'}); slipPath=filename;
  }
  try {
    const q=await pool.query('INSERT INTO payments(trip_id,user_id,amount,note,slip_path) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.trip.id,payerId,Number(amount),note||null,slipPath]);
    res.status(201).json({payment:q.rows[0]});
  } catch(e) { if(slipPath) await fs.promises.unlink(path.join(uploadDir,slipPath)).catch(()=>{}); throw e; }
}));
app.get('/api/trips/:id/payments/:paymentId/slip',auth,tripAccess,asyncHandler(async(req,res)=>{
  const q=await pool.query('SELECT id,user_id,slip_path FROM payments WHERE id=$1 AND trip_id=$2',[req.params.paymentId,req.trip.id]);
  if(!q.rowCount)return res.status(404).json({error:'PAYMENT_NOT_FOUND'});
  if(!q.rows[0].slip_path)return res.status(404).json({error:'SLIP_NOT_FOUND'});
  if(Number(req.trip.owner_id)!==req.user.id && q.rows[0].user_id!==req.user.id)return res.status(403).json({error:'SLIP_FORBIDDEN'});
  const file=path.resolve(uploadDir,q.rows[0].slip_path);
  if(path.dirname(file)!==uploadDir)return res.status(400).json({error:'INVALID_SLIP_PATH'});
  if(!fs.existsSync(file))return res.status(404).json({error:'SLIP_FILE_MISSING'});
  res.setHeader('Cache-Control','private, no-store'); res.type(path.extname(file)); res.sendFile(file);
}));
app.get('/api/trips/:id/fund',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric total_paid, COUNT(*)::int payment_count FROM payments WHERE trip_id=$1 AND status='paid'`,[req.trip.id]);const by=await pool.query(`SELECT u.id,u.display_name,COALESCE(SUM(p.amount),0)::numeric paid FROM trip_members tm JOIN users u ON u.id=tm.user_id LEFT JOIN payments p ON p.user_id=u.id AND p.trip_id=$1 AND p.status='paid' WHERE tm.trip_id=$1 GROUP BY u.id,u.display_name ORDER BY u.display_name`,[req.trip.id]);res.json({target:req.trip.fund_target,total_paid:q.rows[0].total_paid,payment_count:q.rows[0].payment_count,members:by.rows});}));
app.get('/api/trips/:id/payments',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query('SELECT p.*,u.display_name FROM payments p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 ORDER BY p.paid_at DESC',[req.trip.id]);res.json({data:q.rows});}));
app.delete('/api/trips/:id/payments/:paymentId',auth,tripAccess,asyncHandler(async(req,res)=>{const q=await pool.query('DELETE FROM payments WHERE id=$1 AND trip_id=$2 AND ($3=(SELECT owner_id FROM trips WHERE id=$2) OR user_id=$3) RETURNING id',[req.params.paymentId,req.trip.id,req.user.id]);if(!q.rowCount)return res.status(404).json({error:'PAYMENT_NOT_FOUND_OR_FORBIDDEN'});res.json({message:'Payment deleted'});}));

app.use((req,res)=>res.status(404).json({error:'NOT_FOUND',message:'Endpoint not found'}));
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError){const tooLarge=err.code==='LIMIT_FILE_SIZE';return res.status(tooLarge?413:400).json({error:tooLarge?'SLIP_TOO_LARGE':'SLIP_UPLOAD_ERROR',message:tooLarge?'ไฟล์สลิปต้องมีขนาดไม่เกิน 5 MB':'อัปโหลดไฟล์สลิปไม่สำเร็จ'});}if(err.message==='INVALID_SLIP_TYPE')return res.status(400).json({error:'INVALID_SLIP_TYPE',message:'รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP'});console.error(err);res.status(500).json({error:'INTERNAL_SERVER_ERROR',message:'Unexpected server error'});});

paymentSchemaReady.then(()=>app.listen(PORT,()=>console.log(`TripMate API listening on port ${PORT}`))).catch(err=>{console.error('Database schema initialization failed:',err.message);process.exit(1);});