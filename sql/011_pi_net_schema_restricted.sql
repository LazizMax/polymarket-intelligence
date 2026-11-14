-- Keep HTTP scheduling functions inaccessible from public browser roles.
revoke usage on schema net from public, anon, authenticated;
