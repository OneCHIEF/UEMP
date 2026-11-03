const crypto = require('node:crypto');
const { Pool } = require('pg');
const normalizeConnectionString = require('./connection-string.cjs');

if (process.env.VARSITYONE_CONFIRM_PRODUCTION_DATA !== 'I_CONFIRM_VARSITYONE_PRODUCTION_DATA') {
  throw new Error('Set VARSITYONE_CONFIRM_PRODUCTION_DATA=I_CONFIRM_VARSITYONE_PRODUCTION_DATA to confirm intentional institutional data seeding.');
}

const connectionString = normalizeConnectionString(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL);
if (!connectionString) throw new Error('Set DATABASE_URL to the VarsityONE Neon PostgreSQL connection string.');
if (process.env.VARSITYONE_TARGET_BRANCH !== 'production') throw new Error('Set VARSITYONE_TARGET_BRANCH=production to confirm the intended Neon deployment branch.');
const connectionHost = new URL(connectionString).hostname;
if (!connectionHost.endsWith('.neon.tech')) throw new Error('The institutional seed requires a Neon PostgreSQL endpoint.');
const testPasswords = {
  departmentAdmin: process.env.VARSITYONE_TEST_HOD_PASSWORD,
  lecturer: process.env.VARSITYONE_TEST_LECTURER_PASSWORD,
  student: process.env.VARSITYONE_TEST_STUDENT_PASSWORD,
  secondStudent: process.env.VARSITYONE_TEST_STUDENT2_PASSWORD,
};
if (Object.values(testPasswords).some(value => typeof value !== 'string' || value.length < 20 || value.length > 256) || new Set(Object.values(testPasswords)).size !== Object.keys(testPasswords).length) {
  throw new Error('Set four distinct VarsityONE test-account passwords of at least 20 characters in the operator environment.');
}
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  application_name: 'varsityone-institution-seed',
});

const facultyRows = [
  { name: 'Faculty of Science and Technology', code: 'FST' },
  { name: 'Faculty of Engineering and the Built Environment', code: 'FEBE' },
  { name: 'Faculty of Management and Social Sciences', code: 'FMSS' },
];
const departmentRows = [
  { code: 'CSC', name: 'Computer Science', faculty: 'FST', program: 'B.Sc. Computer Science', programCode: 'BSC-CS', discipline: 'Computing', topics: ['Programming Fundamentals', 'Data Structures', 'Database Systems', 'Software Engineering', 'Computer Networks', 'Artificial Intelligence', 'Cybersecurity', 'Cloud Computing', 'Human Computer Interaction', 'Operating Systems', 'Data Analytics', 'Research Methods'] },
  { code: 'MTH', name: 'Mathematics', faculty: 'FST', program: 'B.Sc. Mathematics', programCode: 'BSC-MTH', discipline: 'Mathematics', topics: ['Calculus', 'Linear Algebra', 'Real Analysis', 'Differential Equations', 'Numerical Methods', 'Probability Theory', 'Abstract Algebra', 'Mathematical Modelling', 'Operations Research', 'Topology', 'Statistics', 'Research Methods'] },
  { code: 'PHY', name: 'Physics', faculty: 'FST', program: 'B.Sc. Physics', programCode: 'BSC-PHY', discipline: 'Physics', topics: ['Mechanics', 'Electricity and Magnetism', 'Waves and Optics', 'Thermodynamics', 'Modern Physics', 'Electronics', 'Quantum Mechanics', 'Solid State Physics', 'Computational Physics', 'Nuclear Physics', 'Laboratory Methods', 'Research Methods'] },
  { code: 'CHE', name: 'Chemistry', faculty: 'FST', program: 'B.Sc. Chemistry', programCode: 'BSC-CHE', discipline: 'Chemistry', topics: ['General Chemistry', 'Organic Chemistry', 'Inorganic Chemistry', 'Physical Chemistry', 'Analytical Chemistry', 'Chemical Kinetics', 'Spectroscopy', 'Environmental Chemistry', 'Industrial Chemistry', 'Materials Chemistry', 'Laboratory Methods', 'Research Methods'] },
  { code: 'BIO', name: 'Biological Sciences', faculty: 'FST', program: 'B.Sc. Biological Sciences', programCode: 'BSC-BIO', discipline: 'Biological Sciences', topics: ['Cell Biology', 'Genetics', 'Ecology', 'Microbiology', 'Biochemistry', 'Evolutionary Biology', 'Molecular Biology', 'Biotechnology', 'Animal Physiology', 'Plant Science', 'Laboratory Methods', 'Research Methods'] },
  { code: 'EEE', name: 'Electrical and Electronics Engineering', faculty: 'FEBE', program: 'B.Eng. Electrical and Electronics Engineering', programCode: 'BENG-EEE', discipline: 'Electrical Engineering', topics: ['Circuit Analysis', 'Electromagnetic Fields', 'Digital Logic', 'Signals and Systems', 'Control Engineering', 'Power Systems', 'Telecommunications', 'Embedded Systems', 'Renewable Energy', 'Electrical Machines', 'Engineering Design', 'Research Methods'] },
  { code: 'CVE', name: 'Civil and Environmental Engineering', faculty: 'FEBE', program: 'B.Eng. Civil Engineering', programCode: 'BENG-CVE', discipline: 'Civil Engineering', topics: ['Engineering Surveying', 'Structural Analysis', 'Geotechnical Engineering', 'Fluid Mechanics', 'Transportation Engineering', 'Construction Materials', 'Water Resources', 'Environmental Engineering', 'Project Planning', 'Concrete Design', 'Engineering Design', 'Research Methods'] },
  { code: 'BUS', name: 'Business Administration', faculty: 'FMSS', program: 'B.Sc. Business Administration', programCode: 'BSC-BUS', discipline: 'Business Administration', topics: ['Principles of Management', 'Financial Accounting', 'Marketing', 'Business Law', 'Organisational Behaviour', 'Corporate Finance', 'Operations Management', 'Entrepreneurship', 'Strategic Management', 'Business Analytics', 'Human Resources', 'Research Methods'] },
  { code: 'ECO', name: 'Economics', faculty: 'FMSS', program: 'B.Sc. Economics', programCode: 'BSC-ECO', discipline: 'Economics', topics: ['Microeconomics', 'Macroeconomics', 'Mathematical Economics', 'Econometrics', 'Public Finance', 'Development Economics', 'International Trade', 'Monetary Economics', 'Labour Economics', 'Economic Policy', 'Nigerian Economy', 'Research Methods'] },
];

const firstNames = ['Adaeze', 'Amina', 'Amara', 'Binta', 'Chiamaka', 'Damilola', 'Efe', 'Emeka', 'Fiyin', 'Hauwa', 'Ifeoma', 'Ibrahim', 'Kelechi', 'Lara', 'Mariam', 'Nneka', 'Obinna', 'Oluwaseun', 'Tobi', 'Zainab'];
const lastNames = ['Adebayo', 'Adeyemi', 'Bello', 'Chukwu', 'Eze', 'Ibrahim', 'James', 'Mohammed', 'Nwosu', 'Obi', 'Okafor', 'Olawale', 'Osei', 'Udo', 'Yusuf'];
const levelDescriptors = {
  100: 'Foundations',
  200: 'Intermediate Studies',
  300: 'Advanced Applications',
  400: 'Professional Practice',
};
const levels = [100, 200, 300, 400];
const passwordHash = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
};

async function main() {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [71024012]);
    lockHeld = true;
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const baseline = await client.query("SELECT id FROM users WHERE lower(email)='odinigwechu137@gmail.com' AND role='super_admin' AND status='active'");
    if (!baseline.rowCount) throw new Error('The target does not contain the expected active VarsityONE production super administrator.');
    let currentTerm = await client.query('SELECT id FROM semesters WHERE is_current=true');
    if (!currentTerm.rowCount) {
      await client.query('UPDATE academic_sessions SET is_current=false WHERE is_current=true');
      const session = await client.query(`INSERT INTO academic_sessions(name,is_current) VALUES('2026/2027',true)
        ON CONFLICT(name) DO UPDATE SET is_current=true RETURNING id`);
      await client.query('UPDATE academic_sessions SET is_current=false WHERE id<>$1 AND is_current=true', [session.rows[0].id]);
      const semester = await client.query(`INSERT INTO semesters(session_id,name,is_current) VALUES($1,'First Semester',true)
        ON CONFLICT(session_id,name) DO UPDATE SET is_current=true RETURNING id`, [session.rows[0].id]);
      await client.query('UPDATE semesters SET is_current=false WHERE id<>$1 AND is_current=true', [semester.rows[0].id]);
      currentTerm = { rows: [{ id: semester.rows[0].id }], rowCount: 1 };
    }
    const semesterId = currentTerm.rows[0].id;
    const faculties = new Map();
    const departments = new Map();
    const programs = new Map();

    for (const faculty of facultyRows) {
      const row = (await client.query('INSERT INTO faculties(name,code) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id', [faculty.name, faculty.code])).rows[0];
      faculties.set(faculty.code, row.id);
    }
    for (const department of departmentRows) {
      const row = (await client.query('INSERT INTO departments(faculty_id,name,code) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET faculty_id=EXCLUDED.faculty_id,name=EXCLUDED.name RETURNING id', [faculties.get(department.faculty), department.name, department.code])).rows[0];
      departments.set(department.code, row.id);
    }
    for (const department of departmentRows) {
      const row = (await client.query('INSERT INTO programs(department_id,name,code,duration) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO UPDATE SET department_id=EXCLUDED.department_id,name=EXCLUDED.name,duration=EXCLUDED.duration RETURNING id', [departments.get(department.code), department.program, department.programCode, department.code === 'EEE' || department.code === 'CVE' ? 5 : 4])).rows[0];
      programs.set(department.code, row.id);
    }

    const accountRows = [];
    accountRows.push({ email: 'hod@uemp.demo', role: 'department_admin', name: 'Dr. Chika Nwosu', department: 'CSC', staff: 'VONE/CSC/HOD', password: testPasswords.departmentAdmin });

    departmentRows.slice(1).forEach((department, index) => accountRows.push({
      email: `hod${String(index + 1).padStart(2, '0')}@varsityone.demo`,
      role: 'department_admin',
      name: `Dr. ${firstNames[(index + 3) % firstNames.length]} ${lastNames[(index + 4) % lastNames.length]}`,
      department: department.code,
      staff: `VONE/${department.code}/HOD`,
      password: crypto.randomBytes(32).toString('base64url'),
    }));

    accountRows.push({ email: 'lecturer@uemp.demo', role: 'lecturer', name: 'Tunde Adeyemi', department: 'CSC', staff: 'VONE/CSC/014', password: testPasswords.lecturer });
    for (let i = 1; i <= 41; i++) {
      const department = departmentRows[(i - 1) % departmentRows.length];
      accountRows.push({
        email: `lecturer${String(i).padStart(2, '0')}@varsityone.demo`,
        role: 'lecturer',
        name: `Dr. ${firstNames[(i + 7) % firstNames.length]} ${lastNames[(i + 2) % lastNames.length]}`,
        department: department.code,
        staff: `VONE/${department.code}/L${String(i).padStart(3, '0')}`,
        password: crypto.randomBytes(32).toString('base64url'),
      });
    }

    accountRows.push({ email: 'student@uemp.demo', role: 'student', name: 'Zainab Bello', department: 'CSC', program: 'CSC', level: 300, matric: 'CSC/2023/014', password: testPasswords.student });
    accountRows.push({ email: 'student2@uemp.demo', role: 'student', name: 'Emeka Obi', department: 'CSC', program: 'CSC', level: 300, matric: 'CSC/2023/027', password: testPasswords.secondStudent });

    let studentNumber = 3;
    for (const department of departmentRows) {
      const count = department.code === 'CSC' ? 19 : 21;
      for (let i = 0; i < count; i++, studentNumber++) {
        const level = levels[i % levels.length];
        accountRows.push({
          email: `student${String(studentNumber).padStart(3, '0')}@varsityone.demo`,
          role: 'student',
          name: `${firstNames[(studentNumber * 7) % firstNames.length]} ${lastNames[(studentNumber * 11) % lastNames.length]}`,
          department: department.code,
          program: department.code,
          level,
          matric: `V1/${department.code}/2026/${String(i + 1).padStart(3, '0')}`,
          password: crypto.randomBytes(32).toString('base64url'),
        });
      }
    }
    if (studentNumber !== 190) throw new Error(`Expected to prepare 187 new students; prepared ${studentNumber - 3}.`);

    const userIds = new Map();
    const userColumns = [[], [], [], [], [], [], [], [], []];
    for (const account of accountRows) {
      const values = [account.email, passwordHash(account.password), account.role, account.name, account.department ? departments.get(account.department) : null, account.program ? programs.get(account.program) : null, account.level ?? null, account.matric ?? null, account.staff ?? null];
      values.forEach((value, index) => userColumns[index].push(value));
    }
    const users = await client.query(`INSERT INTO users(email,password_hash,role,name,department_id,program_id,level,matric_no,staff_no)
      SELECT email,password_hash,role,name,department_id,program_id,level,matric_no,staff_no
      FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::integer[],$6::integer[],$7::smallint[],$8::text[],$9::text[])
      AS u(email,password_hash,role,name,department_id,program_id,level,matric_no,staff_no)
      ON CONFLICT(lower(email)) DO UPDATE SET role=EXCLUDED.role,name=EXCLUDED.name,department_id=EXCLUDED.department_id,program_id=EXCLUDED.program_id,level=EXCLUDED.level,matric_no=EXCLUDED.matric_no,staff_no=EXCLUDED.staff_no
      RETURNING id,email` , userColumns);
    for (const row of users.rows) userIds.set(row.email, row.id);
    const lecturersByDepartment = new Map(departmentRows.map(department => [department.code, []]));
    for (const account of accountRows.filter(row => row.role === 'lecturer')) lecturersByDepartment.get(account.department).push(userIds.get(account.email));

    const courseByDepartmentLevel = new Map();
    const allCourses = [];
    const courseColumns = [[], [], [], [], [], [], []];
    for (const department of departmentRows) {
      for (const level of levels) {
        for (let index = 0; index < 12; index++) {
          const code = `${department.code}${level}${String(index + 1).padStart(2, '0')}`;
          const title = `${levelDescriptors[level]}: ${department.topics[index]}`;
          const units = index % 4 === 3 ? 2 : 3;
          [code, title, units, departments.get(department.code), programs.get(department.code), level, semesterId].forEach((value, column) => courseColumns[column].push(value));
        }
      }
    }
    const insertedCourses = await client.query(`INSERT INTO courses(code,title,units,department_id,program_id,level,semester_id)
      SELECT code,title,units,department_id,program_id,level,semester_id
      FROM unnest($1::text[],$2::text[],$3::smallint[],$4::integer[],$5::integer[],$6::smallint[],$7::integer[])
      AS c(code,title,units,department_id,program_id,level,semester_id)
      ON CONFLICT(code) DO UPDATE SET title=EXCLUDED.title,units=EXCLUDED.units,department_id=EXCLUDED.department_id,program_id=EXCLUDED.program_id,level=EXCLUDED.level,semester_id=EXCLUDED.semester_id
      RETURNING id,code`, courseColumns);
    const courseIdsByCode = new Map(insertedCourses.rows.map(row => [row.code, row.id]));
    for (const department of departmentRows) for (const level of levels) {
      courseByDepartmentLevel.set(`${department.code}:${level}`, Array.from({ length: 12 }, (_, index) => courseIdsByCode.get(`${department.code}${level}${String(index + 1).padStart(2, '0')}`)));
      for (let index = 0; index < 12; index++) {
        const code = `${department.code}${level}${String(index + 1).padStart(2, '0')}`;
        allCourses.push({ id: courseIdsByCode.get(code), code, department: department.code, level, index });
      }
    }
    const assignmentColumns = [[], [], []];
    for (const course of allCourses) {
      const lecturers = lecturersByDepartment.get(course.department);
      const lecturerId = lecturers[course.index % lecturers.length];
      [course.id, lecturerId, baseline.rows[0].id].forEach((value, index) => assignmentColumns[index].push(value));
    }
    await client.query(`INSERT INTO course_assignments(course_id,lecturer_id,assigned_by)
      SELECT course_id,lecturer_id,assigned_by FROM unnest($1::integer[],$2::integer[],$3::integer[]) AS a(course_id,lecturer_id,assigned_by)
      ON CONFLICT(course_id,lecturer_id) DO NOTHING`, assignmentColumns);

    const students = accountRows.filter(row => row.role === 'student');
    const registrationValues = [];
    const resultValues = [];
    for (const student of students) {
      const studentId = userIds.get(student.email);
      const courseIds = courseByDepartmentLevel.get(`${student.department}:${student.level}`);
      for (let index = 0; index < 6; index++) {
        const courseId = courseIds[index];
        registrationValues.push([studentId, courseId, semesterId]);
        if (index < 5) {
          const ca = 15 + ((studentId * 7 + index * 3) % 16);
          const exam = 35 + ((studentId * 11 + index * 5) % 36);
          const total = ca + exam;
          const [grade, gradePoint] = total >= 70 ? ['A', 5] : total >= 60 ? ['B', 4] : total >= 50 ? ['C', 3] : total >= 45 ? ['D', 2] : total >= 40 ? ['E', 1] : ['F', 0];
          const status = index < 3 ? 'approved' : index === 3 ? 'submitted' : 'draft';
          resultValues.push([studentId, courseId, semesterId, ca, exam, total, grade, gradePoint, status]);
        }
      }
    }
    await client.query(`INSERT INTO registrations(student_id,course_id,semester_id)
      SELECT student_id,course_id,semester_id FROM unnest($1::integer[],$2::integer[],$3::integer[]) AS r(student_id,course_id,semester_id)
      ON CONFLICT(student_id,course_id,semester_id) DO NOTHING`, registrationValues.reduce((columns,row)=>{row.forEach((value,index)=>(columns[index]??=[]).push(value));return columns;},[]));
    const resultColumns = resultValues.reduce((columns,row)=>{row.forEach((value,index)=>(columns[index]??=[]).push(value));return columns;},[]);
    await client.query(`INSERT INTO results(student_id,course_id,semester_id,ca,exam,total,grade,grade_point,status,submitted_at,reviewed_at)
      SELECT student_id,course_id,semester_id,ca,exam,total,grade,grade_point,status,
        CASE WHEN status IN ('submitted','approved') THEN now()-interval '2 days' END,
        CASE WHEN status='approved' THEN now()-interval '1 day' END
      FROM unnest($1::integer[],$2::integer[],$3::integer[],$4::numeric[],$5::numeric[],$6::numeric[],$7::text[],$8::numeric[],$9::text[])
      AS x(student_id,course_id,semester_id,ca,exam,total,grade,grade_point,status)
      ON CONFLICT(student_id,course_id,semester_id) DO NOTHING`, resultColumns);

    const marked = await client.query("SELECT 1 FROM audit_events WHERE details->>'seedBatch'='varsityone-institution-2026' LIMIT 1");
    if (!marked.rowCount) {
      const eventRows = [];
      for (const department of departmentRows) {
        const adminAccount = accountRows.find(row => row.role === 'department_admin' && row.department === department.code);
        for (const level of levels) {
          const submitCourse = allCourses.find(course => course.department === department.code && course.level === level && course.index === 3);
          const lecturerId = lecturersByDepartment.get(department.code)[3 % lecturersByDepartment.get(department.code).length];
          for (let index = 0; index < 4; index++) {
            const course = allCourses.find(item => item.department === department.code && item.level === level && item.index === index);
            eventRows.push([lecturersByDepartment.get(department.code)[index % lecturersByDepartment.get(department.code).length], index === 3 ? 'result.submit' : 'result.approve', course.id, JSON.stringify({ seedBatch: 'varsityone-institution-2026', courseCode: course.code, count: students.filter(student => student.department === department.code && student.level === level).length })]);
          }
          if (!adminAccount || !submitCourse || !lecturerId) throw new Error(`Could not prepare workflow audit data for ${department.code} ${level}.`);
        }
      }
      const eventColumns = eventRows.reduce((columns,row)=>{row.forEach((value,index)=>(columns[index]??=[]).push(value));return columns;},[]);
      await client.query(`INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details)
        SELECT actor_id,action,'course',course_id,details::jsonb
        FROM unnest($1::integer[],$2::text[],$3::integer[],$4::text[]) AS e(actor_id,action,course_id,details)`, eventColumns);
      await client.query('INSERT INTO audit_events(actor_id,action,entity_type,details) VALUES($1,\'institution.dataset.seed\',\'university\',$2::jsonb)', [baseline.rows[0].id, JSON.stringify({ seedBatch: 'varsityone-institution-2026', departments: 9, lecturers: 42, students: 189, generatedCourses: 432 })]);
    }

    await client.query('COMMIT');
    const summary = await client.query(`SELECT 'departments' AS metric,count(*)::int AS count FROM departments
      UNION ALL SELECT 'lecturers',count(*)::int FROM users WHERE role='lecturer'
      UNION ALL SELECT 'students',count(*)::int FROM users WHERE role='student'
      UNION ALL SELECT 'courses',count(*)::int FROM courses
      UNION ALL SELECT 'registrations',count(*)::int FROM registrations
      UNION ALL SELECT 'results',count(*)::int FROM results`);
    console.log(JSON.stringify({ status: 'ok', counts: Object.fromEntries(summary.rows.map(row => [row.metric, row.count])) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock($1)', [71024012]).catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch(error => { console.error(`VarsityONE institutional seeding failed: ${error.message}`); process.exitCode = 1; });
