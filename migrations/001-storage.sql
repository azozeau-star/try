CREATE TABLE IF NOT EXISTS sami_users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    profile jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS sami_chats (
    user_id text PRIMARY KEY REFERENCES sami_users(id),
    display_name text NOT NULL,
    messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array')
);

CREATE TABLE IF NOT EXISTS sami_sessions (
    token_hash text PRIMARY KEY,
    expires_at bigint NOT NULL,
    session jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS sami_sessions_expiry ON sami_sessions(expires_at);
