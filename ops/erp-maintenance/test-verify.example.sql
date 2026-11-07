-- Assertions must raise on any failure, not merely SELECT false.
-- Verify staging URL and correct non-live API key identity without printing secrets.
-- Verify email/integration/scheduler disabling and expected tenant/products/mappings.
-- Inspect the schema before supplying the exact names: this intentionally fails closed.
DO $$ BEGIN RAISE EXCEPTION 'Test verification has not been commissioned'; END $$;
