CREATE TABLE faculties (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faculties_code_unique UNIQUE (code)
);
CREATE UNIQUE INDEX faculties_name_unique ON faculties (lower(name));

CREATE TABLE departments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  faculty_id integer NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT,
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_code_unique UNIQUE (code),
  CONSTRAINT departments_faculty_name_unique UNIQUE (faculty_id, name),
  CONSTRAINT departments_id_scope_unique UNIQUE (id, faculty_id)
);
CREATE UNIQUE INDEX departments_name_unique ON departments (lower(name));

CREATE TABLE programs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id integer NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  name text NOT NULL,
  code text NOT NULL,
  duration smallint NOT NULL DEFAULT 4 CHECK (duration BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_code_unique UNIQUE (code),
  CONSTRAINT programs_id_department_unique UNIQUE (id, department_id)
);
CREATE UNIQUE INDEX programs_name_department_unique ON programs (department_id, lower(name));

CREATE TABLE academic_sessions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_sessions_name_check CHECK (name ~ '^[0-9]{4}/[0-9]{4}$')
);
CREATE UNIQUE INDEX one_current_academic_session ON academic_sessions (is_current) WHERE is_current;

CREATE TABLE semesters (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id integer NOT NULL REFERENCES academic_sessions(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name IN ('First Semester','Second Semester','Third Semester')),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semesters_session_name_unique UNIQUE (session_id, name)
);
CREATE UNIQUE INDEX one_current_semester ON semesters (is_current) WHERE is_current;
CREATE INDEX semesters_session_idx ON semesters(session_id);

CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('student','lecturer','department_admin','super_admin')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  department_id integer REFERENCES departments(id) ON DELETE RESTRICT,
  program_id integer,
  level smallint CHECK (level BETWEEN 100 AND 800 AND level % 100 = 0),
  matric_no text,
  staff_no text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_program_scope_fk FOREIGN KEY (program_id, department_id) REFERENCES programs(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT users_student_profile_check CHECK ((role = 'student' AND program_id IS NOT NULL AND level IS NOT NULL AND matric_no IS NOT NULL) OR (role <> 'student' AND program_id IS NULL AND level IS NULL AND matric_no IS NULL)),
  CONSTRAINT users_superadmin_scope_check CHECK ((role = 'super_admin' AND department_id IS NULL) OR role <> 'super_admin')
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE UNIQUE INDEX users_matric_unique ON users (upper(matric_no)) WHERE matric_no IS NOT NULL;
CREATE UNIQUE INDEX users_staff_unique ON users (upper(staff_no)) WHERE staff_no IS NOT NULL;
CREATE INDEX users_department_role_idx ON users(department_id, role, status);
CREATE INDEX users_program_level_idx ON users(program_id, level) WHERE role='student';

CREATE TABLE courses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 180),
  units smallint NOT NULL CHECK (units BETWEEN 1 AND 10),
  department_id integer NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  program_id integer NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 100 AND 800 AND level % 100 = 0),
  semester_id integer NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_program_scope_fk FOREIGN KEY (program_id, department_id) REFERENCES programs(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT courses_code_unique UNIQUE (code)
);
CREATE INDEX courses_semester_scope_idx ON courses(semester_id, department_id, program_id, level) WHERE is_active;

CREATE TABLE course_assignments (
  course_id integer NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecturer_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by integer REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(course_id, lecturer_id)
);
CREATE INDEX course_assignments_lecturer_idx ON course_assignments(lecturer_id, course_id);

CREATE TABLE registrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  course_id integer NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  semester_id integer NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registrations_student_course_term_unique UNIQUE(student_id, course_id, semester_id),
  CONSTRAINT registrations_id_cohort_unique UNIQUE(id, student_id, course_id, semester_id)
);
CREATE INDEX registrations_course_semester_idx ON registrations(course_id, semester_id, student_id);
CREATE INDEX registrations_student_semester_idx ON registrations(student_id, semester_id, course_id);

CREATE TABLE results (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id integer NOT NULL,
  course_id integer NOT NULL,
  semester_id integer NOT NULL,
  ca numeric(5,2) NOT NULL DEFAULT 0 CHECK (ca BETWEEN 0 AND 30),
  exam numeric(5,2) NOT NULL DEFAULT 0 CHECK (exam BETWEEN 0 AND 70),
  total numeric(5,2) NOT NULL DEFAULT 0 CHECK (total BETWEEN 0 AND 100 AND total = ca + exam),
  grade text NOT NULL DEFAULT 'F' CHECK (grade IN ('A','B','C','D','E','F')),
  grade_point numeric(2,1) NOT NULL DEFAULT 0 CHECK (grade_point BETWEEN 0 AND 5),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  feedback text CHECK (length(feedback) <= 2000),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT results_student_course_term_unique UNIQUE(student_id, course_id, semester_id),
  CONSTRAINT results_registered_cohort_fk FOREIGN KEY (student_id,course_id,semester_id) REFERENCES registrations(student_id,course_id,semester_id) ON DELETE CASCADE
);
CREATE INDEX results_status_course_term_idx ON results(status, course_id, semester_id);
CREATE INDEX results_student_status_idx ON results(student_id, status, semester_id DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id integer REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 3 AND 100),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 2 AND 50),
  entity_id integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_events(created_at DESC, id DESC);
CREATE INDEX audit_actor_created_idx ON audit_events(actor_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_details_gin_idx ON audit_events USING gin(details jsonb_path_ops);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER courses_touch_updated_at BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
