# VarsityONE Database Design

Neon PostgreSQL is the system of record. Versioned SQL files in `migrations/` define the schema; `npm run db:migrate` applies them with checksums and an advisory lock. Important relationships, uniqueness constraints and value bounds are enforced by PostgreSQL as well as request validation.

```mermaid
erDiagram
  FACULTIES ||--o{ DEPARTMENTS : contains
  DEPARTMENTS ||--o{ PROGRAMS : offers
  DEPARTMENTS ||--o{ USERS : assigns
  PROGRAMS ||--o{ USERS : enrolls
  ACADEMIC_SESSIONS ||--o{ SEMESTERS : contains
  PROGRAMS ||--o{ COURSES : includes
  DEPARTMENTS ||--o{ COURSES : owns
  SEMESTERS ||--o{ COURSES : schedules
  USERS ||--o{ COURSE_ASSIGNMENTS : teaches
  COURSES ||--o{ COURSE_ASSIGNMENTS : allocated
  USERS ||--o{ REGISTRATIONS : makes
  COURSES ||--o{ REGISTRATIONS : receives
  SEMESTERS ||--o{ REGISTRATIONS : records
  USERS ||--o{ RESULTS : earns
  COURSES ||--o{ RESULTS : assesses
  SEMESTERS ||--o{ RESULTS : publishes
  USERS ||--o{ AUDIT_EVENTS : performs
  USERS ||--o{ SESSIONS : authenticates

  FACULTIES { int id PK; string name; string code }
  DEPARTMENTS { int id PK; int faculty_id FK; string name; string code }
  PROGRAMS { int id PK; int department_id FK; string name; string code; int duration }
  ACADEMIC_SESSIONS { int id PK; string name; bool is_current }
  SEMESTERS { int id PK; int session_id FK; string name; bool is_current }
  USERS { int id PK; string email UK; string password_hash; string role; string status; int department_id FK; int program_id FK; int level; string matric_no UK; string staff_no UK }
  COURSES { int id PK; string code UK; string title; int units; int department_id FK; int program_id FK; int level; int semester_id FK; bool is_active }
  COURSE_ASSIGNMENTS { int course_id PK,FK; int lecturer_id PK,FK }
  REGISTRATIONS { int id PK; int student_id FK; int course_id FK; int semester_id FK; datetime registered_at; UK student_course_semester }
  RESULTS { int id PK; int student_id FK; int course_id FK; int semester_id FK; float ca; float exam; float total; string grade; float grade_point; string status; string feedback; datetime submitted_at; datetime reviewed_at }
  AUDIT_EVENTS { int id PK; int actor_id FK; string action; string entity_type; int entity_id; json details; datetime created_at }
  SESSIONS { string token_hash PK; int user_id FK; int expires_at }
```

## Keys and invariants

- `users.email` is case-insensitively unique. Matriculation number and staff number are unique when present.
- A department belongs to a faculty; a programme belongs to a department; a course belongs to a department and programme and is attached to one semester.
- Course assignments use a composite primary key so a lecturer cannot be assigned twice to the same course.
- Registration uniqueness is `(student_id, course_id, semester_id)`, preventing duplicate registrations.
- Result uniqueness uses the same student/course/semester key. CA is 0–30, examination 0–70, total 0–100 and grade point 0–5.
- Audit records identify the authenticated actor and retain a JSON detail snapshot. The application does not expose an update or delete route for audit events.
