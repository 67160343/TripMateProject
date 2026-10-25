CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  destination VARCHAR(200) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  description TEXT,
  fund_target NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  status VARCHAR(20) NOT NULL DEFAULT 'invited',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  activity_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  category VARCHAR(50) NOT NULL DEFAULT 'other',
  description TEXT,
  location VARCHAR(250),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accommodations (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  address TEXT,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  booking_url TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'selected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (check_out >= check_in)
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'paid',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_trip_members_user ON trip_members(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_trip_date ON activities(trip_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_payments_trip ON payments(trip_id);

-- Google Maps checkpoint URL for itinerary activities (safe additive migration).
ALTER TABLE activities ADD COLUMN IF NOT EXISTS google_maps_url TEXT;


-- Standalone trip checkpoints: plain-text location names and Google Maps share links.
CREATE TABLE IF NOT EXISTS checkpoints (
  id SERIAL PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  google_maps_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_trip_order ON checkpoints(trip_id, sort_order, id);
