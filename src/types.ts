export type Role = 'student' | 'lecturer' | 'department_admin' | 'super_admin';
export type User = {
  id: number; email: string; role: Role; name: string; status: string;
  departmentId: number | null; programId: number | null; level: number | null;
  matricNo: string | null; staffNo: string | null; phone?: string | null; avatarVersion?: number; hasPhoto?: boolean;
  department?: string; faculty?: string; program?: string;
};
export type Term = { id: number; name: string; session_name: string } | null;
export type AnyRow = Record<string, any>;
