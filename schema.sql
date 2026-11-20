CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_at TEXT NOT NULL,
  applicant_name TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_phone TEXT NOT NULL,
  desired_move_in TEXT NOT NULL,
  file_key TEXT,
  file_name TEXT,
  payload_json TEXT NOT NULL
);