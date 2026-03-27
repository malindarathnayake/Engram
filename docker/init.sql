CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS vector;

LOAD 'age';
SET search_path = ag_catalog, "$user", public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ag_catalog.ag_graph
    WHERE name = 'engram'
  ) THEN
    PERFORM ag_catalog.create_graph('engram');
  END IF;
END $$;

ALTER DATABASE agent_memory SET statement_timeout = '5000';
