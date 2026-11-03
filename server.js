const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const normalizeConnectionString = require('./scripts/connection-string.cjs');

const ROOT=__dirname, PUBLIC=path.join(ROOT,'dist'), PORT=Number(process.env.PORT||3000);
const DATABASE_URL=normalizeConnectionString(process.env.DATABASE_URL||process.env.NEON_DATABASE_URL);
const isVercel=process.env.VERCEL==='1';
const isProduction=process.env.NODE_ENV==='production'||process.env.VERCEL_ENV==='production';
if(!DATABASE_URL){console.error('VarsityONE cannot start: set DATABASE_URL to your Neon PostgreSQL connection string.');process.exit(1);}
const scrypt=promisify(crypto.scrypt);
const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:{rejectUnauthorized:true},
  max:Number(process.env.DB_POOL_MAX||(isVercel?5:10)),
  min:Number(process.env.DB_POOL_MIN||0),
  idleTimeoutMillis:30_000,
  connectionTimeoutMillis:10_000,
  maxLifetimeSeconds:1_800,
  keepAlive:true,
  keepAliveInitialDelayMillis:10_000,
  application_name:'varsityone-api',
  statement_timeout:8_000,
  lock_timeout:3_000,
  idle_in_transaction_session_timeout:10_000,
});
pool.on('error',error=>console.error(JSON.stringify({level:'error',event:'db.idle_client_error',message:error.message})));

class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new HttpError(status,message);};
const query=(text,values=[])=>pool.query(text,values);
const one=async(text,values=[])=>{const r=await query(text,values);return r.rows[0]||null;};
const many=async(text,values=[])=>{const r=await query(text,values);return r.rows;};
async function transaction(work,{isolation='SERIALIZABLE',retries=3}={}){
  for(let attempt=0;;attempt++){
    const client=await pool.connect();
    try{await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);const result=await work(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});if(attempt<retries&&['40001','40P01'].includes(error.code)){await new Promise(r=>setTimeout(r,20*(attempt+1)+Math.random()*40));continue;}throw error;}
    finally{client.release();}
  }
}
async function audit(actor,action,entityType,entityId,details={},client=pool){await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5::jsonb)',[actor?.id||null,action,entityType,entityId??null,JSON.stringify(details)]);}
const gradeFor=total=>total>=70?['A',5]:total>=60?['B',4]:total>=50?['C',3]:total>=45?['D',2]:total>=40?['E',1]:['F',0];
const hashPassword=async(password,salt=crypto.randomBytes(16).toString('hex'))=>`${salt}:${Buffer.from(await scrypt(password,salt,64)).toString('hex')}`;
async function verifyPassword(password,stored){const [salt,hash]=(stored||'').split(':');if(!salt||!hash)return false;const candidate=Buffer.from(await scrypt(password,salt,64));const expected=Buffer.from(hash,'hex');return candidate.length===expected.length&&crypto.timingSafeEqual(candidate,expected);}
const json=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
const cookie=(name,value,extra='')=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict${extra}`;
const cookieToken=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('uemp_session='))?.slice(13)||null;
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
async function readJson(req){let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>1_000_000)fail(413,'Request body exceeds the 1 MB limit.');body+=chunk;}try{return body?JSON.parse(body):{};}catch{fail(400,'Request body must be valid JSON.');}}
function jpegDimensions(buffer){
  if(buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8)return null;
  const startOfFrame=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset=2;
  while(offset+4<buffer.length){
    if(buffer[offset++]!==0xff)return null;
    while(buffer[offset]===0xff)offset++;
    const marker=buffer[offset++];
    if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(marker===0xd9||offset+2>buffer.length)return null;
    const length=buffer.readUInt16BE(offset);
    if(length<2||offset+length>buffer.length)return null;
    if(startOfFrame.has(marker)&&length>=7)return{height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)};
    offset+=length;
  }
  return null;
}
const requireUser=user=>{if(!user)fail(401,'Please sign in to continue.');return user;};
const requireRole=(user,roles)=>{requireUser(user);if(!roles.includes(user.role))fail(403,'Your account does not have permission to do that.');return user;};
const deptScope=(user,departmentId)=>user.role==='super_admin'||Number(user.departmentId)===Number(departmentId);
const int=(v,label)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)fail(400,`${label} must be a valid positive integer.`);return n;};
async function currentUser(req){const raw=cookieToken(req);if(!raw)return null;const row=await one(`SELECT u.id,u.email,u.role,u.name,u.status,u.phone,u.avatar_version AS "avatarVersion",u.avatar_has_photo AS "hasPhoto",u.department_id AS "departmentId",u.program_id AS "programId",u.level,u.matric_no AS "matricNo",u.staff_no AS "staffNo",d.name AS department,f.name AS faculty,p.name AS program
  FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN faculties f ON f.id=d.faculty_id LEFT JOIN programs p ON p.id=u.program_id
  WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'`,[tokenHash(raw)]);return row||null;}
async function activeTerm(client=pool){return one(`SELECT s.id,s.name,a.name AS session_name FROM semesters s JOIN academic_sessions a ON a.id=s.session_id WHERE s.is_current=true LIMIT 1`,[],client);}
async function dbOne(client,sql,values=[]){const r=await client.query(sql,values);return r.rows[0]||null;}
async function dbMany(client,sql,values=[]){return(await client.query(sql,values)).rows;}
let lastSessionCleanup=0;
async function cleanupExpiredSessionsIfDue(){
  if(Date.now()-lastSessionCleanup<60*60_000)return;
  lastSessionCleanup=Date.now();
  try{
    await query('DELETE FROM sessions WHERE expires_at<now()');
    await query("DELETE FROM login_rate_limits WHERE updated_at<now()-interval '1 day'");
  }
  catch(error){lastSessionCleanup=0;console.error(JSON.stringify({level:'error',event:'session_cleanup.failed',message:error.message}));}
}
function clientIp(req){
  const socketIp=req.socket?.remoteAddress;
  const forwardedIp=req.headers?.['x-vercel-forwarded-for']||req.headers?.['x-real-ip']||req.headers?.['x-forwarded-for'];
  if(isVercel||process.env.TRUST_PROXY==='true')return(forwardedIp||socketIp||'unknown').toString().split(',')[0].trim();
  return socketIp||'unknown';
}
function loginRateKey(req){return crypto.createHmac('sha256',process.env.AUTH_RATE_LIMIT_SECRET||DATABASE_URL).update(clientIp(req)).digest('hex');}
async function limitLogin(req){
  const result=await one(`INSERT INTO login_rate_limits(key_hash,window_started_at,attempts,updated_at)
    VALUES($1,now(),1,now())
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN login_rate_limits.window_started_at<=now()-interval '15 minutes' THEN 1 ELSE login_rate_limits.attempts+1 END,
      window_started_at=CASE WHEN login_rate_limits.window_started_at<=now()-interval '15 minutes' THEN now() ELSE login_rate_limits.window_started_at END,
      updated_at=now()
    RETURNING attempts`,[loginRateKey(req)]);
  if(result.attempts>12)fail(429,'Too many sign-in attempts. Wait 15 minutes before trying again.');
}
const rateSuccess=req=>query('DELETE FROM login_rate_limits WHERE key_hash=$1',[loginRateKey(req)]);
function pathId(route,pattern){const match=route.match(pattern);return match?int(match[1],'Record ID'):null;}

async function listCourses(user){const term=await activeTerm();if(!term)return[];let where='c.semester_id=$1',values=[term.id];if(user.role==='student'){where+=' AND c.is_active=true AND c.department_id=$2 AND c.program_id=$3 AND c.level=$4';values.push(user.departmentId,user.programId,user.level);}else if(user.role==='lecturer'){where+=' AND EXISTS(SELECT 1 FROM course_assignments ca WHERE ca.course_id=c.id AND ca.lecturer_id=$2)';values.push(user.id);}else if(user.role==='department_admin'){where+=' AND c.department_id=$2';values.push(user.departmentId);}
  return many(`SELECT c.id,c.code,c.title,c.units,c.level,c.department_id,c.program_id,c.semester_id,c.is_active,d.name AS department_name,p.name AS program_name,s.name AS semester_name,
    count(r.id)::int AS enrolled,COALESCE(bool_or(r.student_id=$${values.length+1}),false) AS registered
    FROM courses c JOIN departments d ON d.id=c.department_id JOIN programs p ON p.id=c.program_id JOIN semesters s ON s.id=c.semester_id
    LEFT JOIN registrations r ON r.course_id=c.id AND r.semester_id=c.semester_id
    WHERE ${where} GROUP BY c.id,d.name,p.name,s.name ORDER BY c.level,c.code`,[...values,user.id]);
}

async function handleApi(req,res,url){const method=req.method,route=url.pathname;
  await cleanupExpiredSessionsIfDue();
  if(route==='/api/health'&&method==='GET'){try{await query('SELECT 1');return json(res,200,{status:'ok',service:'varsityone',database:'ready',time:new Date().toISOString()});}catch{return json(res,503,{status:'degraded',service:'varsityone',database:'unavailable'});}}
  let user=await currentUser(req);
  if(route==='/api/login'&&method==='POST'){
    await limitLogin(req);const data=await readJson(req),email=String(data.email||'').trim().toLowerCase(),password=String(data.password||'');if(!email||!password)fail(400,'Email and password are required.');
    const record=await one(`SELECT u.id,u.email,u.password_hash,u.role,u.name,u.status,u.phone,u.avatar_version AS "avatarVersion",u.avatar_has_photo AS "hasPhoto",u.department_id AS "departmentId",u.program_id AS "programId",u.level,u.matric_no AS "matricNo",u.staff_no AS "staffNo",d.name AS department,f.name AS faculty,p.name AS program FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN faculties f ON f.id=d.faculty_id LEFT JOIN programs p ON p.id=u.program_id WHERE lower(u.email)=$1`,[email]);
    if(!record||record.status!=='active'||!(await verifyPassword(password,record.password_hash)))fail(401,'Email or password is incorrect.');
    const token=crypto.randomBytes(32).toString('base64url'),hash=tokenHash(token),expires=new Date(Date.now()+8*60*60_000);
    await transaction(async client=>{await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)',[hash,record.id,expires]);await audit(record,'auth.login','user',record.id,{},client);});await rateSuccess(req);delete record.password_hash;
    return json(res,200,{user:record},{'Set-Cookie':cookie('uemp_session',token,`; Max-Age=${8*60*60}${isProduction?'; Secure':''}`)});
  }
  if(route==='/api/logout'&&method==='POST'){const raw=cookieToken(req);if(raw){const hash=tokenHash(raw);if(user)await audit(user,'auth.logout','user',user.id);await query('DELETE FROM sessions WHERE token_hash=$1',[hash]);}return json(res,200,{ok:true},{'Set-Cookie':cookie('uemp_session','',`; Max-Age=0${isProduction?'; Secure':''}`)});}
  if(route==='/api/me'&&method==='GET')return json(res,200,{user,currentSemester:await activeTerm()});
  requireUser(user);

  const studentPhotoId=pathId(route,/^\/api\/admin\/students\/(\d+)\/photo$/);
  if(studentPhotoId&&method==='GET'){
    requireRole(user,['super_admin']);
    const photo=await one(`SELECT p.mime_type,p.image_bytes FROM profile_photos p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.role='student'`,[studentPhotoId]);
    if(!photo)return json(res,404,{error:'Student profile photo not found.'});
    res.writeHead(200,{'Content-Type':photo.mime_type,'Content-Length':photo.image_bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    return res.end(photo.image_bytes);
  }

  const accountPhotoId=pathId(route,/^\/api\/admin\/accounts\/(\d+)\/photo$/);
  if(accountPhotoId&&method==='GET'){
    requireRole(user,['super_admin']);
    const photo=await one(`SELECT p.mime_type,p.image_bytes FROM profile_photos p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`,[accountPhotoId]);
    if(!photo)return json(res,404,{error:'Account profile photo not found.'});
    res.writeHead(200,{'Content-Type':photo.mime_type,'Content-Length':photo.image_bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    return res.end(photo.image_bytes);
  }

  if(route==='/api/profile/photo'&&method==='GET'){
    const photo=await one('SELECT mime_type,image_bytes FROM profile_photos WHERE user_id=$1',[user.id]);
    if(!photo)return json(res,404,{error:'No profile photo has been uploaded.'});
    res.writeHead(200,{'Content-Type':photo.mime_type,'Content-Length':photo.image_bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    return res.end(photo.image_bytes);
  }
  if(route==='/api/profile/photo'&&method==='PUT'){
    const data=await readJson(req),image=String(data.image||''),match=image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match)fail(400,'Upload a JPEG photo. Images are converted to JPEG before saving.');
    const bytes=Buffer.from(match[1],'base64');
    if(!bytes.length||bytes.length>307200||bytes.toString('base64')!==match[1])fail(400,'Profile photos must be valid JPEG images under 300 KB.');
    const dimensions=jpegDimensions(bytes);
    if(!dimensions||dimensions.width>2048||dimensions.height>2048||dimensions.width*dimensions.height>4_194_304)fail(400,'Profile photo dimensions must be no larger than 2048 × 2048 pixels.');
    await transaction(async client=>{await client.query(`INSERT INTO profile_photos(user_id,mime_type,image_bytes) VALUES($1,'image/jpeg',$2) ON CONFLICT(user_id) DO UPDATE SET mime_type='image/jpeg',image_bytes=EXCLUDED.image_bytes,updated_at=now()`,[user.id,bytes]);await client.query('UPDATE users SET avatar_version=avatar_version+1,avatar_has_photo=true WHERE id=$1',[user.id]);await audit(user,'profile.photo.update','user',user.id,{size:bytes.length,width:dimensions.width,height:dimensions.height},client);});
    return json(res,200,{ok:true});
  }
  if(route==='/api/profile/photo'&&method==='DELETE'){
    await transaction(async client=>{await client.query('DELETE FROM profile_photos WHERE user_id=$1',[user.id]);await client.query('UPDATE users SET avatar_version=avatar_version+1,avatar_has_photo=false WHERE id=$1',[user.id]);await audit(user,'profile.photo.remove','user',user.id,{},client);});
    return json(res,200,{ok:true});
  }

  if(route==='/api/dashboard'&&method==='GET'){
    const term=await activeTerm();if(user.role==='student'){
      const reg=await one('SELECT count(*)::int AS registered,coalesce(sum(c.units),0)::int AS units FROM registrations r JOIN courses c ON c.id=r.course_id WHERE r.student_id=$1 AND r.semester_id=$2',[user.id,term?.id||0]);
      const results=await one(`SELECT count(*)::int AS results,coalesce(round(sum(r.grade_point*c.units)/nullif(sum(c.units),0),2),0)::float AS cgpa FROM results r JOIN courses c ON c.id=r.course_id WHERE r.student_id=$1 AND r.status='approved'`,[user.id]);return json(res,200,{role:user.role,...reg,...results,term});
    }
    if(user.role==='lecturer'){
      const counts=await one(`SELECT count(DISTINCT c.id)::int AS courses,count(DISTINCT c.id) FILTER(WHERE r.status='rejected')::int AS returned,count(DISTINCT c.id) FILTER(WHERE r.status='submitted')::int AS submitted
        FROM course_assignments ca JOIN courses c ON c.id=ca.course_id LEFT JOIN results r ON r.course_id=c.id AND r.semester_id=c.semester_id WHERE ca.lecturer_id=$1 AND c.semester_id=$2`,[user.id,term?.id||0]);return json(res,200,{role:user.role,...counts,term});
    }
    const scoped=user.role==='department_admin';const scope=scoped?'AND c.department_id=$2':'';const args=scoped?[term?.id||0,user.departmentId]:[term?.id||0];
    const [registered,students,pending,courses]=await Promise.all([
      one(`SELECT count(*)::int AS n FROM registrations r JOIN courses c ON c.id=r.course_id WHERE r.semester_id=$1 ${scope}`,args),
      one(`SELECT count(*)::int AS n FROM users WHERE role='student' AND status='active' ${scoped?'AND department_id=$1':''}`,scoped?[user.departmentId]:[]),
      one(`SELECT count(DISTINCT r.course_id)::int AS n FROM results r JOIN courses c ON c.id=r.course_id WHERE r.semester_id=$1 AND r.status='submitted' ${scope}`,args),
      one(`SELECT count(*)::int AS n FROM courses c WHERE c.semester_id=$1 ${scope}`,args),
    ]);return json(res,200,{role:user.role,registered:registered.n,students:students.n,pending:pending.n,courses:courses.n,term});
  }

  if(route==='/api/notifications'&&method==='GET'){
    requireUser(user);let notifications=[];
    if(user.role==='student')notifications=await many(`SELECT 'result:'||r.id||':approved' AS id,'Result approved' AS title,c.code||' · '||c.title AS message,'results' AS destination,coalesce(r.reviewed_at,r.updated_at) AS created_at FROM results r JOIN courses c ON c.id=r.course_id WHERE r.student_id=$1 AND r.status='approved' ORDER BY coalesce(r.reviewed_at,r.updated_at) DESC LIMIT 20`,[user.id]);
    else if(user.role==='lecturer')notifications=await many(`SELECT 'returned:'||c.id||':'||extract(epoch FROM max(r.updated_at))::bigint AS id,'Results returned for correction' AS title,c.code||' · '||c.title||' — '||count(r.id)::text||' result(s)' AS message,'results' AS destination,max(r.updated_at) AS created_at FROM course_assignments ca JOIN courses c ON c.id=ca.course_id JOIN results r ON r.course_id=c.id AND r.semester_id=c.semester_id WHERE ca.lecturer_id=$1 AND r.status='rejected' GROUP BY c.id,c.code,c.title ORDER BY max(r.updated_at) DESC LIMIT 20`,[user.id]);
    else {const scoped=user.role==='department_admin';notifications=await many(`SELECT 'review:'||c.id||':'||extract(epoch FROM max(r.updated_at))::bigint AS id,'Results awaiting review' AS title,c.code||' · '||c.title||' — '||count(r.id)::text||' submission(s)' AS message,'review' AS destination,max(r.updated_at) AS created_at FROM courses c JOIN results r ON r.course_id=c.id AND r.semester_id=c.semester_id WHERE r.status='submitted' ${scoped?'AND c.department_id=$1':''} GROUP BY c.id,c.code,c.title ORDER BY max(r.updated_at) DESC LIMIT 20`,scoped?[user.departmentId]:[]);}
    return json(res,200,{notifications});
  }

  if(route==='/api/courses'&&method==='GET')return json(res,200,{courses:await listCourses(user)});
  if(route==='/api/registrations'&&method==='GET'){
    let where='true',values=[];if(user.role==='student'){where='r.student_id=$1';values=[user.id];}else if(user.role==='lecturer'){where='EXISTS(SELECT 1 FROM course_assignments ca WHERE ca.course_id=c.id AND ca.lecturer_id=$1)';values=[user.id];}else if(user.role==='department_admin'){where='c.department_id=$1';values=[user.departmentId];}
    const rows=await many(`SELECT r.id,r.registered_at,c.id AS course_id,c.code,c.title,c.units,c.level,c.department_id,u.id AS student_id,u.name AS student_name,u.matric_no,s.name AS semester,a.name AS session FROM registrations r JOIN courses c ON c.id=r.course_id JOIN users u ON u.id=r.student_id JOIN semesters s ON s.id=r.semester_id JOIN academic_sessions a ON a.id=s.session_id WHERE ${where} ORDER BY c.code,u.name LIMIT 1000`,values);return json(res,200,{registrations:rows});
  }
  if(route==='/api/registrations'&&method==='POST'){
    requireRole(user,['student']);const data=await readJson(req),ids=[...new Set((Array.isArray(data.courseIds)?data.courseIds:[]).map(v=>int(v,'Course ID')))];if(!ids.length)fail(400,'Choose at least one course.');if(ids.length>40)fail(400,'Register no more than 40 courses at a time.');const term=await activeTerm();if(!term)fail(409,'There is no active semester for registration.');
    await transaction(async client=>{const eligible=await dbMany(client,'SELECT id,code FROM courses WHERE id=ANY($1::int[]) AND is_active=true AND semester_id=$2 AND department_id=$3 AND program_id=$4 AND level=$5 FOR SHARE',[ids,term.id,user.departmentId,user.programId,user.level]);if(eligible.length!==ids.length)fail(403,'One or more courses are outside your programme, level, or active semester.');const inserted=await client.query('INSERT INTO registrations(student_id,course_id,semester_id) SELECT $1,unnest($2::int[]),$3 ON CONFLICT(student_id,course_id,semester_id) DO NOTHING RETURNING course_id',[user.id,ids,term.id]);if(inserted.rowCount!==ids.length)fail(409,'One or more courses are already registered.');await audit(user,'course.register','registration',null,{courseIds:ids,semesterId:term.id},client);});return json(res,201,{ok:true,registered:ids.length});
  }
  if(route==='/api/results'&&method==='GET'){
    let where='true',values=[];if(user.role==='student'){where="r.student_id=$1 AND r.status='approved'";values=[user.id];}else if(user.role==='lecturer'){where='EXISTS(SELECT 1 FROM course_assignments ca WHERE ca.course_id=c.id AND ca.lecturer_id=$1)';values=[user.id];}else if(user.role==='department_admin'){where='c.department_id=$1';values=[user.departmentId];}
    const results=await many(`SELECT r.*,c.code,c.title,c.units,c.level,s.name AS semester,a.name AS session_name,u.name AS student_name,u.matric_no,d.name AS department_name FROM results r JOIN courses c ON c.id=r.course_id JOIN semesters s ON s.id=r.semester_id JOIN academic_sessions a ON a.id=s.session_id JOIN users u ON u.id=r.student_id JOIN departments d ON d.id=c.department_id WHERE ${where} ORDER BY s.id DESC,c.code,u.name LIMIT 2000`,values);return json(res,200,{results});
  }
  const classId=pathId(route,/^\/api\/courses\/(\d+)\/results$/);
  if(classId&&method==='GET'){
    requireRole(user,['lecturer','department_admin','super_admin']);const course=await one('SELECT * FROM courses WHERE id=$1',[classId]);if(!course)fail(404,'Course not found.');if(user.role==='lecturer'&&!await one('SELECT 1 FROM course_assignments WHERE course_id=$1 AND lecturer_id=$2',[classId,user.id]))fail(403,'This course is not assigned to you.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');
    const students=await many(`SELECT u.id AS student_id,u.name,u.matric_no,r.id AS registration_id,rs.ca,rs.exam,rs.total,rs.grade,rs.grade_point,rs.status,rs.feedback FROM registrations r JOIN users u ON u.id=r.student_id LEFT JOIN results rs ON rs.student_id=u.id AND rs.course_id=r.course_id AND rs.semester_id=r.semester_id WHERE r.course_id=$1 ORDER BY u.name`,[classId]);return json(res,200,{course,students});
  }
  if(classId&&method==='POST'){
    requireRole(user,['lecturer']);const course=await one('SELECT * FROM courses WHERE id=$1',[classId]);if(!course)fail(404,'Course not found.');if(!await one('SELECT 1 FROM course_assignments WHERE course_id=$1 AND lecturer_id=$2',[classId,user.id]))fail(403,'This course is not assigned to you.');const data=await readJson(req),entries=Array.isArray(data.entries)?data.entries:[],submit=Boolean(data.submit);if(!entries.length)fail(400,'There are no student scores to save.');if(entries.length>2000)fail(400,'Class score set exceeds the 2,000 student safety limit.');
    const normalized=entries.map(e=>{const studentId=int(e.studentId,'Student ID');if(e.ca===undefined||e.ca===null||e.ca===''||e.exam===undefined||e.exam===null||e.exam==='')fail(400,'Enter a CA and examination score for every registered student.');const ca=Number(e.ca),exam=Number(e.exam);if(!Number.isFinite(ca)||ca<0||ca>30||!Number.isFinite(exam)||exam<0||exam>70)fail(400,'CA must be 0–30 and examination must be 0–70.');const total=ca+exam,[grade,gradePoint]=gradeFor(total);return{studentId,ca,exam,total,grade,gradePoint};});
    await transaction(async client=>{const expected=Number((await dbOne(client,'SELECT count(*)::int AS n FROM registrations WHERE course_id=$1 AND semester_id=$2',[classId,course.semester_id])).n);if(entries.length!==expected)fail(409,'Submit a score for every registered student.');const ids=normalized.map(e=>e.studentId);if(new Set(ids).size!==ids.length)fail(400,'Each student can appear only once in a result submission.');
      const registered=await dbMany(client,'SELECT student_id FROM registrations WHERE course_id=$1 AND semester_id=$2 AND student_id=ANY($3::int[]) FOR SHARE',[classId,course.semester_id,ids]);if(registered.length!==ids.length)fail(403,'A student is not registered for this course.');const existing=await dbMany(client,'SELECT student_id,status FROM results WHERE course_id=$1 AND semester_id=$2 FOR UPDATE',[classId,course.semester_id]);if(existing.some(r=>['submitted','approved'].includes(r.status)))fail(409,'Submitted or approved results are locked. Ask the department administrator to return the result for correction.');
      await client.query(`INSERT INTO results(student_id,course_id,semester_id,ca,exam,total,grade,grade_point,status,feedback,submitted_at,reviewed_at,updated_at)
        SELECT e.student_id,$7,$8,e.ca,e.exam,e.total,e.grade,e.grade_point,$9,NULL,CASE WHEN $9='submitted' THEN now() ELSE NULL END,NULL,now()
        FROM unnest($1::int[],$2::numeric[],$3::numeric[],$4::numeric[],$5::text[],$6::numeric[]) AS e(student_id,ca,exam,total,grade,grade_point)
        ON CONFLICT(student_id,course_id,semester_id) DO UPDATE SET ca=EXCLUDED.ca,exam=EXCLUDED.exam,total=EXCLUDED.total,grade=EXCLUDED.grade,grade_point=EXCLUDED.grade_point,status=EXCLUDED.status,feedback=NULL,submitted_at=EXCLUDED.submitted_at,reviewed_at=NULL,updated_at=now()`,[ids,normalized.map(e=>e.ca),normalized.map(e=>e.exam),normalized.map(e=>e.total),normalized.map(e=>e.grade),normalized.map(e=>e.gradePoint),classId,course.semester_id,submit?'submitted':'draft']);
      await audit(user,submit?'result.submit':'result.save_draft','course',classId,{courseCode:course.code,count:entries.length},client);
    });return json(res,200,{ok:true,status:submit?'submitted':'draft'});
  }
  const reviewId=pathId(route,/^\/api\/courses\/(\d+)\/review$/);
  if(reviewId&&method==='POST'){
    requireRole(user,['department_admin','super_admin']);const course=await one('SELECT * FROM courses WHERE id=$1',[reviewId]);if(!course)fail(404,'Course not found.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');const data=await readJson(req),decision=data.decision==='approve'?'approved':data.decision==='return'?'rejected':null,feedback=String(data.feedback||'').trim();if(!decision)fail(400,'Choose approve or return.');if(decision==='rejected'&&!feedback)fail(400,'Feedback is required when returning results.');
    await transaction(async client=>{const results=await dbMany(client,"SELECT id,status FROM results WHERE course_id=$1 AND semester_id=$2 AND status='submitted' FOR UPDATE",[reviewId,course.semester_id]);if(!results.length)fail(409,'There are no submitted results awaiting review.');if(decision==='approved'){const count=Number((await dbOne(client,'SELECT count(*)::int AS n FROM registrations WHERE course_id=$1 AND semester_id=$2',[reviewId,course.semester_id])).n);if(results.length!==count)fail(409,'Every registered student needs a submitted result before approval.');}await client.query("UPDATE results SET status=$1,feedback=$2,reviewed_at=now(),updated_at=now() WHERE course_id=$3 AND semester_id=$4 AND status='submitted'",[decision,feedback||null,reviewId,course.semester_id]);await audit(user,decision==='approved'?'result.approve':'result.return','course',reviewId,{courseCode:course.code,count:results.length,feedback},client);});return json(res,200,{ok:true,status:decision});
  }

  if(route==='/api/admin/bootstrap'&&method==='GET'){
    requireRole(user,['super_admin','department_admin']);const scoped=user.role==='department_admin';const deptWhere=scoped?'WHERE d.id=$1':'';const baseValues=scoped?[user.departmentId]:[];
    const [faculties,departments,programs,sessions,semesters,users,courses,assignments]=await Promise.all([
      many(`SELECT id,name,code FROM faculties ${scoped?'WHERE id=(SELECT faculty_id FROM departments WHERE id=$1)':''} ORDER BY name`,baseValues),
      many(`SELECT d.id,d.faculty_id,d.name,d.code,f.name AS faculty FROM departments d JOIN faculties f ON f.id=d.faculty_id ${deptWhere} ORDER BY d.name`,baseValues),
      many(`SELECT p.id,p.department_id,p.name,p.code,p.duration,d.name AS department FROM programs p JOIN departments d ON d.id=p.department_id ${scoped?'WHERE d.id=$1':''} ORDER BY p.name`,baseValues),
      many('SELECT id,name,is_current FROM academic_sessions ORDER BY id DESC'),
      many('SELECT s.id,s.session_id,s.name,s.is_current,a.name AS session FROM semesters s JOIN academic_sessions a ON a.id=s.session_id ORDER BY s.id DESC'),
      many(`SELECT u.id,u.email,u.role,u.name,u.status,u.phone,u.department_id,u.program_id,u.level,u.matric_no,u.staff_no,d.name AS department_name,p.name AS program_name FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN programs p ON p.id=u.program_id ${scoped?'WHERE u.department_id=$1':''} ORDER BY u.name`,baseValues),
      many(`SELECT c.id,c.code,c.title,c.units,c.department_id,c.program_id,c.level,c.semester_id,c.is_active,d.name AS department,p.name AS program,s.name AS semester FROM courses c JOIN departments d ON d.id=c.department_id JOIN programs p ON p.id=c.program_id JOIN semesters s ON s.id=c.semester_id ${scoped?'WHERE c.department_id=$1':''} ORDER BY c.code`,baseValues),
      many(`SELECT a.course_id,a.lecturer_id,u.name AS lecturer_name FROM course_assignments a JOIN users u ON u.id=a.lecturer_id ${scoped?'WHERE u.department_id=$1':''} ORDER BY u.name`,baseValues),
    ]);return json(res,200,{faculties,departments,programs,sessions,semesters,users,courses,assignments});
  }
  const studentProfileId=pathId(route,/^\/api\/admin\/students\/(\d+)\/profile$/);
  if(studentProfileId&&method==='GET'){
    requireRole(user,['super_admin']);
    const profile=await one(`SELECT u.id,u.name,u.email,u.phone,u.status,u.matric_no AS "matricNo",u.level,u.avatar_version AS "avatarVersion",u.avatar_has_photo AS "hasPhoto",u.created_at AS "createdAt",p.name AS program,p.code AS "programCode",p.duration AS "programDuration",d.name AS department,d.code AS "departmentCode",f.name AS faculty,(SELECT count(*)::int FROM registrations r WHERE r.student_id=u.id AND r.semester_id=(SELECT id FROM semesters WHERE is_current=true)) AS "currentRegistrations",(SELECT coalesce(sum(c.units),0)::int FROM registrations r JOIN courses c ON c.id=r.course_id WHERE r.student_id=u.id AND r.semester_id=(SELECT id FROM semesters WHERE is_current=true)) AS "currentUnits",(SELECT count(*)::int FROM results r WHERE r.student_id=u.id AND r.status='approved') AS "approvedResults" FROM users u JOIN programs p ON p.id=u.program_id JOIN departments d ON d.id=u.department_id JOIN faculties f ON f.id=d.faculty_id WHERE u.id=$1 AND u.role='student'`,[studentProfileId]);
    if(!profile)fail(404,'Student profile not found.');
    return json(res,200,{profile});
  }
  const accountProfileId=pathId(route,/^\/api\/admin\/accounts\/(\d+)\/profile$/);
  if(accountProfileId&&method==='GET'){
    requireRole(user,['super_admin']);
    const profile=await one(`SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.matric_no AS "matricNo",u.staff_no AS "staffNo",u.level,u.avatar_version AS "avatarVersion",u.avatar_has_photo AS "hasPhoto",u.created_at AS "createdAt",p.name AS program,p.code AS "programCode",p.duration AS "programDuration",d.name AS department,d.code AS "departmentCode",f.name AS faculty,
      CASE WHEN u.role='student' THEN (SELECT count(*)::int FROM registrations r WHERE r.student_id=u.id AND r.semester_id=(SELECT id FROM semesters WHERE is_current=true)) WHEN u.role='lecturer' THEN (SELECT count(*)::int FROM course_assignments ca JOIN courses c ON c.id=ca.course_id WHERE ca.lecturer_id=u.id AND c.semester_id=(SELECT id FROM semesters WHERE is_current=true)) ELSE 0 END AS "currentCourses",
      CASE WHEN u.role='student' THEN (SELECT coalesce(sum(c.units),0)::int FROM registrations r JOIN courses c ON c.id=r.course_id WHERE r.student_id=u.id AND r.semester_id=(SELECT id FROM semesters WHERE is_current=true)) ELSE 0 END AS "currentUnits",
      CASE WHEN u.role='student' THEN (SELECT count(*)::int FROM results r WHERE r.student_id=u.id AND r.status='approved') ELSE 0 END AS "approvedResults",
      CASE WHEN u.role='department_admin' THEN (SELECT count(*)::int FROM users managed WHERE managed.department_id=u.department_id AND managed.id<>u.id) ELSE 0 END AS "managedAccounts"
      FROM users u LEFT JOIN programs p ON p.id=u.program_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN faculties f ON f.id=d.faculty_id WHERE u.id=$1`,[accountProfileId]);
    if(!profile)fail(404,'Account profile not found.');
    return json(res,200,{profile});
  }
  if(route==='/api/admin/accounts'&&method==='GET'){
    requireRole(user,['super_admin']);
    const role=url.searchParams.get('role')||'';
    if(!['student','lecturer','department_admin','super_admin'].includes(role))fail(400,'Choose a valid account role.');
    const status=url.searchParams.get('status')||'all';
    if(!['all','active','inactive','suspended'].includes(status))fail(400,'Choose a valid account status.');
    const search=String(url.searchParams.get('q')||'').trim().slice(0,100);
    const pageValue=Number(url.searchParams.get('page')||0),limitValue=Number(url.searchParams.get('limit')||25);
    if(!Number.isSafeInteger(pageValue)||pageValue<0||!Number.isSafeInteger(limitValue)||limitValue<1||limitValue>100)fail(400,'Use a valid page and a page size between 1 and 100.');
    const values=[role,status,search,`%${search}%`];
    const where=`u.role=$1 AND ($2='all' OR u.status=$2) AND ($3='' OR concat_ws(' ',u.name,u.email,u.matric_no,u.staff_no,d.name,p.name)::text ILIKE $4)`;
    const [total,accounts]=await Promise.all([
      one(`SELECT count(*)::int AS count FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN programs p ON p.id=u.program_id WHERE ${where}`,values),
      many(`SELECT u.id,u.name,u.email,u.role,u.status,u.matric_no,u.staff_no,u.level,d.name AS department,p.name AS program FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN programs p ON p.id=u.program_id WHERE ${where} ORDER BY lower(u.name),u.id LIMIT $5 OFFSET $6`,[...values,limitValue,pageValue*limitValue]),
    ]);
    return json(res,200,{accounts,total:total.count,page:pageValue,limit:limitValue});
  }
  if(route==='/api/audit'&&method==='GET'){
    requireRole(user,['super_admin','department_admin']);const values=user.role==='department_admin'?[user.departmentId]:[];const scope=user.role==='department_admin'?`AND (e.actor_id IN (SELECT id FROM users WHERE department_id=$1) OR (e.entity_type='course' AND e.entity_id IN (SELECT id FROM courses WHERE department_id=$1)))`:'';
    const events=await many(`SELECT e.id,e.actor_id,e.action,e.entity_type,e.entity_id,e.details,e.created_at,u.name AS actor_name,u.role AS actor_role FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE true ${scope} ORDER BY e.id DESC LIMIT 100`,values);return json(res,200,{events});
  }
  if(route==='/api/reports'&&method==='GET'){
    requireRole(user,['super_admin','department_admin']);const scoped=user.role==='department_admin',where=scoped?'AND department_id=$1':'',values=scoped?[user.departmentId]:[];const courseScope=scoped?'AND c.department_id=$1':'';const courseValues=scoped?[user.departmentId]:[];
    const [users,registrations,students,performance]=await Promise.all([
      many(`SELECT role,count(*)::int AS count FROM users WHERE status='active' ${where} GROUP BY role ORDER BY role`,values),
      many(`SELECT c.code,c.title,c.units,c.level,count(r.id)::int AS enrolled FROM courses c LEFT JOIN registrations r ON r.course_id=c.id AND r.semester_id=c.semester_id WHERE c.semester_id=(SELECT id FROM semesters WHERE is_current=true) ${courseScope} GROUP BY c.id ORDER BY enrolled DESC,c.code`,courseValues),
      many(`SELECT u.id,u.name,u.email,u.matric_no,u.level,p.name AS program,d.name AS department FROM users u JOIN programs p ON p.id=u.program_id JOIN departments d ON d.id=u.department_id WHERE u.role='student' AND u.status='active' ${scoped?'AND u.department_id=$1':''} ORDER BY d.name,p.name,u.level,u.name LIMIT 5000`,courseValues),
      many(`SELECT c.code,c.title,c.level,count(r.id)::int AS assessed,round(coalesce(avg(r.total),0),1)::float AS average_score,count(r.id) FILTER(WHERE r.total>=40)::int AS passes,count(r.id) FILTER(WHERE r.total<40)::int AS fails FROM courses c LEFT JOIN results r ON r.course_id=c.id AND r.semester_id=c.semester_id AND r.status='approved' WHERE c.semester_id=(SELECT id FROM semesters WHERE is_current=true) ${courseScope} GROUP BY c.id ORDER BY c.code`,courseValues),
    ]);return json(res,200,{users,registrations,students,performance});
  }
  if(route==='/api/admin/faculties'&&method==='POST'){
    requireRole(user,['super_admin']);const data=await readJson(req),name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase();if(!name||!code)fail(400,'Faculty name and code are required.');const result=await query('INSERT INTO faculties(name,code) VALUES ($1,$2) RETURNING id',[name,code]);const id=result.rows[0].id;await audit(user,'admin.faculty.create','faculty',id,{name,code});return json(res,201,{id});
  }
  if(route==='/api/admin/departments'&&method==='POST'){
    requireRole(user,['super_admin']);const data=await readJson(req),facultyId=int(data.facultyId,'Faculty ID'),name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase();if(!name||!code)fail(400,'Department name and code are required.');const result=await query('INSERT INTO departments(faculty_id,name,code) VALUES ($1,$2,$3) RETURNING id',[facultyId,name,code]);const id=result.rows[0].id;await audit(user,'admin.department.create','department',id,{name,code});return json(res,201,{id});
  }
  if(route==='/api/admin/programs'&&method==='POST'){
    requireRole(user,['super_admin','department_admin']);const data=await readJson(req),departmentId=user.role==='department_admin'?user.departmentId:int(data.departmentId,'Department ID'),name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase(),duration=Number(data.duration||4);if(!deptScope(user,departmentId)||!name||!code||!Number.isInteger(duration)||duration<1||duration>8)fail(400,'Provide a valid department, programme name, code, and duration.');const result=await query('INSERT INTO programs(department_id,name,code,duration) VALUES ($1,$2,$3,$4) RETURNING id',[departmentId,name,code,duration]);const id=result.rows[0].id;await audit(user,'admin.program.create','program',id,{name,code});return json(res,201,{id});
  }
  if(route==='/api/admin/sessions'&&method==='POST'){
    requireRole(user,['super_admin']);const data=await readJson(req),name=String(data.name||'').trim();if(!/^\d{4}\/\d{4}$/.test(name))fail(400,'Use an academic session format such as 2026/2027.');const id=await transaction(async client=>{const r=await client.query('INSERT INTO academic_sessions(name,is_current) VALUES ($1,false) RETURNING id',[name]);const n=r.rows[0].id;if(data.current){await client.query('UPDATE semesters SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=true WHERE id=$1',[n]);}await audit(user,'admin.session.create','session',n,{name,current:Boolean(data.current)},client);return n;});return json(res,201,{id});
  }
  if(route==='/api/admin/semesters'&&method==='POST'){
    requireRole(user,['super_admin']);const data=await readJson(req),sessionId=int(data.sessionId,'Session ID'),name=String(data.name||'').trim();if(!['First Semester','Second Semester','Third Semester'].includes(name))fail(400,'Choose a valid semester.');const id=await transaction(async client=>{const r=await client.query('INSERT INTO semesters(session_id,name,is_current) VALUES ($1,$2,false) RETURNING id',[sessionId,name]);const n=r.rows[0].id;if(data.current){await client.query('UPDATE semesters SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=false WHERE is_current=true');await client.query('UPDATE semesters SET is_current=true WHERE id=$1',[n]);await client.query('UPDATE academic_sessions SET is_current=true WHERE id=$1',[sessionId]);}await audit(user,'admin.semester.create','semester',n,{sessionId,name,current:Boolean(data.current)},client);return n;});return json(res,201,{id});
  }
  const academicEdit=route.match(/^\/api\/admin\/(faculties|departments|programs|sessions|semesters)\/(\d+)$/);if(academicEdit&&method==='PATCH'){
    const [,kind,rawId]=academicEdit,id=int(rawId,'Record ID'),data=await readJson(req);let before,after,entity;
    if(kind==='faculties'){
      requireRole(user,['super_admin']);before=await one('SELECT id,name,code FROM faculties WHERE id=$1',[id]);if(!before)fail(404,'Faculty not found.');const name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase();if(!name||name.length>120||!code||code.length>20)fail(400,'Provide a valid faculty name and code.');await query('UPDATE faculties SET name=$1,code=$2 WHERE id=$3',[name,code,id]);after={name,code};entity='faculty';
    }else if(kind==='departments'){
      requireRole(user,['super_admin','department_admin']);before=await one('SELECT id,faculty_id,name,code FROM departments WHERE id=$1',[id]);if(!before)fail(404,'Department not found.');if(user.role==='department_admin'&&!deptScope(user,id))fail(403,'This department is outside your scope.');const facultyId=user.role==='department_admin'?before.faculty_id:int(data.facultyId,'Faculty ID'),name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase();if(!name||name.length>120||!code||code.length>20)fail(400,'Provide a valid department name and code.');await query('UPDATE departments SET faculty_id=$1,name=$2,code=$3 WHERE id=$4',[facultyId,name,code,id]);after={facultyId,name,code};entity='department';
    }else if(kind==='programs'){
      requireRole(user,['super_admin','department_admin']);before=await one('SELECT id,department_id,name,code,duration FROM programs WHERE id=$1',[id]);if(!before)fail(404,'Programme not found.');if(user.role==='department_admin'&&!deptScope(user,before.department_id))fail(403,'This programme is outside your department.');const departmentId=user.role==='department_admin'?user.departmentId:int(data.departmentId,'Department ID'),name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase(),duration=Number(data.duration);if(!deptScope(user,departmentId)||!name||name.length>120||!code||code.length>20||!Number.isInteger(duration)||duration<1||duration>8)fail(400,'Provide a valid department, programme name, code, and duration.');await query('UPDATE programs SET department_id=$1,name=$2,code=$3,duration=$4 WHERE id=$5',[departmentId,name,code,duration,id]);after={departmentId,name,code,duration};entity='program';
    }else if(kind==='sessions'){
      requireRole(user,['super_admin']);before=await one('SELECT id,name,is_current FROM academic_sessions WHERE id=$1',[id]);if(!before)fail(404,'Academic session not found.');const name=String(data.name||'').trim();if(!/^\d{4}\/\d{4}$/.test(name))fail(400,'Use an academic session format such as 2026/2027.');await transaction(async client=>{await client.query('UPDATE academic_sessions SET name=$1 WHERE id=$2',[name,id]);if(data.current){await client.query('UPDATE semesters SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=true WHERE id=$1',[id]);}else if(before.is_current){fail(409,'Select another current session before changing this one.');}await audit(user,'admin.session.update','session',id,{before:{name:before.name,current:before.is_current},after:{name,current:Boolean(data.current)},},client);});return json(res,200,{ok:true});
    }else{
      requireRole(user,['super_admin']);before=await one('SELECT id,session_id,name,is_current FROM semesters WHERE id=$1',[id]);if(!before)fail(404,'Semester not found.');const sessionId=int(data.sessionId,'Session ID'),name=String(data.name||'').trim();if(!['First Semester','Second Semester','Third Semester'].includes(name))fail(400,'Choose a valid semester.');await transaction(async client=>{await client.query('UPDATE semesters SET session_id=$1,name=$2 WHERE id=$3',[sessionId,name,id]);if(data.current){await client.query('UPDATE semesters SET is_current=false WHERE is_current=true');await client.query('UPDATE academic_sessions SET is_current=false WHERE is_current=true');await client.query('UPDATE semesters SET is_current=true WHERE id=$1',[id]);await client.query('UPDATE academic_sessions SET is_current=true WHERE id=$1',[sessionId]);}else if(before.is_current){fail(409,'Select another current semester before changing this one.');}await audit(user,'admin.semester.update','semester',id,{before:{sessionId:before.session_id,name:before.name,current:before.is_current},after:{sessionId,name,current:Boolean(data.current)}},client);});return json(res,200,{ok:true});
    }
    await audit(user,`admin.${entity}.update`,entity,id,{before,after});return json(res,200,{ok:true});
  }
  if(route==='/api/admin/users'&&method==='POST'){
    requireRole(user,['super_admin','department_admin']);const data=await readJson(req),role=data.role;if(!['student','lecturer','department_admin','super_admin'].includes(role)||(role==='super_admin'&&user.role!=='super_admin'))fail(400,'Choose a role you are permitted to assign.');const departmentId=role==='super_admin'?null:user.role==='department_admin'?user.departmentId:int(data.departmentId,'Department ID');if(role!=='super_admin'&&!deptScope(user,departmentId))fail(403,'This department is outside your scope.');const email=String(data.email||'').trim().toLowerCase(),name=String(data.name||'').trim(),password=String(data.password||'');if(!/^\S+@\S+\.\S+$/.test(email)||name.length<2||name.length>100)fail(400,'Provide a valid email and full name.');if(password.length<10||password.length>256)fail(400,'Initial password must contain 10–256 characters.');const programId=role==='student'?int(data.programId,'Programme ID'):null,level=role==='student'?Number(data.level):null,matricNo=role==='student'?String(data.matricNo||'').trim().toUpperCase():null,staffNo=['lecturer','department_admin'].includes(role)?String(data.staffNo||'').trim().toUpperCase()||null:null;if(role==='student'&&(!Number.isInteger(level)||level<100||level>800||level%100!==0||!matricNo))fail(400,'Provide a programme, academic level and matriculation number.');const passwordHash=await hashPassword(password);const result=await query(`INSERT INTO users(email,password_hash,role,name,department_id,program_id,level,matric_no,staff_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[email,passwordHash,role,name,departmentId,programId,level,matricNo,staffNo]);const id=result.rows[0].id;await audit(user,'admin.user.create','user',id,{email,role});return json(res,201,{id});
  }
  const userEditId=pathId(route,/^\/api\/admin\/users\/(\d+)$/);if(userEditId&&method==='PATCH'){
    requireRole(user,['super_admin','department_admin']);const before=await one('SELECT id,email,name,phone,role,department_id FROM users WHERE id=$1',[userEditId]);if(!before)fail(404,'Account not found.');if(user.role==='department_admin'&&(before.role==='super_admin'||!deptScope(user,before.department_id)))fail(403,'This account is outside your department.');const data=await readJson(req),name=String(data.name||'').trim(),email=String(data.email||'').trim().toLowerCase(),phone=String(data.phone||'').trim();if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||phone.length>30)fail(400,'Provide a valid name, email address, and phone number.');await transaction(async client=>{await client.query('UPDATE users SET name=$1,email=$2,phone=$3 WHERE id=$4',[name,email,phone||null,userEditId]);if(email!==before.email)await client.query('DELETE FROM sessions WHERE user_id=$1',[userEditId]);await audit(user,'admin.user.update','user',userEditId,{before:{name:before.name,email:before.email,phone:before.phone},after:{name,email,phone:phone||null}},client);});return json(res,200,{ok:true});
  }
  const userStatusId=pathId(route,/^\/api\/admin\/users\/(\d+)\/status$/);if(userStatusId&&method==='PATCH'){
    requireRole(user,['super_admin','department_admin']);const target=await one('SELECT id,role,department_id FROM users WHERE id=$1',[userStatusId]);if(!target)fail(404,'Account not found.');if(userStatusId===user.id)fail(409,'You cannot change the status of your own account.');if(user.role==='department_admin'&&(target.role==='super_admin'||target.department_id!==user.departmentId))fail(403,'This account is outside your department.');const data=await readJson(req);if(!['active','inactive','suspended'].includes(data.status))fail(400,'Choose active, inactive, or suspended.');await transaction(async client=>{await client.query('UPDATE users SET status=$1 WHERE id=$2',[data.status,userStatusId]);await client.query('DELETE FROM sessions WHERE user_id=$1',[userStatusId]);await audit(user,'admin.user.status','user',userStatusId,{status:data.status},client);});return json(res,200,{ok:true});
  }
  const roleUserId=pathId(route,/^\/api\/admin\/users\/(\d+)\/role$/);if(roleUserId&&method==='PATCH'){
    requireRole(user,['super_admin']);if(roleUserId===user.id)fail(409,'You cannot change your own platform role.');const target=await one('SELECT id,role,department_id FROM users WHERE id=$1',[roleUserId]);if(!target)fail(404,'Account not found.');const data=await readJson(req),role=data.role;if(!['student','lecturer','department_admin','super_admin'].includes(role))fail(400,'Choose a valid platform role.');const departmentId=role==='super_admin'?null:int(data.departmentId,'Department ID'),programId=role==='student'?int(data.programId,'Programme ID'):null,level=role==='student'?Number(data.level):null,matricNo=role==='student'?String(data.matricNo||'').trim().toUpperCase():null,staffNo=['lecturer','department_admin'].includes(role)?String(data.staffNo||'').trim().toUpperCase()||null:null;if(role==='student'&&(!Number.isInteger(level)||level<100||level>800||level%100!==0||!matricNo))fail(400,'Provide a programme, academic level and matriculation number.');
    await transaction(async client=>{await client.query('UPDATE users SET role=$1,department_id=$2,program_id=$3,level=$4,matric_no=$5,staff_no=$6 WHERE id=$7',[role,departmentId,programId,level,matricNo,staffNo,roleUserId]);await client.query('DELETE FROM sessions WHERE user_id=$1',[roleUserId]);await audit(user,'admin.user.role','user',roleUserId,{from:target.role,to:role,departmentId},client);});return json(res,200,{ok:true});
  }
  if(route==='/api/admin/courses'&&method==='POST'){
    requireRole(user,['super_admin','department_admin']);const data=await readJson(req),departmentId=user.role==='department_admin'?user.departmentId:int(data.departmentId,'Department ID'),programId=int(data.programId,'Programme ID'),semesterId=int(data.semesterId,'Semester ID'),level=Number(data.level),units=Number(data.units),code=String(data.code||'').trim().toUpperCase(),title=String(data.title||'').trim();if(!deptScope(user,departmentId)||!code||code.length>30||title.length<2||title.length>180||!Number.isInteger(level)||level<100||level>800||level%100!==0||!Number.isInteger(units)||units<1||units>10)fail(400,'Provide valid course details and matching programme.');const result=await query('INSERT INTO courses(code,title,units,department_id,program_id,level,semester_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',[code,title,units,departmentId,programId,level,semesterId]);const id=result.rows[0].id;await audit(user,'admin.course.create','course',id,{code,title});return json(res,201,{id});
  }
  const courseEditId=pathId(route,/^\/api\/admin\/courses\/(\d+)$/);if(courseEditId&&method==='PATCH'){
    requireRole(user,['super_admin','department_admin']);const course=await one('SELECT id,code,title,units,department_id FROM courses WHERE id=$1',[courseEditId]);if(!course)fail(404,'Course not found.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');const data=await readJson(req),code=String(data.code||'').trim().toUpperCase(),title=String(data.title||'').trim(),units=Number(data.units);if(!code||code.length>30||title.length<2||title.length>180||!Number.isInteger(units)||units<1||units>10)fail(400,'Provide a valid course code, title and credit-unit value.');await transaction(async client=>{await client.query('UPDATE courses SET code=$1,title=$2,units=$3 WHERE id=$4',[code,title,units,courseEditId]);await audit(user,'admin.course.update','course',courseEditId,{before:{code:course.code,title:course.title,units:course.units},after:{code,title,units}},client);});return json(res,200,{ok:true});
  }
  const courseStatusId=pathId(route,/^\/api\/admin\/courses\/(\d+)\/status$/);if(courseStatusId&&method==='PATCH'){
    requireRole(user,['super_admin','department_admin']);const course=await one('SELECT id,department_id FROM courses WHERE id=$1',[courseStatusId]);if(!course)fail(404,'Course not found.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');const data=await readJson(req);if(![0,1,false,true].includes(data.isActive))fail(400,'Choose whether the course is active.');const active=data.isActive===true||data.isActive===1;await transaction(async client=>{await client.query('UPDATE courses SET is_active=$1 WHERE id=$2',[active,courseStatusId]);await audit(user,'admin.course.status','course',courseStatusId,{isActive:active},client);});return json(res,200,{ok:true});
  }
  if(route==='/api/admin/assignments'&&method==='POST'){
    requireRole(user,['super_admin','department_admin']);const data=await readJson(req),courseId=int(data.courseId,'Course ID'),lecturerId=int(data.lecturerId,'Lecturer ID');const [course,lecturer]=await Promise.all([one('SELECT id,department_id FROM courses WHERE id=$1',[courseId]),one("SELECT id,department_id,role,status FROM users WHERE id=$1",[lecturerId])]);if(!course||!lecturer||lecturer.role!=='lecturer'||lecturer.status!=='active'||Number(lecturer.department_id)!==Number(course.department_id))fail(400,'Choose an active lecturer and a course in the same department.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');await transaction(async client=>{await client.query('INSERT INTO course_assignments(course_id,lecturer_id,assigned_by) VALUES ($1,$2,$3) ON CONFLICT(course_id,lecturer_id) DO NOTHING',[courseId,lecturerId,user.id]);await audit(user,'admin.course.assign','course',courseId,{lecturerId},client);});return json(res,200,{ok:true});
  }
  const assignmentMatch=route.match(/^\/api\/admin\/assignments\/(\d+)\/(\d+)$/);if(assignmentMatch&&method==='DELETE'){
    requireRole(user,['super_admin','department_admin']);const courseId=int(assignmentMatch[1],'Course ID'),lecturerId=int(assignmentMatch[2],'Lecturer ID'),course=await one('SELECT id,department_id FROM courses WHERE id=$1',[courseId]);if(!course)fail(404,'Course not found.');if(user.role==='department_admin'&&!deptScope(user,course.department_id))fail(403,'This course is outside your department.');await transaction(async client=>{const result=await client.query('DELETE FROM course_assignments WHERE course_id=$1 AND lecturer_id=$2',[courseId,lecturerId]);if(!result.rowCount)fail(404,'Course allocation not found.');await audit(user,'admin.course.unassign','course',courseId,{lecturerId},client);});return json(res,200,{ok:true});
  }
  if(route==='/api/profile'&&method==='PATCH'){
    const data=await readJson(req),name=String(data.name||'').trim(),phone=String(data.phone||'').trim()||null;if(name.length<2||name.length>100)fail(400,'Enter a name between 2 and 100 characters.');if(phone&&(!/^[+()\-\d .]{7,30}$/.test(phone)||phone.replace(/\D/g,'').length<7))fail(400,'Enter a valid phone number or leave it blank.');await transaction(async client=>{await client.query('UPDATE users SET name=$1,phone=$2 WHERE id=$3',[name,phone,user.id]);await audit(user,'profile.update','user',user.id,{fields:['name','phone']},client);});return json(res,200,{ok:true});
  }
  if(route==='/api/profile/credentials'&&method==='PATCH'){
    const data=await readJson(req),currentPassword=String(data.currentPassword||''),email=String(data.email||'').trim().toLowerCase(),newPassword=String(data.newPassword||'');
    if(!currentPassword||currentPassword.length>256)fail(400,'Enter your current password to update account credentials.');
    if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid email address.');
    if(newPassword&&(newPassword.length<12||newPassword.length>128||!/[a-z]/.test(newPassword)||!/[A-Z]/.test(newPassword)||!/[0-9]/.test(newPassword)||!/[^A-Za-z0-9]/.test(newPassword)))fail(400,'New password must be 12–128 characters and include uppercase, lowercase, number and symbol characters.');
    const sessionToken=cookieToken(req),sessionHash=sessionToken?tokenHash(sessionToken):'';
    const passwordHash=newPassword?await hashPassword(newPassword):null;
    try{
      const updated=await transaction(async client=>{
        const existing=await dbOne(client,'SELECT id,email,password_hash FROM users WHERE id=$1 FOR UPDATE',[user.id]);
        if(!existing||!(await verifyPassword(currentPassword,existing.password_hash)))fail(401,'Your current password is incorrect.');
        const emailConflict=await dbOne(client,'SELECT id FROM users WHERE lower(email)=$1 AND id<>$2',[email,user.id]);
        if(emailConflict)fail(409,'That email address is already in use.');
        const changed=[];
        if(existing.email.toLowerCase()!==email)changed.push('email');
        if(newPassword)changed.push('password');
        if(!changed.length)fail(400,'Enter a new email address or password to save.');
        await client.query('UPDATE users SET email=$1,password_hash=COALESCE($2,password_hash) WHERE id=$3',[email,passwordHash,user.id]);
        await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[user.id,sessionHash]);
        await audit(user,'profile.credentials.update','user',user.id,{fields:changed,sessionsRevoked:true},client);
        return {email,changed};
      });
      return json(res,200,{ok:true,email:updated.email,updated:updated.changed});
    }catch(error){if(error.code==='23505')fail(409,'That email address is already in use.');throw error;}
  }
  fail(404,'That VarsityONE endpoint does not exist.');
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const allowedDevOrigins=new Set((process.env.APP_ORIGINS||'http://localhost:5173,http://127.0.0.1:5173').split(',').map(x=>x.trim()).filter(Boolean));
async function handleRequest(req,res){
  const requestId=crypto.randomUUID();res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  const started=Date.now();try{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/')){
      if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.headers.origin;if(origin){let accepted=false;try{const o=new URL(origin);accepted=o.host===req.headers.host||(!isProduction&&allowedDevOrigins.has(o.origin));}catch{}if(!accepted)fail(403,'Request origin is not allowed.');}}
      await handleApi(req,res,url);
    }else{let pathname=decodeURIComponent(url.pathname);if(pathname==='/')pathname='/index.html';let file=path.resolve(PUBLIC,'.'+pathname);if(!file.startsWith(PUBLIC+path.sep)&&file!==path.join(PUBLIC,'index.html'))return json(res,403,{error:'Forbidden'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(PUBLIC,'index.html');if(!fs.existsSync(file))return json(res,503,{error:'The web application bundle has not been built yet. Run npm run build.'});res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':path.extname(file)==='.html'?'no-cache':'public,max-age=3600'});fs.createReadStream(file).pipe(res);}
  }catch(error){const status=error.status||(['23505','23503','23514'].includes(error.code)?409:error.code==='40001'?503:500);const message=error.status?error.message:status===409?'That change conflicts with existing academic data. Review the record and try again.':status===503?'The request conflicted with another update. Please retry.':'The request could not be completed.';if(!res.headersSent)json(res,status,{error:message,requestId});else res.destroy();if(status>=500)console.error(JSON.stringify({level:'error',requestId,path:req.url,method:req.method,code:error.code,message:error.message,elapsedMs:Date.now()-started}));}
}
const server=http.createServer(handleRequest);

let initialization;
function initialize(){
  if(!initialization)initialization=(async()=>{await query('SELECT 1');const migration=await one("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ready");if(!migration?.ready)throw new Error('Database schema is not initialized. Run npm run db:migrate first.');const pending=await one("SELECT count(*)::int AS n FROM schema_migrations");if(!Number(pending?.n))throw new Error('Database has no recorded migrations. Run npm run db:migrate first.');await query(`CREATE TABLE IF NOT EXISTS login_rate_limits (key_hash char(64) PRIMARY KEY,window_started_at timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts>0),updated_at timestamptz NOT NULL)`);await query('CREATE INDEX IF NOT EXISTS login_rate_limits_updated_at_idx ON login_rate_limits(updated_at)');})();
  return initialization.catch(error=>{initialization=null;throw error;});
}
async function start(){try{await initialize();await query('DELETE FROM sessions WHERE expires_at<now()');server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({level:'info',event:'server.ready',port:PORT,environment:process.env.NODE_ENV||'development',database:'neon-postgresql',poolMax:pool.options.max})));}catch(error){console.error(JSON.stringify({level:'fatal',event:'startup.failed',message:error.message}));await pool.end();process.exit(1);}}
if(require.main===module){
  start();
  const sessionCleanup=setInterval(()=>query('DELETE FROM sessions WHERE expires_at<now()').catch(error=>console.error(JSON.stringify({level:'error',event:'session_cleanup.failed',message:error.message}))),60*60_000);sessionCleanup.unref();
  async function shutdown(signal){console.log(JSON.stringify({level:'info',event:'server.shutdown',signal}));server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),15_000).unref();}
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>shutdown(signal));
}
module.exports={handleRequest,initialize,pool};
