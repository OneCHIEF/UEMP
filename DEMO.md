# VarsityONE Test Workflow Walkthrough

## Five-minute walkthrough

**Opening (20 seconds):** “VarsityONE is a role-based university academic platform. I’ll demonstrate registration, lecturer assessment, independent departmental review, and university administration.”

**Student (60 seconds):** Sign in with `student@uemp.demo`. Point out the programme, level and semester context. Open Course Catalogue, select one or more available courses, and submit. Open My Registration and print the summary. Open Academic Results and explain that only approved results are published.

**Lecturer (90 seconds):** Sign in with `lecturer@uemp.demo`. Open My Courses, select an assigned class, and enter a CA score from 0–30 and an examination score from 0–70 for registered students. Save a draft and reopen it to show persistence, then submit the complete class. Point out that submitted results lock for editing.

**Department administrator (60 seconds):** Sign in with `hod@uemp.demo`. Open Result Review, inspect the score table, and approve the submission or return it with specific correction feedback. Open Activity Log to show the review trace.

**Lecturer correction (30 seconds):** Sign back in as the lecturer. Show the returned feedback, change the score, and resubmit. Explain that students do not see a result until approval.

**Super Admin (60 seconds):** Sign in with the institution’s super administrator account. Open Administration and show academic structure, account status and role controls, course activation, and lecturer assignments. Show reports and the university audit log.

**Close (20 seconds):** “The server enforces role and department scope on every protected endpoint. Registration uniqueness and score limits are enforced in the database and API, and each important academic action is traceable.”

The test role accounts are stored in Neon and are intentionally absent from the login page. The API never inserts records on ordinary startup. Use the institution-issued super administrator account for university-wide workflows.
