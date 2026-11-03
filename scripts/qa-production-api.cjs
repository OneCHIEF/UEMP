const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const normalizeConnectionString = require('./connection-string.cjs');

const baseUrl = String(process.env.VARSITYONE_QA_BASE_URL || 'https://varsityone.vercel.app').replace(/\/$/, '');
const connectionString = normalizeConnectionString(process.env.DATABASE_URL);
if (!connectionString) throw new Error('DATABASE_URL is required to create and clean a short-lived QA session.');
if (new URL(baseUrl).protocol !== 'https:') throw new Error('Production endpoint QA requires an HTTPS URL.');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 10000, application_name: 'varsityone-production-api-qa' });
const suffix = crypto.randomBytes(5).toString('hex').toUpperCase();
const emailBase = `qa-${suffix.toLowerCase()}`;
const password = crypto.randomBytes(24).toString('base64url');
const origin = new URL(baseUrl).origin;
const qaStartedAt = new Date(Date.now() - 1000);
const counts = { passed: 0, failed: 0 };
const qaUsers = [];
const userIds = [];
const resourceIds = [];
let qaSessionHash = '';
let ownerId = 0;
let cleanupErrors = [];

async function check(name, fn) {
  try {
    await fn();
    counts.passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    counts.failed++;
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

async function request(session, route, { method = 'GET', body, expected = 200, originOverride = origin } = {}) {
  const headers = { Accept: 'application/json', Origin: originOverride };
  if (session) headers.Cookie = `uemp_session=${session}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  if (response.status !== expected) {
    const message = (await response.text()).slice(0, 400);
    throw new Error(`${method} ${route} returned ${response.status}; expected ${expected}. ${message}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, data };
}

async function login(email, secret, role) {
  const { response, data } = await request(null, '/login', { method: 'POST', body: { email, password: secret } });
  assert.equal(data.user.role, role);
  const setCookie = response.headers.get('set-cookie') || '';
  const token = setCookie.match(/(?:^|,\s*)uemp_session=([^;]+)/)?.[1];
  assert.ok(token, 'login should return a session cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  return token;
}

async function createUser(admin, role, departmentId, programId) {
  const index = qaUsers.length + 1;
  const email = `${emailBase}-${role}-${index}@varsityone.test`;
  const data = { email, name: `VarsityONE QA ${role} ${suffix}`, password, role, departmentId };
  if (role === 'student') Object.assign(data, { programId, level: 100, matricNo: `QA/${suffix}/${index}` });
  else if (role !== 'super_admin') data.staffNo = `QA/${suffix}/${index}`;
  const { data: result } = await request(admin, '/admin/users', { method: 'POST', body: data, expected: 201 });
  userIds.push(result.id);
  qaUsers.push({ ...data, id: result.id });
  return qaUsers.at(-1);
}

async function main() {
  const db = await pool.connect();
  try {
    const owner = await db.query("SELECT id FROM users WHERE lower(email)='odinigwechu137@gmail.com' AND role='super_admin' AND status='active'");
    assert.equal(owner.rowCount, 1, 'active production super administrator must exist');
    ownerId = Number(owner.rows[0].id);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    qaSessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'30 minutes\')', [qaSessionHash, ownerId]);
    const bootstrap = await request(sessionToken, '/admin/bootstrap');
    const stats = await db.query(`SELECT
      (SELECT count(*) FROM departments)::int AS departments,
      (SELECT count(*) FROM users WHERE role='lecturer' AND status='active')::int AS lecturers,
      (SELECT count(*) FROM users WHERE role='student' AND status='active')::int AS students,
      (SELECT count(*) FROM courses)::int AS courses,
      (SELECT count(*) FROM registrations)::int AS registrations,
      (SELECT count(*) FROM results)::int AS results`);
    const expectedCounts = { departments: 9, lecturers: 42, students: 189, courses: 432 };
    for (const [key, value] of Object.entries(expectedCounts)) assert.equal(stats.rows[0][key], value, `expected ${value} ${key}`);
    const currentSemester = bootstrap.data.semesters.find(row => row.is_current);
    assert.ok(currentSemester, 'a current semester must be configured');
    const csc = bootstrap.data.departments.find(row => row.code === 'CSC');
    const cscProgram = bootstrap.data.programs.find(row => row.department_id === csc.id);
    const foreignCourse = bootstrap.data.courses.find(row => row.department_id !== csc.id && row.semester_id === currentSemester.id);
    assert.ok(csc && cscProgram && foreignCourse, 'seeded academic scope must be available');

    await check('health and production dataset counts', async () => {
      const { data } = await request(null, '/health');
      assert.equal(data.status, 'ok');
      assert.equal(data.service, 'varsityone');
      assert.deepEqual(Object.fromEntries(Object.entries(expectedCounts).map(([k]) => [k, stats.rows[0][k]])), expectedCounts);
    });
    await check('authentication failures and origin protection', async () => {
      await request(null, '/login', { method: 'POST', body: { email: `invalid-${suffix}@varsityone.test`, password: 'incorrect' }, expected: 401 });
      await request(null, '/logout', { method: 'POST', body: {}, originOverride: 'https://invalid.example', expected: 403 });
      const unauthenticatedMe = await request(null, '/me');
      assert.equal(unauthenticatedMe.data.user, null);
      await request(null, '/profile/photo', { expected: 401 });
      await request(null, '/notifications', { expected: 401 });
    });
    await check('preloaded test-role account access', async () => {
      const accounts = JSON.parse(process.env.VARSITYONE_QA_DEMO_CREDENTIALS || '[]');
      assert.ok(accounts.length >= 4, 'provide the prepared role-account credentials for production login verification');
      for (const account of accounts) {
        const token = await login(account.email, account.password, account.role);
        const current = await request(token, '/me');
        assert.equal(current.data.user.role, account.role);
        await request(token, '/logout', { method: 'POST', body: {} });
      }
    });

    const qaFacultyCode = `QF${suffix}`;
    const qaDeptCode = `QD${suffix}`;
    const qaProgramCode = `QP${suffix}`;
    const qaCourseCode = `QC${suffix}`;
    const qaSessionYear = 2100 + (Date.now() % 1000);
    const qaSessionName = `${qaSessionYear}/${qaSessionYear + 1}`;
    const faculty = (await request(sessionToken, '/admin/faculties', { method: 'POST', body: { name: `VarsityONE QA Faculty ${suffix}`, code: qaFacultyCode }, expected: 201 })).data;
    resourceIds.push({ type: 'faculty', id: faculty.id, code: qaFacultyCode });
    const department = (await request(sessionToken, '/admin/departments', { method: 'POST', body: { name: `VarsityONE QA Department ${suffix}`, code: qaDeptCode, facultyId: faculty.id }, expected: 201 })).data;
    resourceIds.push({ type: 'department', id: department.id, code: qaDeptCode });
    const program = (await request(sessionToken, '/admin/programs', { method: 'POST', body: { name: `VarsityONE QA Programme ${suffix}`, code: qaProgramCode, departmentId: department.id, duration: 4 }, expected: 201 })).data;
    resourceIds.push({ type: 'program', id: program.id, code: qaProgramCode });
    const session = (await request(sessionToken, '/admin/sessions', { method: 'POST', body: { name: qaSessionName, current: false }, expected: 201 })).data;
    resourceIds.push({ type: 'session', id: session.id, name: qaSessionName });
    const semester = (await request(sessionToken, '/admin/semesters', { method: 'POST', body: { sessionId: session.id, name: 'First Semester', current: false }, expected: 201 })).data;
    resourceIds.push({ type: 'semester', id: semester.id, name: 'First Semester' });
    const lecturer = await createUser(sessionToken, 'lecturer', department.id);
    const student = await createUser(sessionToken, 'student', department.id, program.id);
    const hod = await createUser(sessionToken, 'department_admin', department.id);
    const course = (await request(sessionToken, '/admin/courses', { method: 'POST', body: { code: qaCourseCode, title: `QA workflow course ${suffix}`, units: 3, departmentId: department.id, programId: program.id, level: 100, semesterId: currentSemester.id }, expected: 201 })).data;
    resourceIds.push({ type: 'course', id: course.id, code: qaCourseCode });

    await check('department, programme, session, semester and account creation', async () => {
      assert.ok(faculty.id && department.id && program.id && session.id && semester.id && lecturer.id && student.id && hod.id && course.id);
      await request(sessionToken, `/admin/faculties/${faculty.id}`, { method: 'PATCH', body: { name: `VarsityONE QA Faculty ${suffix}`, code: qaFacultyCode } });
      await request(sessionToken, `/admin/departments/${department.id}`, { method: 'PATCH', body: { facultyId: faculty.id, name: `VarsityONE QA Department ${suffix}`, code: qaDeptCode } });
      await request(sessionToken, `/admin/programs/${program.id}`, { method: 'PATCH', body: { departmentId: department.id, name: `VarsityONE QA Programme ${suffix}`, code: qaProgramCode, duration: 4 } });
      await request(sessionToken, `/admin/sessions/${session.id}`, { method: 'PATCH', body: { name: qaSessionName, current: false } });
      await request(sessionToken, `/admin/semesters/${semester.id}`, { method: 'PATCH', body: { sessionId: session.id, name: 'First Semester', current: false } });
      await request(sessionToken, `/admin/users/${lecturer.id}`, { method: 'PATCH', body: { name: lecturer.name, email: lecturer.email, phone: '+234 801 234 5678' } });
      const { data } = await request(sessionToken, '/admin/bootstrap');
      assert.ok(data.departments.some(row => row.code === qaDeptCode));
      assert.ok(data.programs.some(row => row.code === qaProgramCode));
      assert.ok(data.courses.some(row => row.code === qaCourseCode));
      assert.equal(data.users.find(row => row.id === lecturer.id).phone, '+234 801 234 5678');
    });

    await check('course edit and activation endpoints', async () => {
      await request(sessionToken, `/admin/courses/${course.id}`, { method: 'PATCH', body: { code: qaCourseCode, title: `Updated QA course ${suffix}`, units: 4 } });
      await request(sessionToken, `/admin/courses/${course.id}/status`, { method: 'PATCH', body: { isActive: false } });
      await request(sessionToken, `/admin/courses/${course.id}/status`, { method: 'PATCH', body: { isActive: true } });
    });

    await check('course assignment create and remove', async () => {
      await request(sessionToken, '/admin/assignments', { method: 'POST', body: { courseId: course.id, lecturerId: lecturer.id } });
      await request(sessionToken, `/admin/assignments/${course.id}/${lecturer.id}`, { method: 'DELETE' });
      await request(sessionToken, '/admin/assignments', { method: 'POST', body: { courseId: course.id, lecturerId: lecturer.id } });
    });

    const studentSession = await login(student.email, student.password, 'student');
    const lecturerSession = await login(lecturer.email, lecturer.password, 'lecturer');
    let hodSession = await login(hod.email, hod.password, 'department_admin');
    await check('super-admin account browser, all-role profiles, filters and authorization', async () => {
      for (const role of ['student', 'lecturer', 'department_admin', 'super_admin']) {
        const params = new URLSearchParams({ role, status: 'all', page: '0', limit: '2' });
        const result = await request(sessionToken, `/admin/accounts?${params}`);
        assert.ok(result.data.total > 0, `there should be ${role} accounts to browse`);
        assert.ok(result.data.accounts.length > 0 && result.data.accounts.length <= 2, 'account list should respect pagination');
        const account = result.data.accounts[0];
        assert.equal(account.role, role);
        const profile = await request(sessionToken, `/admin/accounts/${account.id}/profile`);
        assert.equal(profile.data.profile.role, role);
        assert.ok(profile.data.profile.email && profile.data.profile.name, 'profile should include account identity');
      }
      await request(sessionToken, `/admin/accounts?${new URLSearchParams({ role: 'student', q: `QA/${suffix}`, status: 'all' })}`);
      await request(sessionToken, '/admin/accounts?role=invalid', { expected: 400 });
      await request(studentSession, '/admin/accounts?role=student', { expected: 403 });
      await request(studentSession, `/admin/accounts/${student.id}/profile`, { expected: 403 });
      await request(studentSession, `/admin/accounts/${student.id}/photo`, { expected: 403 });
    });
    await check('role dashboard, course catalogue, registration, result and profile reads', async () => {
      for (const [roleSession, role] of [[studentSession, 'student'], [lecturerSession, 'lecturer'], [hodSession, 'department_admin'], [sessionToken, 'super_admin']]) {
        const dashboard = await request(roleSession, '/dashboard');
        assert.equal(dashboard.data.role, role);
        await request(roleSession, '/courses');
        await request(roleSession, '/registrations');
        await request(roleSession, '/results');
        const notifications = await request(roleSession, '/notifications');
        assert.ok(Array.isArray(notifications.data.notifications));
      }
      const departmentBootstrap = await request(hodSession, '/admin/bootstrap');
      assert.equal(departmentBootstrap.data.departments.length, 1, 'department admins must only see their department');
      assert.equal(departmentBootstrap.data.faculties.length, 1, 'department admins must only see their own faculty');
      await request(hodSession, '/audit');
      await request(hodSession, '/reports');
      await request(sessionToken, '/audit');
      await request(sessionToken, '/reports');
    });

    await check('role access boundaries and ownership checks', async () => {
      await request(studentSession, '/admin/bootstrap', { expected: 403 });
      await request(studentSession, `/courses/${course.id}/results`, { expected: 403 });
      await request(studentSession, `/courses/${course.id}/review`, { method: 'POST', body: { decision: 'approve' }, expected: 403 });
      await request(lecturerSession, `/courses/${foreignCourse.id}/results`, { expected: 403 });
      await request(lecturerSession, `/courses/${foreignCourse.id}/results`, { method: 'POST', body: { entries: [] }, expected: 403 });
      await request(lecturerSession, `/courses/${course.id}/review`, { method: 'POST', body: { decision: 'approve' }, expected: 403 });
      await request(hodSession, `/courses/${foreignCourse.id}/review`, { method: 'POST', body: { decision: 'approve' }, expected: 403 });
      await request(hodSession, '/admin/faculties', { method: 'POST', body: { name: 'Forbidden', code: `X${suffix}` }, expected: 403 });
      const foreignFacultyId = bootstrap.data.departments.find(row => row.code === 'CSC').faculty_id;
      await request(hodSession, `/admin/faculties/${foreignFacultyId}`, { method: 'PATCH', body: { name: 'Forbidden', code: `X${suffix}` }, expected: 403 });
      await request(hodSession, `/admin/sessions/${session.id}`, { method: 'PATCH', body: { name: qaSessionName, current: false }, expected: 403 });
      const foreignStudent = bootstrap.data.users.find(row => row.role === 'student' && row.department_id !== department.id);
      assert.ok(foreignStudent, 'a foreign department student must exist for scope verification');
      await request(hodSession, `/admin/users/${foreignStudent.id}`, { method: 'PATCH', body: { name: foreignStudent.name, email: foreignStudent.email, phone: '+234 801 234 5678' }, expected: 403 });
      await request(hodSession, `/admin/users/${lecturer.id}`, { method: 'PATCH', body: { name: lecturer.name, email: lecturer.email, phone: '+234 801 234 5678' } });
      await request(studentSession, '/registrations', { method: 'POST', body: { courseIds: [foreignCourse.id] }, expected: 403 });
    });

    await check('registration, class lists and complete result approval workflow', async () => {
      await request(studentSession, '/registrations', { method: 'POST', body: { courseIds: [course.id] }, expected: 201 });
      await request(studentSession, '/registrations', { method: 'POST', body: { courseIds: [course.id] }, expected: 409 });
      const classList = await request(lecturerSession, `/courses/${course.id}/results`);
      assert.equal(classList.data.students.length, 1);
      const studentId = classList.data.students[0].student_id;
      const entry = { studentId, ca: 24, exam: 62 };
      await request(lecturerSession, `/courses/${course.id}/results`, { method: 'POST', body: { entries: [entry], submit: false } });
      await request(lecturerSession, `/courses/${course.id}/results`, { method: 'POST', body: { entries: [entry], submit: true } });
      const reviewNotifications = await request(hodSession, '/notifications');
      assert.ok(reviewNotifications.data.notifications.some(item => item.message.includes(qaCourseCode)), 'department admin should be notified of submitted results');
      await request(lecturerSession, `/courses/${course.id}/results`, { method: 'POST', body: { entries: [entry], submit: true }, expected: 409 });
      const privateResults = await request(studentSession, '/results');
      assert.equal(privateResults.data.results.length, 0);
      await request(hodSession, `/courses/${course.id}/review`, { method: 'POST', body: { decision: 'return', feedback: 'QA correction cycle.' } });
      const returnedNotifications = await request(lecturerSession, '/notifications');
      assert.ok(returnedNotifications.data.notifications.some(item => item.message.includes(qaCourseCode)), 'lecturer should be notified of returned results');
      await request(lecturerSession, `/courses/${course.id}/results`, { method: 'POST', body: { entries: [{ studentId, ca: 27, exam: 65 }], submit: true } });
      await request(hodSession, `/courses/${course.id}/review`, { method: 'POST', body: { decision: 'approve' } });
      const approved = await request(studentSession, '/results');
      assert.equal(approved.data.results.length, 1);
      assert.equal(approved.data.results[0].grade, 'A');
      const studentNotifications = await request(studentSession, '/notifications');
      assert.ok(studentNotifications.data.notifications.some(item => item.title === 'Result approved' && item.message.includes(qaCourseCode)), 'student should be notified when an approved result is published');
    });

    await check('profile update, photo read/remove, invalid image rejection and current account', async () => {
      await request(studentSession, '/profile', { method: 'PATCH', body: { name: student.name, phone: '+234 801 234 5678' } });
      await request(lecturerSession, '/profile', { method: 'PATCH', body: { name: lecturer.name, phone: '+234 801 234 5678' } });
      await request(hodSession, '/profile', { method: 'PATCH', body: { name: hod.name, phone: '+234 801 234 5678' } });
      const ownerProfile = await request(sessionToken, '/me');
      await request(sessionToken, '/profile', { method: 'PATCH', body: { name: ownerProfile.data.user.name, phone: ownerProfile.data.user.phone } });
      const current = await request(studentSession, '/me');
      assert.equal(current.data.user.phone, '+234 801 234 5678');
      await request(studentSession, '/profile/photo', { expected: 404 });
      await request(studentSession, '/profile/photo', { method: 'PUT', body: { image: 'data:image/png;base64,AAAA' }, expected: 400 });
      const image = process.env.VARSITYONE_QA_JPEG;
      if (!image) throw new Error('Provide an in-memory 1×1 JPEG in VARSITYONE_QA_JPEG for photo upload coverage.');
      await request(studentSession, '/profile/photo', { method: 'PUT', body: { image } });
      const uploadedPhoto = await request(studentSession, '/profile/photo');
      assert.ok(Buffer.isBuffer(uploadedPhoto.data) && uploadedPhoto.data.length > 100);
      assert.equal(uploadedPhoto.response.headers.get('content-type'), 'image/jpeg');
      await request(studentSession, '/profile/photo', { method: 'DELETE' });
      await request(studentSession, '/profile/photo', { expected: 404 });
      await request(studentSession, '/profile', { method: 'PATCH', body: { name: 'Invalid', phone: 'x' }, expected: 400 });
    });

    await check('user status and role management endpoints', async () => {
      await request(sessionToken, `/admin/users/${hod.id}/status`, { method: 'PATCH', body: { status: 'inactive' } });
      await request(sessionToken, `/admin/users/${hod.id}/status`, { method: 'PATCH', body: { status: 'active' } });
      await request(sessionToken, `/admin/users/${hod.id}/role`, { method: 'PATCH', body: { role: 'lecturer', departmentId: department.id, staffNo: `QA/${suffix}/HOD` } });
      await request(sessionToken, `/admin/users/${hod.id}/role`, { method: 'PATCH', body: { role: 'department_admin', departmentId: department.id, staffNo: `QA/${suffix}/HOD` } });
      hodSession = await login(hod.email, hod.password, 'department_admin');
      await request(hodSession, '/me');
    });

    await check('unknown endpoint, invalid registration and review validation', async () => {
      await request(sessionToken, '/missing-endpoint', { expected: 404 });
      await request(studentSession, '/registrations', { method: 'POST', body: { courseIds: [] }, expected: 400 });
      await request(hodSession, `/courses/${course.id}/review`, { method: 'POST', body: { decision: 'invalid' }, expected: 400 });
    });

    await check('logout and revoked session behavior', async () => {
      await request(studentSession, '/logout', { method: 'POST', body: {} });
      const clearedSession = await request(studentSession, '/me');
      assert.equal(clearedSession.data.user, null);
      await request(lecturerSession, '/logout', { method: 'POST', body: {} });
      await request(hodSession, '/logout', { method: 'POST', body: {} });
    });

    const summary = await db.query('SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND created_at >= $2', [ownerId, qaStartedAt]);
    console.log(`QA audit records created by production super-admin test session: ${summary.rows[0].n}`);
  } finally {
    try {
      await db.query('BEGIN');
      if (qaUsers.length) {
        const qaIds = userIds;
        await db.query(`DELETE FROM results WHERE student_id=ANY($1::int[]) OR course_id=ANY($2::int[])`, [qaIds, resourceIds.filter(row => row.type === 'course').map(row => row.id)]);
        await db.query(`DELETE FROM registrations WHERE student_id=ANY($1::int[]) OR course_id=ANY($2::int[])`, [qaIds, resourceIds.filter(row => row.type === 'course').map(row => row.id)]);
        await db.query('DELETE FROM course_assignments WHERE course_id=ANY($1::int[]) OR lecturer_id=ANY($2::int[])', [resourceIds.filter(row => row.type === 'course').map(row => row.id), qaIds]);
        await db.query('DELETE FROM profile_photos WHERE user_id=ANY($1::int[])', [qaIds]);
        await db.query('DELETE FROM sessions WHERE user_id=ANY($1::int[])', [qaIds]);
        await db.query('DELETE FROM audit_events WHERE actor_id=ANY($1::int[]) OR (actor_id=$2 AND entity_id=ANY($3::int[]))', [qaIds, ownerId, [...qaIds, ...resourceIds.map(row => row.id)]]);
        await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [qaIds]);
      }
      const courseIds = resourceIds.filter(row => row.type === 'course').map(row => row.id);
      if (courseIds.length) await db.query('DELETE FROM courses WHERE id=ANY($1::int[])', [courseIds]);
      const semesterIds = resourceIds.filter(row => row.type === 'semester').map(row => row.id);
      if (semesterIds.length) await db.query('DELETE FROM semesters WHERE id=ANY($1::int[])', [semesterIds]);
      const sessionIds = resourceIds.filter(row => row.type === 'session').map(row => row.id);
      if (sessionIds.length) await db.query('DELETE FROM academic_sessions WHERE id=ANY($1::int[])', [sessionIds]);
      const programIds = resourceIds.filter(row => row.type === 'program').map(row => row.id);
      if (programIds.length) await db.query('DELETE FROM programs WHERE id=ANY($1::int[])', [programIds]);
      const departmentIds = resourceIds.filter(row => row.type === 'department').map(row => row.id);
      if (departmentIds.length) await db.query('DELETE FROM departments WHERE id=ANY($1::int[])', [departmentIds]);
      const facultyIds = resourceIds.filter(row => row.type === 'faculty').map(row => row.id);
      if (facultyIds.length) await db.query('DELETE FROM faculties WHERE id=ANY($1::int[])', [facultyIds]);
      if (qaSessionHash) await db.query('DELETE FROM sessions WHERE token_hash=$1', [qaSessionHash]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      cleanupErrors.push(error.message);
    }
    db.release();
    await pool.end();
    if (cleanupErrors.length) console.error(`QA cleanup needs attention: ${cleanupErrors.join('; ')}`);
    console.log(JSON.stringify({ status: counts.failed ? 'failed' : cleanupErrors.length ? 'cleanup_failed' : 'ok', ...counts, cleanupErrors }));
  }
}

main().catch(error => {
  console.error(`Production API QA failed: ${error.message}`);
  process.exitCode = 1;
});
