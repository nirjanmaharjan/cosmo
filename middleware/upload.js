// middleware/upload.js — File upload configuration using multer
'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Upload directory
const uploadDir = path.join(__dirname, '../public/uploads/complaints');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with UUID + original extension
    const uniqueSuffix = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  }
});

// File filter: allow only images and videos
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    // Videos
    'video/mp4',
    'video/webm',
    'video/quicktime', // .mov
    'video/x-msvideo', // .avi
    'video/x-matroska', // .mkv
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Only images and videos are allowed. Received: ${file.mimetype}`), false);
  }
};

// Multer instance
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
  }
});

module.exports = upload;
