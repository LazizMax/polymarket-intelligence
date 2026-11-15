-- Read-only, role-restricted integrity fingerprints over Polymarket's
-- 38 original data tables. Run on BOTH legacy and dedicated projects.
-- Do not expose this function through the Data API.
CREATE OR REPLACE FUNCTION pi.migration_fingerprint_tables()
RETURNS TABLE(table_name text,row_count bigint,content_md5 text)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,pi
AS $function$
DECLARE t record;
DECLARE key_order text;
DECLARE n bigint;
DECLARE h text;
BEGIN
 FOR t IN
  SELECT c.oid,c.relname
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='pi' AND c.relkind='r'
   AND c.relname NOT LIKE 'migration_%'
   AND c.relname NOT IN('dashboard_access','scheduler_auth',
                        'external_dashboard_access')
  ORDER BY c.relname
 LOOP
  SELECT string_agg('t.'||quote_ident(a.attname),', ' ORDER BY k.ord)
   INTO key_order
  FROM pg_index ix
  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum
  WHERE ix.indrelid=t.oid AND ix.indisprimary;
  IF key_order IS NULL THEN
   RAISE EXCEPTION 'Missing primary key on pi.%',t.relname;
  END IF;
  EXECUTE format(
   'SELECT count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '''' ORDER BY %s), '''')) FROM pi.%I t',
   key_order,t.relname
  ) INTO n,h;
  table_name:=t.relname; row_count:=n; content_md5:=h;
  RETURN NEXT;
 END LOOP;
END $function$;
REVOKE ALL ON FUNCTION pi.migration_fingerprint_tables() FROM PUBLIC,anon,authenticated;
