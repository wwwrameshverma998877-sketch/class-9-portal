# class-9-portal

## Division-aware accounts

Run `supabase/migrations/20261122000000_add_credentials_division.sql` in the Supabase SQL Editor before using the division-aware login and account-creation form. Existing rows need their `division` set to `Karma` or `Shraddha` in Supabase before those accounts can log in; the app does not guess a division from a roll number.

Run `supabase/migrations/20261122000001_allow_two_device_sessions.sql` after that migration to enable up to two concurrent device sessions per Division + Roll Number account. The login flow uses the `claim_credentials_session` and `release_credentials_session` RPC functions created by this migration.