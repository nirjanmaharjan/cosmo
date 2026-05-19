// config.js — centralised app configuration
// In production, load these from real environment variables / secrets manager.
module.exports = {
  PORT:       process.env.PORT       || 3001,
  JWT_SECRET: process.env.JWT_SECRET || 'safevoice-dev-secret-change-in-production',
  JWT_EXPIRY: process.env.JWT_EXPIRY || '7d',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',   // tighten in production
};
