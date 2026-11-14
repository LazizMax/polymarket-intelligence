-- Disallow browser or ordinary Supabase Auth roles from calling functions in private pi.
revoke execute on all functions in schema pi from public, anon, authenticated; alter default privileges in schema pi revoke execute on functions from public, anon, authenticated;
