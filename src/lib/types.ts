export interface User {
  user_id: number;
  username: string;
  password?: string;
  role: "Admin" | "Student" | "Faculty" | "CHED";
  email: string;
  status: "Active" | "Inactive";
  auth_user_id?: string;
  created_at?: string;
}

export interface StudentAccount {
  student_id: number;
  user_id: number;
  student_number: string;
  last_name: string;
  given_name: string;
  ext_name?: string | null;
  middle_name?: string | null;
  sex?: string | null;
  birthdate?: string | null;
  program_name?: string | null;
  year_level?: string | null;
  registration_status?: string | null;
  account_status?: string | null;
  created_at?: string;
  users?: User;
}

export interface ScholarshipProgram {
  scholarship_id: number;
  scholarship_name: string;
  description?: string;
  requirements?: string;
  application_form_fields?: string;
  deadline?: string;
  status: "Open" | "Closed";
  created_by?: number;
  created_at?: string;
}

export interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_data?: Record<string, unknown>;
  application_status: "Pending" | "Approved" | "Not Approved";
  application_date?: string;
  remarks?: string;
  scholarship_programs?: ScholarshipProgram;
  student_accounts?: StudentAccount;
}

export interface ChedFormInput {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  last_name?: string;
  given_name?: string;
  ext_name?: string;
  middle_name?: string;
  sex?: string;
  birthdate?: string;
  complete_program_name?: string;
  year_level?: string;
  father_name?: string;
  mother_name?: string;
  street_barangay?: string;
  zipcode?: string;
  disability?: string;
  contact_number?: string;
  email_address?: string;
  indigenous_people_group?: string;
  income_tax_return?: string;
  annual_income_family?: number;
  created_at?: string;
  scholarship_applications?: ScholarshipApplication;
}

export interface RankingResult {
  ranking_id: number;
  application_id: number;
  priority_score: number;
  ranking_position: number;
  prediction_result?: string;
  generated_date?: string;
}

export interface ScholarshipApproval {
  approval_id: number;
  application_id: number;
  approved_by?: number;
  approval_date?: string;
  approval_status: "Approved" | "Not Approved";
  validation_status: "Validated" | "Not Validated";
}

export interface EarlyWarningAlert {
  warning_id: number;
  student_id: number;
  gpa?: number;
  average_grade?: number;
  risk_level?: string;
  warning_message?: string;
  warning_date?: string;
  status: "Active" | "Resolved";
  student_accounts?: StudentAccount;
}

export interface Notification {
  notification_id: number;
  student_id: number;
  title: string;
  message: string;
  notification_type: "Announcement" | "Status Update" | "Warning" | "Scholarship";
  date_sent?: string;
  status: "Read" | "Unread";
  student_accounts?: { given_name?: string; last_name?: string };
}

export interface SupportDocument {
  document_id: number;
  application_id: number;
  document_type: string;
  file_path: string;
  upload_date?: string;
  student_accounts?: StudentAccount;
}

export interface SupportAcademicRecord {
  record_id: number;
  student_id: number;
  applicant_type: "Freshman" | "Alumni";
  shs_gwa?: number;
  college_gpa?: number;
  proof_image_path?: string;
  created_at?: string;
  student_accounts?: StudentAccount;
}

export type ApplicationStatus = "Pending" | "Approved" | "Not Approved";
export type UserRole = "Admin" | "Student" | "Faculty" | "CHED";
