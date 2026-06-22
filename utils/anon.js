// utils/anon.js — Anonymous submitter identity using HMAC
const crypto = require('crypto');

const SECRET = process.env.ANON_SECRET || 'safevoice-default-anon-secret-change-me';

function hashId(userId) {
  return crypto.createHmac('sha256', SECRET)
    .update(String(userId))
    .digest('hex');
}

module.exports = { hashId };
