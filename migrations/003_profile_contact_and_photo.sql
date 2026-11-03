ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 30),
  ADD COLUMN IF NOT EXISTS avatar_version integer NOT NULL DEFAULT 0 CHECK (avatar_version >= 0),
  ADD COLUMN IF NOT EXISTS avatar_has_photo boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS profile_photos (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime_type text NOT NULL CHECK (mime_type = 'image/jpeg'),
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 307200),
  updated_at timestamptz NOT NULL DEFAULT now()
);
