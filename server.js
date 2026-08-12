require('dotenv').config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the root directory
app.use(express.static(__dirname));

// API routes and other middleware...
// (Make sure this is placed AFTER your API/Admin routes but BEFORE the catch-all)

// Catch-all route to serve index.html for SPA routing
app.get('*', (req, res, next) => {
  // If it's an API or Admin route, don't serve index.html, let it 404 or be handled
  if (req.path.startsWith('/api') || req.path.startsWith('/chat') || req.path.startsWith('/admin')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// The port MUST be exactly what Replit expects or it won't be accessible
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(async (client) => {
      console.log("✅ Connected to Railway PostgreSQL");
      await client.query("SET TIMEZONE='Africa/Nairobi'");
      client.release();
    })
  .catch(err => console.error("❌ DB Connection error", err.stack));


  /* =========================
     CHAT & CASHRAIN SYSTEM
  ========================= */

  async function setupChatDB() {
    try {
      // 1. Users Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            phone VARCHAR(20) UNIQUE NOT NULL,
            pin VARCHAR(10) NOT NULL,
            balance DECIMAL(15, 2) DEFAULT 0.00,
             withdrawal_status VARCHAR(20) DEFAULT 'enabled',
            status VARCHAR(20) DEFAULT 'active',
            chat_status VARCHAR(20) DEFAULT 'active',
            referral_code VARCHAR(50), 
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 2. Bets Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bets (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            multiplier DECIMAL(10, 2),
            status VARCHAR(20) NOT NULL DEFAULT 'placed',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 3. Transactions Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            type VARCHAR(30) NOT NULL, 
            reference VARCHAR(100),
            status VARCHAR(20) NOT NULL DEFAULT 'success',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 4. Notifications Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 5. Settings Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
            setting_key VARCHAR(50) PRIMARY KEY,
            setting_value TEXT
        );
      `);

      // 6. Chats Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chats (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50),
            message TEXT NOT NULL,
            is_admin BOOLEAN DEFAULT FALSE,
            type VARCHAR(20) DEFAULT 'text',
            reply_to INTEGER DEFAULT NULL,
            likes INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 7. Chat Likes Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_likes (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 8. Cashrains Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cashrains (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER,
            amount DECIMAL(15,2) NOT NULL,
            max_claims INTEGER NOT NULL,
            current_claims INTEGER DEFAULT 0,
            min_balance DECIMAL(15,2) DEFAULT 50.00,
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // 9. Cashrain Claims Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cashrain_claims (
            id SERIAL PRIMARY KEY,
            cashrain_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
        );
      `);

      // Insert Default Settings
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value) 
        VALUES ('chat_locked', 'false') 
        ON CONFLICT (setting_key) DO NOTHING;
      `);

    } catch(e) {
      console.error("Error setting up DB schema:", e);
    }
  }
  setupChatDB();

  function maskUsername(username) {
    if(!username) return "anon";
    if(username.length <= 2) return username + "**";
    const mid = "*".repeat(username.length - 2);
    return username.charAt(0) + mid + username.charAt(username.length - 1);
  }

  const spamRegex = /(?:07\d{8}|2547\d{8}|01\d{8}|\+254\d{9})/;

  // Helper for rate limiting (memory based)
  const chatRateLimits = new Map();
  
/* =========================
   RECEIPTS (JSON - OPTION A)
========================= */

const receiptsFile = path.join(__dirname, "receipts.json");

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}


  /* =========================
     CHAT ROUTES
  ========================= */

  app.get('/chat/messages', async (req, res) => {
    try {
      const lockCheck = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'chat_locked'");
      const isLocked = lockCheck.rows.length > 0 && lockCheck.rows[0].setting_value === 'true';
      
      // Cleanup old chats (> 48 hours) - COMMENTED OUT SO CHATS ARE NEVER DELETED
      // await pool.query("DELETE FROM chats WHERE created_at < CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' - INTERVAL '48 hours'");
      
      // Fetch last 150 messages
      const msgs = await pool.query(`
        SELECT c.*, cr.amount, cr.max_claims, cr.current_claims,
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' - cr.created_at)) as cr_seconds_passed,
               ARRAY(SELECT username FROM chat_likes WHERE chat_id = c.id) as liked_by
        FROM chats c
        LEFT JOIN cashrains cr ON cr.chat_id = c.id
        ORDER BY c.created_at DESC LIMIT 150
      `);
      
      const formatted = msgs.rows.map(m => {
        return {
          id: m.id,
          username: m.is_admin ? "captain" : maskUsername(m.username),
          message: m.message,
          is_admin: m.is_admin,
          type: m.type,
          amount: m.amount,
          max_claims: m.max_claims,
          current_claims: m.current_claims,
          cr_seconds_passed: m.cr_seconds_passed,
          created_at: m.created_at,
          likes: m.liked_by ? m.liked_by.length : 0,
          liked_by: m.liked_by || [],
          reply_to: m.reply_to
        };
      });
      
      res.json({ success: true, messages: formatted, locked: isLocked });
    } catch(e) {
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  });

  app.post('/chat/send', async (req, res) => {
    const { phone, message } = req.body;
    if(!phone || !message) return res.status(400).json({error: 'Invalid request'});
    
    const formattedPhone = formatPhone(phone);
    try {
      const lockCheck = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'chat_locked'");
      if (lockCheck.rows.length > 0 && lockCheck.rows[0].setting_value === 'true') {
        return res.status(403).json({ error: 'Chat is not available now' });
      }

      const user = await pool.query("SELECT username, balance, chat_status FROM users WHERE phone = $1", [formattedPhone]);
      if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
      
      if(user.rows[0].chat_status === 'suspended') {
        return res.status(403).json({ error: 'You are suspended from chat.' });
      }
      
      if(parseFloat(user.rows[0].balance) < 50) {
        return res.status(403).json({ error: 'Chat access is restricted for players with balance below 50 KES' });
      }
      
      if(spamRegex.test(message)) {
        return res.status(400).json({ error: 'Spam/phone numbers are not allowed.' });
      }

      if(message.trim().split(/\s+/).length > 10) {
        return res.status(400).json({ error: 'Message must not exceed 10 words.' });
      }
      
      // Rate limit: Max 5 chats per minute
      const now = Date.now();
      const userLimits = chatRateLimits.get(formattedPhone) || [];
      const recent = userLimits.filter(time => now - time < 60000);
      if(recent.length >= 5) {
        return res.status(429).json({ error: 'Maximum chat per minute reached (5).' });
      }
      recent.push(now);
      chatRateLimits.set(formattedPhone, recent);
      
      await pool.query(
        "INSERT INTO chats (username, message, type) VALUES ($1, $2, 'text')",
        [user.rows[0].username, message]
      );
      
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  
app.post('/chat/like', async (req, res) => {
  const { phone, chatId, isAdmin } = req.body;
  try {
    let username;
    if (isAdmin && req.headers['authorization'] === '3462Abel@#') {
      username = 'captain';
    } else {
      const formattedPhone = formatPhone(phone);
      const user = await pool.query("SELECT username FROM users WHERE phone = $1", [formattedPhone]);
      if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
      username = user.rows[0].username;
    }

    const checkLike = await pool.query("SELECT * FROM chat_likes WHERE chat_id = $1 AND username = $2", [chatId, username]);
    if (checkLike.rows.length > 0) {
      // Toggle OFF (Unlike)
      await pool.query("DELETE FROM chat_likes WHERE chat_id = $1 AND username = $2", [chatId, username]);
      await pool.query("UPDATE chats SET likes = GREATEST(COALESCE(likes, 0) - 1, 0) WHERE id = $1", [chatId]);
      return res.json({ success: true, action: 'unliked' });
    }
    // Toggle ON (Like)

    await pool.query("INSERT INTO chat_likes (chat_id, username) VALUES ($1, $2)", [chatId, username]);
    await pool.query("UPDATE chats SET likes = COALESCE(likes, 0) + 1 WHERE id = $1", [chatId]);
    
    res.json({ success: true, action: 'liked' });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/chat/reply', async (req, res) => {
  const { phone, message, replyToId } = req.body;
  const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query("SELECT username FROM users WHERE phone = $1", [formattedPhone]);
    if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
    
    // Check reply count
    const replyCount = await pool.query("SELECT COUNT(*) FROM chats WHERE reply_to = $1", [replyToId]);
    if (parseInt(replyCount.rows[0].count) >= 5) {
      return res.status(400).json({ error: 'Maximum replies (5) reached.' });
    }

    await pool.query(
      "INSERT INTO chats (username, message, type, reply_to) VALUES ($1, $2, 'text', $3)",
      [user.rows[0].username, message, replyToId]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/chat/reply', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  
  const { message, replyToId } = req.body;
  try {
    await pool.query(
      "INSERT INTO chats (username, message, is_admin, type, reply_to) VALUES ('captain', $1, TRUE, 'text', $2)",
      [message, replyToId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
   });
app.post('/admin/game/crash', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  if (gameStatus === 'RUNNING') {
    currentCrashPoint = currentMultiplier; 
    res.json({ success: true, message: "Crash triggered immediately" });
  } else {
    res.status(400).json({ error: "Game is not currently running" });
  }
});

app.post('/admin/delete-transaction', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  
  const { transactionId } = req.body;
  try {
    await pool.query("DELETE FROM transactions WHERE id = $1", [transactionId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.post('/admin/update-user', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  
  const { oldUsername, newUsername, newPhone, newPin } = req.body;
  try {
    let query = "UPDATE users SET ";
    let params = [];
    let idx = 1;
    
    if (newUsername) { query += `username = ${idx}, `; params.push(newUsername); idx++; }
    if (newPhone) { query += `phone = ${idx}, `; params.push(formatPhone(newPhone)); idx++; }
    if (newPin) { query += `pin = ${idx}, `; params.push(newPin); idx++; }
    
    if (params.length === 0) return res.status(400).json({error: 'No updates provided'});
    
    query = query.slice(0, -2); // remove last comma
    query += ` WHERE username = ${idx}`;
    params.push(oldUsername);
    
    await pool.query(query, params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.post('/admin/limit-feature', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  
  const { username, feature, status } = req.body; 
  try {
    if (feature === 'chat') {
        await pool.query("UPDATE users SET chat_status = $1 WHERE username = $2", [status, username]);
    } else {
        await pool.query("UPDATE users SET status = $1 WHERE username = $2", [status, username]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.get('/admin/notifications', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
  
  try {
    const notifs = await pool.query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100");
    res.json({ success: true, notifications: notifs.rows });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.post('/chat/claim-rain', async (req, res) => {
    const { phone, rainId } = req.body;
    const formattedPhone = formatPhone(phone);
    
    try {
      const user = await pool.query("SELECT username, balance FROM users WHERE phone = $1", [formattedPhone]);
      if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
      const username = user.rows[0].username;
      let balance = parseFloat(user.rows[0].balance);
      
      // BEGIN TRANSACTION
      await pool.query('BEGIN');
      
      const rain = await pool.query("SELECT * FROM cashrains WHERE chat_id = $1 FOR UPDATE", [rainId]);
      if(rain.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({error: 'Rain not found'});
      }
      const r = rain.rows[0];
      
      if(!r.active || r.current_claims >= r.max_claims) {
        await pool.query('ROLLBACK');
        return res.status(400).json({error: 'This cashrain is fully distributed'});
      }
      
      if(balance < parseFloat(r.min_balance)) {
        await pool.query('ROLLBACK');
        return res.status(403).json({error: `You need a balance of ${r.min_balance} KES to claim`});
      }
      
      const claimCheck = await pool.query("SELECT * FROM cashrain_claims WHERE cashrain_id = $1 AND username = $2", [r.id, username]);
      if(claimCheck.rows.length > 0) {
        await pool.query('ROLLBACK');
        return res.status(400).json({error: 'You have already claimed this rain'});
      }
      
      // Process claim
      await pool.query("INSERT INTO cashrain_claims (cashrain_id, username) VALUES ($1, $2)", [r.id, username]);
      await pool.query("UPDATE cashrains SET current_claims = current_claims + 1 WHERE id = $1", [r.id]);
      await pool.query("UPDATE users SET balance = balance + $1 WHERE phone = $2", [r.amount, formattedPhone]);
      await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'cashrain_claim', 'success')", [formattedPhone, r.amount]);
      
      await pool.query('COMMIT');
      
      res.json({ success: true, amount: parseFloat(r.amount), newBalance: balance + parseFloat(r.amount) });
    } catch(e) {
      await pool.query('ROLLBACK');
      res.status(500).json({ error: 'Server error claiming rain' });
    }
  });

  /* ADMIN CHAT ROUTES */
  app.post('/admin/chat/send', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { message } = req.body;
    if(!message) return res.status(400).json({error: 'Message required'});
    
    try {
      await pool.query(
        "INSERT INTO chats (username, message, is_admin, type) VALUES ('captain', $1, TRUE, 'text')",
        [message]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/delete', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { chatId } = req.body;
    try {
      await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);
      await pool.query("DELETE FROM cashrains WHERE chat_id = $1", [chatId]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/toggle-lock', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    try {
      const lockCheck = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'chat_locked'");
      const isLocked = lockCheck.rows.length > 0 && lockCheck.rows[0].setting_value === 'true';
      const newStatus = isLocked ? 'false' : 'true';
      
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('chat_locked', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1", [newStatus]);
      res.json({ success: true, locked: newStatus === 'true' });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/suspend-user', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { username } = req.body;
    try {
      const r = await pool.query("UPDATE users SET chat_status = 'suspended' WHERE username = $1 RETURNING id", [username]);
      if(r.rows.length === 0) return res.status(404).json({error: 'User not found'});
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/unsuspend-user', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { username } = req.body;
    try {
      const r = await pool.query("UPDATE users SET chat_status = 'active' WHERE username = $1 RETURNING id", [username]);
      if(r.rows.length === 0) return res.status(404).json({error: 'User not found'});
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.get('/admin/chat/suspended-users', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    try {
      const r = await pool.query("SELECT username FROM users WHERE chat_status = 'suspended'");
      res.json({ success: true, users: r.rows.map(row => row.username) });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/reply-by-username', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { username, message } = req.body;
    if(!username || !message) return res.status(400).json({error: 'Username and message required'});
    
    try {
      const userChat = await pool.query("SELECT id FROM chats WHERE username = $1 ORDER BY created_at DESC LIMIT 1", [username]);
      if (userChat.rows.length === 0) return res.status(404).json({error: 'No recent chat found for this user to reply to'});
      
      const replyToId = userChat.rows[0].id;
      
      await pool.query(
        "INSERT INTO chats (username, message, is_admin, type, reply_to) VALUES ('captain', $1, TRUE, 'text', $2)",
        [message, replyToId]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/cashrain', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (adminPwd !== "3462Abel@#") return res.status(403).json({ error: "Unauthorized" });
    
    const { amount, max_claims, min_balance } = req.body;
    try {
      const chatRes = await pool.query(
        "INSERT INTO chats (username, message, is_admin, type) VALUES ('captain', 'Cashrain Drop!', TRUE, 'cashrain') RETURNING id"
      );
      const chatId = chatRes.rows[0].id;
      
      await pool.query(
        "INSERT INTO cashrains (chat_id, amount, max_claims, min_balance) VALUES ($1, $2, $3, $4)",
        [chatId, amount, max_claims, min_balance || 50]
      );
      
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });
  
/* =========================
   AUTH ROUTES
========================= */

app.get('/', (req, res) => {
  res.send('Unified Server Running');
});

app.post('/signup', async (req, res) => {
  const { username, phone, pin, referralCode } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    return res.status(400).json({ error: "Invalid phone format" });
  }
  try {
    const checkUser = await pool.query(
      'SELECT * FROM users WHERE phone = $1 OR username = $2',
      [formattedPhone, username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or Phone number already in use' });
    }

    let actualReferralCode = null;
    if (referralCode) {
      const checkRef = await pool.query('SELECT username FROM users WHERE username = $1', [referralCode]);
      if (checkRef.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      actualReferralCode = referralCode;
    }

    await pool.query(
      'INSERT INTO users (username, phone, pin, balance, referral_code) VALUES ($1, $2, $3, 0, $4)',
      [username, formattedPhone, pin, actualReferralCode]
    );

    if (actualReferralCode) {
      await pool.query('UPDATE users SET balance = balance + 20 WHERE username = $1', [actualReferralCode]);
      const referrerUser = await pool.query('SELECT phone FROM users WHERE username = $1', [actualReferralCode]);
      if (referrerUser.rows.length > 0) {
        const referrerPhone = referrerUser.rows[0].phone;
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [referrerPhone, 20, 'referral_bonus', 'success']);
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received KSH 20 for referring ${username}.`]);
      }
    }

    res.json({ success: true, message: 'Signup successful' });

  } catch (err) {
    res.status(500).json({ error: 'Server error during signup' });
  }
});

app.post('/forgot-pin', async (req, res) => {
  const { username, phone } = req.body;
  const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query(
      'SELECT pin FROM users WHERE username = $1 AND phone = $2',
      [username, formattedPhone]
    );
    if (user.rows.length > 0) {
      res.json({ success: true, pin: user.rows[0].pin });
    } else {
      res.status(404).json({ error: 'User not found or details incorrect' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error during forgot pin' });
  }
});

app.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
   const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query(
      'SELECT username, phone, balance, status FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, pin]
    );

    if (user.rows.length > 0) {
      if (user.rows[0].status === 'suspended') {
        return res.status(403).json({ error: 'Your account is suspended. Please contact support.' });
      }
      res.json({ success: true, user: { username: user.rows[0].username, phone: user.rows[0].phone, balance: user.rows[0].balance } });
    } else {
      res.status(401).json({ error: 'Invalid phone or PIN' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

app.post('/change-pin', async (req, res) => {
  const { phone, oldPin, newPin } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  
  if (!newPin || newPin.length !== 6) return res.status(400).json({ error: 'New PIN must be 6 characters' });

  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, oldPin]
    );

    if (user.rows.length > 0) {
      await pool.query('UPDATE users SET pin = $1 WHERE phone = $2', [newPin, formattedPhone]);
      res.json({ success: true, message: 'PIN changed successfully' });
    } else {
      res.status(401).json({ error: 'Invalid old PIN' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error during PIN change' });
  }
});

app.post('/transactions-history', async (req, res) => {
  const { phone } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const tx = await pool.query(
      "SELECT amount, type, status, created_at FROM transactions WHERE phone = $1 AND type IN ('withdrawal', 'deposit') ORDER BY created_at DESC",
      [formattedPhone]
    );
    res.json({ success: true, transactions: tx.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching transactions' });
  }
});

app.post('/delete-account', async (req, res) => {
  const { phone, pin } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, pin]
    );

    if (user.rows.length > 0) {
      await pool.query('DELETE FROM users WHERE phone = $1', [formattedPhone]);
      res.json({ success: true, message: 'Account deleted successfully' });
    } else {
      res.status(401).json({ error: 'Invalid PIN' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error during account deletion' });
  }
});

app.post('/refresh-balance', async (req, res) => {
  const { phone } = req.body;
  const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query(
      'SELECT balance, status FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (user.rows.length > 0) {
      if (user.rows[0].status === 'suspended') {
        return res.status(403).json({ error: 'suspended' });
      }
      res.json({ success: true, balance: user.rows[0].balance });
    } else {
      res.status(404).json({ error: 'User not found' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error fetching balance' });
  }
});

/* =========================
   BETTING & CASH OUT
========================= */
app.post('/api/my-bets', async (req, res) => {
  const { phone } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  try {
    const bets = await pool.query(
      "SELECT amount, multiplier, status, created_at FROM bets WHERE phone = $1 ORDER BY created_at DESC",
      [formattedPhone]
    );
    res.json({ success: true, bets: bets.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching bets' });
  }
});

app.post('/bet', async (req, res) => {
  const { phone, amount, autoCashout } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (user.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });

    let currentBalance = parseFloat(user.rows[0].balance);
    let betAmount = parseFloat(amount);

    if (currentBalance < betAmount)
      return res.status(400).json({ error: 'Insufficient balance' });

    const insertResult = await pool.query(
      'INSERT INTO bets (phone, amount, status) VALUES ($1, $2, $3) RETURNING id',
      [formattedPhone, betAmount, 'placed']
    );

    const betId = insertResult.rows[0].id;
    const betObj = { id: betId, phone: formattedPhone, username: user.rows[0].username, amount: betAmount, autoCashout: autoCashout ? parseFloat(autoCashout) : null, cashedOut: false };
    
    // All new bets go to pendingBets and will be deducted & activated when the next round starts
    pendingBets.push(betObj);

    res.json({ success: true, balance: currentBalance, betId: betId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error placing bet' });
  }
});

app.post('/cancel_bet', async (req, res) => {
  const { phone, betId } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    if (typeof activeBets !== 'undefined' && activeBets.find(b => b.id === betId)) {
       return res.status(400).json({ error: 'Bet already locked for the round' });
    }

    const betResult = await pool.query("SELECT * FROM bets WHERE id = $1 AND phone = $2 AND status = 'placed'", [betId, formattedPhone]);
    if (betResult.rows.length === 0) return res.status(400).json({ error: 'Bet not found or already processed' });
    
    await pool.query("UPDATE bets SET status = 'cancelled' WHERE id = $1", [betId]);
    
    // Remove from in-memory arrays
    if (typeof activeBets !== 'undefined') activeBets = activeBets.filter(b => b.id !== betId);
    if (typeof pendingBets !== 'undefined') pendingBets = pendingBets.filter(b => b.id !== betId);

    const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [formattedPhone]);
    res.json({ success: true, balance: parseFloat(user.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cancelling bet' });
  }
});

app.post('/cashout', async (req, res) => {
  const { phone, amount, multiplier, betId } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    let winAmount = parseFloat(amount);
    let mult = parseFloat(multiplier);

    // If betId is provided, update the specific bet, otherwise update the latest placed bet for safety
    if (betId) {
      if (typeof activeBets !== 'undefined') {
        const bIndex = activeBets.findIndex(b => b.id === betId);
        if (bIndex >= 0) {
           if (activeBets[bIndex].cashedOut) return res.status(400).json({ error: 'Bet already cashed out' });
           activeBets[bIndex].cashedOut = true;
        }
      }
      const betCheck = await pool.query("SELECT * FROM bets WHERE id = $1 AND phone = $2 AND status = 'placed'", [betId, formattedPhone]);
      if (betCheck.rows.length === 0) return res.status(400).json({ error: 'Bet already cashed out or invalid' });
      
      await pool.query("UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE id = $2", [mult, betId]);
    } else {
      await pool.query(
        "UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE phone = $2 AND status = 'placed' AND id = (SELECT id FROM bets WHERE phone = $2 AND status = 'placed' ORDER BY id DESC LIMIT 1)",
        [mult, formattedPhone]
      );
    }

    await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE phone = $2',
      [winAmount, formattedPhone]
    );

    await pool.query(
      'INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)',
      [formattedPhone, winAmount, 'win', 'success']
    );

    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    res.json({ success: true, balance: parseFloat(user.rows[0].balance) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cashing out' });
  }
});

app.post('/withdraw', async (req, res) => {
  const { phone, amount } = req.body;
  const formattedPhone = formatPhone(phone);
  
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSH 100' });

  try {
    const user = await pool.query('SELECT balance, withdrawal_status FROM users WHERE phone = $1', [formattedPhone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (user.rows[0].withdrawal_status === 'disabled') {
      return res.status(403).json({ error: 'Withdrawals are currently disabled for your account. Please contact support.' });
    }

    let currentBalance = parseFloat(user.rows[0].balance);
    let withdrawAmount = parseFloat(amount);

    if (currentBalance < withdrawAmount) return res.status(400).json({ error: 'Insufficient balance' });

    await pool.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [withdrawAmount, formattedPhone]);
    
    // Save withdrawal in transactions table
    await pool.query(
      "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'withdrawal', 'success')",
      [formattedPhone, withdrawAmount]
    );

    // Send notification
    await pool.query(
      "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
      [formattedPhone, `Withdrawal of KSH ${withdrawAmount.toFixed(2)} was successful.`]
    );

    const updatedUser = await pool.query('SELECT balance FROM users WHERE phone = $1', [formattedPhone]);
    res.json({ success: true, balance: parseFloat(updatedUser.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during withdrawal' });
  }
});

/* =========================
   ADMIN DASHBOARD
========================= */

app.get('/admin/stats', async (req, res) => {
  const password = req.headers['authorization'];
  if (password !== '3462Abel@#') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalBalance = await pool.query('SELECT SUM(balance) FROM users');
    const totalBets = await pool.query('SELECT COUNT(*) FROM bets');
    
    res.json({ 
      success: true, 
      users: parseInt(totalUsers.rows[0].count),
      balance: parseFloat(totalBalance.rows[0].sum || 0),
      bets: parseInt(totalBets.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});


/* =========================
   ADMIN ADDITIONAL ROUTES
========================= */
app.post('/admin/set-odds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('next_multiplier', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [req.body.multiplier]);
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/set-bounds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const min = parseFloat(req.body.min);
    const max = parseFloat(req.body.max);
    if(!isNaN(min) && !isNaN(max)) {
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin_min_odd', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [min]);
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin_max_odd', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [max]);
      res.json({success: true});
    } else {
      await pool.query("DELETE FROM settings WHERE setting_key IN ('admin_min_odd', 'admin_max_odd')");
      res.json({success: true});
    }
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/create-user', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const { phone, username, pin, balance } = req.body;
    const formattedPhone = formatPhone(phone);
    if(!formattedPhone) return res.status(400).json({error: 'Invalid phone format'});
    
    await pool.query(
      'INSERT INTO users (username, phone, pin, balance) VALUES ($1, $2, $3, $4)',
      [username, formattedPhone, pin, parseFloat(balance) || 0]
    );
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/next-odd', async (req, res) => {
  try {
    const s = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'next_multiplier'");
    let mult = null;
    if(s.rows.length > 0 && s.rows[0].setting_value) {
      mult = parseFloat(s.rows[0].setting_value);
      await pool.query("UPDATE settings SET setting_value = '' WHERE setting_key = 'next_multiplier'");
      res.json({success: true, multiplier: mult});
    } else {
      res.json({success: true, multiplier: null});
    }
  } catch(e) { res.json({success: false}); }
});

app.get('/admin/users', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const users = await pool.query("SELECT id, username, phone, pin, balance, status, withdrawal_status FROM users ORDER BY id DESC");
    res.json({success: true, users: users.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/action', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { action, userId, amount } = req.body;
  try {
    if(action === 'delete') await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    else if(action === 'suspend') await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
    else if(action === 'activate') await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]);
     else if(action === 'disable_wd') await pool.query("UPDATE users SET withdrawal_status = 'disabled' WHERE id = $1", [userId]);
    else if(action === 'enable_wd') await pool.query("UPDATE users SET withdrawal_status = 'enabled' WHERE id = $1", [userId]);
    else if(action === 'adjust') {
      await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
      const u = await pool.query("SELECT phone FROM users WHERE id = $1", [userId]);
      if(u.rows.length > 0) {
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [u.rows[0].phone, amount, 'admin_adjustment', 'success']);
      }
    }
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/adjust-by-phone', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { phone, amount } = req.body;
  
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await pool.query("SELECT id FROM users WHERE phone = $1", [formattedPhone]);
    if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
    
    await pool.query("UPDATE users SET balance = balance + $1 WHERE phone = $2", [amount, formattedPhone]);
    await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [formattedPhone, amount, 'admin_adjustment', 'success']);
    
    res.json({success: true});
  } catch(e) { 
    res.status(500).json({error: e.message}); 
  }
});

app.post('/admin/set-fake-users', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  
  const { usernames } = req.body;
  if (Array.isArray(usernames)) {
     forcedFakeUsers = usernames;
     res.json({success: true});
  } else {
     res.status(400).json({error: 'Invalid data format'});
  }
});

app.get('/admin/transactions', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const tx = await pool.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100");
    res.json({success: true, transactions: tx.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/send-notification', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { target, phone, message } = req.body;
  try {
    let count = 0;
    if(target === 'all') {
      const users = await pool.query("SELECT phone FROM users WHERE status = 'active'");
      for(const u of users.rows) {
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [u.phone, message]);
        count++;
      }
    } else if(target === 'specific' && phone) {
      await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [phone, message]);
      count = 1;
    }
    res.json({success: true, count});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/notifications', async (req, res) => {
  const { phone } = req.query;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const notifs = await pool.query(
      "SELECT * FROM notifications WHERE phone = $1 ORDER BY created_at DESC LIMIT 50",
      [formattedPhone]
    );

    res.json({ success: true, notifications: notifs.rows });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { phone } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    await pool.query(
      "UPDATE notifications SET is_read = true WHERE phone = $1",
      [formattedPhone]
    );

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   REFERRAL SYSTEM
========================= */

app.get('/api/referrals', async (req, res) => {
  const { phone } = req.query;
  const formattedPhone = formatPhone(phone);
  
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const userResult = await pool.query('SELECT username, referral_code FROM users WHERE phone = $1', [formattedPhone]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const user = userResult.rows[0];
    
    // Get people referred by this user
    const referredUsersResult = await pool.query(
      'SELECT username, created_at FROM users WHERE referral_code = $1 ORDER BY created_at DESC', 
      [user.username]
    );
    
    // Get earnings from referrals (both joining bonus and deposit commissions)
    const earningsResult = await pool.query(
      "SELECT SUM(amount) as total_earned FROM transactions WHERE phone = $1 AND type IN ('referral_bonus', 'referral_commission') AND status = 'success'",
      [formattedPhone]
    );
    
    // Get total deposits by referred users
    let totalDeposits = 0;
    if (referredUsersResult.rows.length > 0) {
      const referredUsernames = referredUsersResult.rows.map(r => r.username);
      // Get their phones to query transactions
      const referredPhonesResult = await pool.query(
        'SELECT phone FROM users WHERE username = ANY($1)',
        [referredUsernames]
      );
      const referredPhones = referredPhonesResult.rows.map(r => r.phone);
      
      if (referredPhones.length > 0) {
        const depositsResult = await pool.query(
          "SELECT SUM(amount) as total FROM transactions WHERE phone = ANY($1) AND type = 'deposit' AND status = 'success'",
          [referredPhones]
        );
        totalDeposits = parseFloat(depositsResult.rows[0].total || 0);
      }
    }
    
    res.json({
      success: true,
      referred_by: user.referral_code,
      referral_link: `https://swiftcrash.com/?ref=${user.username}`,
      referrals: referredUsersResult.rows,
      active_referrals: referredUsersResult.rows.length,
      total_deposits: totalDeposits,
      total_earned: parseFloat(earningsResult.rows[0].total_earned || 0)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   GAME ENGINE & SSE
========================= */

let clients = [];
let gameStatus = 'WAITING';
let currentMultiplier = 1.00;
let currentCrashPoint = 1.00;
let oddsHistory = [];
let activeBets = [];
let pendingBets = [];

let cachedUsernames = ['johndoe', 'maryjane', 'alex2024', 'bettor99', 'luckykenya', 'nairobian', 'swiftbet', 'hustler', 'pambana', 'winner'];
const fakeRandomUsernames = [
  "d****g", "9***5", "f**l", "5**j", "kt**", "82**", "m**q", "3***x", "r***9", "t**v",
  "1*7", "z**f", "4***p", "n****3", "b**h", "6**y", "c***8", "w***r", "2***m", "g***4",
  "p***z", "7***k", "h***1", "q***6", "v**n", "0****d", "x***5", "ls**", "9***f", "j**2",
  "s**8", "e**w", "5*c"
];
async function refreshUsernames() {
  try {
    const res = await pool.query('SELECT username FROM users LIMIT 100');
    if(res.rows.length > 0) {
      cachedUsernames = res.rows.map(r => r.username);
    }
  } catch(e){}
}
setTimeout(refreshUsernames, 5000);
setInterval(refreshUsernames, 60000 * 10);

let fakeActiveBets = [];
let forcedFakeUsers = [];

function generateFakeBets() {
  const fakeBets = [];
  const numFake = 30;
  
  // Use forced users first, then reset
  let localForced = [...forcedFakeUsers];
  forcedFakeUsers = []; 
  
  for(let i=0; i<numFake; i++) {
    let name;
    let isReversed = false;
    
    if (localForced.length > 0) {
       name = localForced.shift();
    } else {
       name = fakeRandomUsernames[Math.floor(Math.random() * fakeRandomUsernames.length)];
    }
    
    if (isReversed && name && !name.includes('*')) name = name.split('').reverse().join('');
    if (!name) name = "player";
    
    let amount;
    const randAmt = Math.random();
    if (randAmt < 0.5) amount = Math.floor(Math.random() * 900) + 100;
    else if (randAmt < 0.8) amount = Math.floor(Math.random() * 4000) + 1000;
    else amount = Math.floor(Math.random() * 15000) + 5000;

    let cashout = null;
    if (Math.random() > 0.3) {
      const rand = Math.random();
      if (rand < 0.5) cashout = 1.01 + Math.random() * 1.5;
      else if (rand < 0.8) cashout = 1.5 + Math.random() * 3.5;
      else cashout = 5.0 + Math.random() * 15.0;
      cashout = parseFloat(cashout.toFixed(2));
    }

    fakeBets.push({
      id: 'fake_' + Date.now() + '_' + i,
      username: name && name.includes('*') ? name : maskUsername(name),
      amount: parseFloat(amount.toFixed(2)),
      plannedCashout: cashout,
      cashedOut: false,
      multiplier: null,
      winAmount: null,
      isFake: true
    });
  }
  return fakeBets;
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Send initial state
  res.write(`data: ${JSON.stringify({ status: gameStatus, multiplier: currentMultiplier, history: oddsHistory })}\n\n`);
  
  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

function broadcast(data) {
  // Merge fakeBets with activeBets for the UI
  let allBets = [...activeBets];
  
  // During RUNNING, only send non-cashed out fake bets and ones that cashed out
  // But wait, the client expects `activeBets` in the payload?
  // Let's just send activeBets: [...activeBets, ...fakeActiveBets]
  // We should process fakeBets cashedOut status within the gameLoop.

  if(data.status === 'RUNNING' || data.status === 'CRASHED' || data.status === 'WAITING') {
      const displayBets = allBets.map(b => {
          let uName = b.isFake ? b.username : "Player";
          if (!b.isFake) {
             // For real bets, we need the username if possible. 
             // We'll map it on the client or here if we joined it, but let's just mask their phone or if we have username.
             uName = b.username ? maskUsername(b.username) : maskUsername(b.phone.substring(b.phone.length - 4));
          }
          return {
             id: b.id,
             username: uName,
             amount: b.amount,
             cashedOut: b.cashedOut,
             multiplier: b.multiplier || (b.cashedOut ? b.plannedCashout : null),
             winAmount: b.winAmount || (b.cashedOut ? (b.amount * (b.multiplier || b.plannedCashout)) : null)
          };
      });
      data.activeBets = displayBets;
      
      let allCombined = [...displayBets];
      if (fakeActiveBets && fakeActiveBets.length > 0) {
         data.activeBets = [...displayBets, ...fakeActiveBets.map(b => ({
             id: b.id,
             username: b.username,
             amount: b.amount,
             cashedOut: b.cashedOut,
             multiplier: b.multiplier,
             winAmount: b.winAmount
         }))];
      }
  }

  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(msg));
}

async function getNextCrashPoint() {
   try {
     const s = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'next_multiplier'");
     if(s.rows.length > 0 && s.rows[0].setting_value) {
       let mult = parseFloat(s.rows[0].setting_value);
       await pool.query("UPDATE settings SET setting_value = '' WHERE setting_key = 'next_multiplier'");
       return mult;
     }
   } catch(e) {}
   
   try {
     const listQuery = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'odds_list'");
     if(listQuery.rows.length > 0 && listQuery.rows[0].setting_value) {
        let list = listQuery.rows[0].setting_value.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        if(list.length > 0) {
           return list[Math.floor(Math.random() * list.length)];
        }
     }
   } catch(e) {}
   
   try {
     const minQuery = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'admin_min_odd'");
     const maxQuery = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'admin_max_odd'");
     if(minQuery.rows.length > 0 && maxQuery.rows.length > 0) {
        let minVal = parseFloat(minQuery.rows[0].setting_value);
        let maxVal = parseFloat(maxQuery.rows[0].setting_value);
        if(!isNaN(minVal) && !isNaN(maxVal) && maxVal >= minVal) {
           return parseFloat((minVal + Math.random() * (maxVal - minVal)).toFixed(2));
        }
     }
   } catch(e) {}

   const rand = Math.random();
   let cp;
   if (rand < 0.5) {
      // 50% chance: 1.00 - 5.00 (Common)
      cp = 1.00 + Math.random() * 4.00;
   } else if (rand < 0.8) {
      // 30% chance: 5.00 - 50.00 (Professional range)
      cp = 5.00 + Math.random() * 45.00;
   } else if (rand < 0.95) {
      // 15% chance: 50.00 - 100.00 (Exciting range)
      cp = 50.00 + Math.random() * 50.00;
   } else {
      // 5% chance: 100.00 - 150.00 (Jackpot range)
      cp = 100.00 + Math.random() * 50.00;
   }
   return parseFloat(cp.toFixed(2));
}

async function runGameLoop() {
   gameStatus = 'WAITING';
   currentMultiplier = 1.00;
   fakeActiveBets = []; // Clear fake bets during waiting
   broadcast({ status: 'WAITING', time: 6, history: oddsHistory });
   
   let waitTime = 6;
   let waitInt = setInterval(async () => {
      waitTime--;
      broadcast({ status: 'WAITING', time: waitTime, history: oddsHistory });
      
      if (waitTime === 1) {
         // Move pending to active and deduct balances for the new round
         for (let i = 0; i < pendingBets.length; i++) {
           let bet = pendingBets[i];
           try {
             const userRes = await pool.query('SELECT balance FROM users WHERE phone = $1', [bet.phone]);
             if (userRes.rows.length > 0) {
               let bal = parseFloat(userRes.rows[0].balance);
               if (bal >= bet.amount) {
                 await pool.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [bet.amount, bet.phone]);
                 await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'bet', 'success')", [bet.phone, bet.amount]);
                 activeBets.push(bet);
               } else {
                 await pool.query("UPDATE bets SET status = 'cancelled' WHERE id = $1", [bet.id]);
               }
             }
           } catch (e) {
             console.error("Error processing pending bet:", e);
           }
         }
         pendingBets = [];
      }
      
      if(waitTime <= 0) clearInterval(waitInt);
   }, 1000);
   
   await new Promise(r => setTimeout(r, 6000));
   
   gameStatus = 'RUNNING';
   currentCrashPoint = await getNextCrashPoint();
   fakeActiveBets = generateFakeBets(); // Generate new fake bets for this round
   
   let startTime = Date.now();
   
   let gameInterval = setInterval(() => {
      let elapsedSec = (Date.now() - startTime) / 1000;
      // Exponential curve: e^(0.08 * t). This makes it start slow and grow faster.
      currentMultiplier = Math.max(1.00, Math.exp(0.08 * elapsedSec));
      
      // Auto cashout check
      activeBets.forEach(async (bet) => {
         if (bet.autoCashout && currentMultiplier >= bet.autoCashout && !bet.cashedOut) {
            bet.cashedOut = true;
            const winAmount = bet.amount * bet.autoCashout;
            try {
               await pool.query("UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE id = $2", [bet.autoCashout, bet.id]);
               await pool.query('UPDATE users SET balance = balance + $1 WHERE phone = $2', [winAmount, bet.phone]);
               await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'win', 'success')", [bet.phone, winAmount]);
            } catch(e) {}
         }
      });

      // Fake bets cashout check
      fakeActiveBets.forEach(bet => {
         if (!bet.cashedOut && bet.plannedCashout && currentMultiplier >= bet.plannedCashout) {
            bet.cashedOut = true;
            bet.multiplier = bet.plannedCashout;
            bet.winAmount = parseFloat((bet.amount * bet.plannedCashout).toFixed(2));
         }
      });

      if (currentMultiplier >= currentCrashPoint) {
         clearInterval(gameInterval);
         currentMultiplier = currentCrashPoint;
         gameStatus = 'CRASHED';
         
         // Mark remaining active bets as lost
         try {
             const lostIds = activeBets.filter(b => !b.cashedOut).map(b => b.id);
             if (lostIds.length > 0) {
                 pool.query("UPDATE bets SET status = 'lost' WHERE id = ANY($1)", [lostIds]).catch(()=>{});
             }
         } catch(e) {}
         
         // Active bets are cleared after broadcasting so the final payload has them
         const finalData = { status: 'CRASHED', multiplier: currentMultiplier, history: oddsHistory };
         
         oddsHistory.unshift(currentCrashPoint.toFixed(2));
         if(oddsHistory.length > 15) oddsHistory.pop();
         
         broadcast(finalData);
         
         activeBets = [];
         
         setTimeout(() => {
            runGameLoop();
         }, 3000);
      } else {
         broadcast({ status: 'RUNNING', multiplier: currentMultiplier });
      }
   }, 50);
}

// Start game engine only after DB connects
pool.connect().then(() => runGameLoop()).catch(err => console.log(err));

/* =========================
   STK PAYMENT ROUTES
========================= */

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });

    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: process.env.BASE_URL + "/callback",
      channel_id: "000603"
    };

    const resp = await axios.post(
      "https://swiftwallet.co.ke/v3/stk-initiate/",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SWIFTWALLET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (resp.data.success) {
      const receiptData = {
        reference,
        amount: Math.round(amount),
        phone: formattedPhone,
        status: "pending",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, reference });

    } else {
      res.status(400).json({
        success: false,
        error: resp.data.error || "Failed to initiate payment"
      });
    }

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || "Server error"
    });
  }
});

app.post("/callback", async (req, res) => {
  const data = req.body;
  const ref = data.external_reference;

  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};
  const resultCode = data.result?.ResultCode;

  if (resultCode === 0) {

    receipts[ref] = {
      ...existingReceipt,
      status: "success",
      transaction_code: data.result?.MpesaReceiptNumber || null,
      amount: data.result?.Amount || existingReceipt.amount,
      phone: data.result?.Phone || existingReceipt.phone,
      timestamp: new Date().toISOString()
    };

    writeReceipts(receipts);

    // ✅ DIRECT DATABASE UPDATE (NO HTTP CALL)
    try {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE phone = $2',
        [receipts[ref].amount, receipts[ref].phone]
      );
      await pool.query('INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, $3, $4, $5)', 
        [receipts[ref].phone, receipts[ref].amount, 'deposit', ref, 'success']);
      await pool.query('INSERT INTO notifications (phone, message) VALUES ($1, $2)',
        [receipts[ref].phone, `Your deposit of KSH ${receipts[ref].amount} was successful.`]);

      // Process Referral Commission (5%)
      const userRes = await pool.query('SELECT username, referral_code FROM users WHERE phone = $1', [receipts[ref].phone]);
      if (userRes.rows.length > 0 && userRes.rows[0].referral_code) {
        const referrerUsername = userRes.rows[0].referral_code;
        const commission = receipts[ref].amount * 0.05;
        
        await pool.query('UPDATE users SET balance = balance + $1 WHERE username = $2', [commission, referrerUsername]);
        
        const referrerRes = await pool.query('SELECT phone FROM users WHERE username = $1', [referrerUsername]);
        if (referrerRes.rows.length > 0) {
           const referrerPhone = referrerRes.rows[0].phone;
           await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'referral_commission', 'success')", [referrerPhone, commission]);
           await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received KSH ${commission.toFixed(2)} commission from ${userRes.rows[0].username}'s deposit.`]);
        }
      }

      console.log("✅ Balance updated in PostgreSQL");
    } catch (err) {
      console.error("❌ DB update failed:", err.message);
    }

  } else {
    receipts[ref] = {
      ...existingReceipt,
      status: "failed",
      timestamp: new Date().toISOString()
    };
    writeReceipts(receipts);
  }

  res.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

/* =========================
   RECEIPT ROUTES
========================= */

app.get("/receipt/:reference", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  res.json({ success: true, receipt });
});

app.get("/receipt/:reference/pdf", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found" });
  }

  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${reference}.pdf`);
  doc.pipe(res);

  doc.fontSize(18).text("Payment Receipt", { align: "center" });
  doc.moveDown();
  doc.text(`Reference: ${receipt.reference}`);
  doc.text(`Phone: ${receipt.phone}`);
  doc.text(`Amount: KES ${receipt.amount}`);
  doc.text(`Status: ${receipt.status}`);
  doc.text(`Transaction Code: ${receipt.transaction_code || "N/A"}`);
  doc.text(`Date: ${receipt.timestamp}`);

  doc.end();
});

// REMOVED DUPLICATE LISTEN CALL HERE

