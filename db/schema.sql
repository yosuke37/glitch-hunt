CREATE TABLE IF NOT EXISTS gh_control (
  id integer PRIMARY KEY CHECK (id = 1),
  concurrency integer NOT NULL DEFAULT 20 CHECK (concurrency BETWEEN 1 AND 20),
  daily_live_limit integer NOT NULL DEFAULT 100 CHECK (daily_live_limit BETWEEN 1 AND 10000),
  budget_day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  live_attempts integer NOT NULL DEFAULT 0
);
INSERT INTO gh_control (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE gh_control ADD COLUMN IF NOT EXISTS model_cooldown_until timestamptz NOT NULL DEFAULT now();
ALTER TABLE gh_control ADD COLUMN IF NOT EXISTS model_next_call_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE gh_control ADD COLUMN IF NOT EXISTS model_interval_ms integer NOT NULL DEFAULT 15000 CHECK (model_interval_ms BETWEEN 0 AND 60000);
CREATE TABLE IF NOT EXISTS gh_batches (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gh_jobs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES gh_batches(id),
  ordinal integer NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  result jsonb,
  error text,
  completed_at timestamptz,
  UNIQUE (batch_id, ordinal)
);
CREATE TABLE IF NOT EXISTS gh_attempts (
  token uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES gh_jobs(id),
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  lease_until timestamptz NOT NULL DEFAULT now() + interval '90 seconds',
  progress jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS gh_jobs_ready ON gh_jobs (available_at) WHERE status = 'queued';
ALTER TABLE gh_jobs ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;
ALTER TABLE gh_jobs ADD COLUMN IF NOT EXISTS budget_charged_on date;
CREATE INDEX IF NOT EXISTS gh_attempts_active ON gh_attempts (lease_until) WHERE status = 'running';
UPDATE gh_jobs j SET budget_charged_on=(
  SELECT max((a.started_at AT TIME ZONE 'UTC')::date) FROM gh_attempts a WHERE a.job_id=j.id
) WHERE j.input->>'mode'='live' AND j.attempts>0 AND j.budget_charged_on IS NULL;
UPDATE gh_control c SET live_attempts=(
  SELECT count(*) FROM gh_jobs j WHERE j.input->>'mode'='live' AND j.budget_charged_on=c.budget_day
) WHERE id=1;
