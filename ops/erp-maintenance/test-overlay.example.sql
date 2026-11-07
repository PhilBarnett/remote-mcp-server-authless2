-- Installation prerequisite: replace this file after inspecting the actual ERP schema.
-- Use a transaction; assert exact row counts/identities for every changed record.
-- Set WooCommerce to staging with staging-only credentials held on this server.
-- Disable mail delivery, schedulers, payment, fulfilment and other outbound integrations.
-- Ensure the actual TEST application has its scheduler disabled independently of the copied DB.
-- Do not remove the exception until the entire overlay has been reviewed and tested.
DO $$ BEGIN RAISE EXCEPTION 'Test overlay has not been commissioned'; END $$;
