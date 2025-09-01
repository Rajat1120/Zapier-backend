-- Delete existing invalid Drive watches
-- Run this in your Supabase SQL editor or psql

DELETE FROM google_drive_watch 
WHERE zap_id = 'bea04028-5be5-425c-b357-0703d886eeed';

-- Check if there are any other invalid watches
SELECT * FROM google_drive_watch;
