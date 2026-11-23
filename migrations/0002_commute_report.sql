-- Address that receives the monthly commute summary (sent on the 25th, see src/worker.ts). NULL = no e-mail.
-- Strava does not share the athlete's e-mail address, so it is entered on the Commutes page.
ALTER TABLE athletes ADD COLUMN report_email TEXT;
