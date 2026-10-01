/**
 * Public settings for the dashboard. Everything here is safe to commit:
 * the Supabase URL and publishable (anon) key are meant to be public -- what a
 * visitor can do with them is decided by Row-Level Security and the SQL
 * functions in supabase/migrations/. Secrets live only in ProjectCode/.env.
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://gchpxdizablwgijbgzhc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_oYUQAEe2o6_Z9w7wzoyLqg_c5_cdNd8',
  // Cloudflare Worker that serves the images from R2 (ProjectCode/worker/).
  IMAGE_BASE_URL: 'https://water-sample-images.watersampleimageorganization.workers.dev',
};
