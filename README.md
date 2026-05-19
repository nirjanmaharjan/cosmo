# SafeVoice — Node.js Backend

A REST API backend for the **SafeVoice College Complaint System** built with Express, SQLite (better-sqlite3), JWT authentication, and bcrypt password hashing.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server (auto-seeds the DB on first run)
npm start

# Development with auto-reload
npm run dev        # requires: npm install -g nodemon  (or install locally)
```

Server runs on **http://localhost:3001** by default.

---

## Environment Variables

| Variable      | Default                              | Description                        |
|---------------|--------------------------------------|------------------------------------|
| `PORT`        | `3001`                               | HTTP port                          |
| `JWT_SECRET`  | `safevoice-dev-secret-...`           | **Change this in production!**     |
| `JWT_EXPIRY`  | `7d`                                 | JWT token lifetime                 |
| `CORS_ORIGIN` | `*`                                  | Allowed CORS origin(s)             |

---

## Demo Credentials

| Role    | Email                  | Password   |
|---------|------------------------|------------|
| Student | student@college.edu    | password   |
| Admin   | admin@college.edu      | password   |

---

## API Reference

All endpoints (except `/api/auth/login` and `/api/auth/register`) require a Bearer token:

```
Authorization: Bearer <token>
```

### Auth

| Method | Path                  | Auth     | Description             |
|--------|-----------------------|----------|-------------------------|
| POST   | `/api/auth/login`     | None     | Log in, receive JWT     |
| POST   | `/api/auth/register`  | None     | Register new student    |
| GET    | `/api/auth/me`        | Required | Get current user info   |

**Login request body:**
```json
{ "email": "student@college.edu", "password": "password" }
```

**Login response:**
```json
{
  "token": "eyJ...",
  "user": { "id": 1, "email": "student@college.edu", "role": "student" }
}
```

---

### Complaints

| Method | Path                              | Auth          | Description                |
|--------|-----------------------------------|---------------|----------------------------|
| GET    | `/api/complaints`                 | Required      | List / filter complaints   |
| GET    | `/api/complaints/stats`           | Admin only    | Dashboard statistics       |
| GET    | `/api/complaints/:id`             | Required      | Get single complaint       |
| POST   | `/api/complaints`                 | Required      | Submit new complaint       |
| PATCH  | `/api/complaints/:id/status`      | Admin only    | Update complaint status    |
| POST   | `/api/complaints/:id/vote`        | Required      | Toggle upvote              |
| DELETE | `/api/complaints/:id`             | Admin only    | Delete complaint           |

**GET /api/complaints** query params:

| Param      | Values                                            |
|------------|---------------------------------------------------|
| `status`   | `Pending` · `Under Review` · `Resolved`           |
| `category` | `Food Services` · `Facilities` · `Library` · `Hostel` · `Security` |
| `sort`     | `votes` (default) · `new` · `old`                |
| `search`   | Free-text search in title, description, category  |

**POST /api/complaints** request body:
```json
{
  "title": "Mess food is terrible",
  "description": "Detailed description here...",
  "category": "Food Services",   // optional — auto-assigned if omitted
  "priority": "High"             // optional — defaults to Medium
}
```

**PATCH /api/complaints/:id/status** request body:
```json
{ "status": "Under Review" }
```

**Vote response:**
```json
{ "voted": true, "votes": 43 }
```

---

## Project Structure

```
safevoice-backend/
├── server.js           # Express app entry point
├── db.js               # SQLite setup, schema, seed
├── config.js           # Port, JWT secret, CORS config
├── middleware/
│   └── auth.js         # requireAuth + requireAdmin middleware
├── routes/
│   ├── auth.js         # /api/auth/*
│   └── complaints.js   # /api/complaints/*
├── public/             # Drop safevoice2.html here to serve it
├── package.json
└── safevoice.db        # Auto-created on first run
```

---

## Connecting the Frontend

In `safevoice2.html`, replace the hardcoded `data` array and login logic with fetch calls to this API. A minimal example:

```js
const API = 'http://localhost:3001/api';
let token = localStorage.getItem('sv_token');

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const { token: t, user } = await res.json();
  token = t;
  localStorage.setItem('sv_token', token);
}

async function getComplaints(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}/complaints?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}
```

Or simply place the HTML file in the `public/` folder and it will be served at `http://localhost:3001/`.

---

## Security Notes for Production

- Set a strong random `JWT_SECRET` (e.g. `openssl rand -hex 32`)
- Set `CORS_ORIGIN` to your frontend's actual domain
- Use HTTPS (reverse proxy with nginx + Let's Encrypt)
- Consider rate-limiting login with `express-rate-limit`
