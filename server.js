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

// The port MUST be exactly what Replit expects or it won't be accessible
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

/* =========================
   DATABASE CONNECTION
========================= */

// Render is outside Railway's private network, so it cannot resolve
// `postgres.railway.internal`. Set DATABASE_PUBLIC_URL in Render to the
// public connection string from Railway's Connect dialog. RAILWAY_DATABASE_URL
// is also supported so the same source can be used in other environments.
const databaseUrl =
  process.env.DATABASE_PUBLIC_URL ||
  process.env.RAILWAY_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Missing database connection string. Set DATABASE_PUBLIC_URL (Railway public URL) or DATABASE_URL."
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);
      // Keep signup/welcome funds identifiable so the admin can safely
      // deduct only bonus funds instead of guessing from the main balance.
      await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS bonus_balance DECIMAL(15, 2) DEFAULT 0.00
      `);

      // 2. Bets Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bets (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            multiplier DECIMAL(10, 2),
            status VARCHAR(20) NOT NULL DEFAULT 'placed',
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);

      // 4. Threshold Withdrawal Requests
      await pool.query(`
        CREATE TABLE IF NOT EXISTS withdrawal_requests (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            fee DECIMAL(15, 2) NOT NULL,
            reference VARCHAR(100) UNIQUE NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'awaiting_fee',
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'),
            updated_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'),
            expires_at TIMESTAMP NOT NULL
        );
      `);

      // 4. Notifications Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);

      // 7. Chat Likes Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_likes (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);
      await pool.query(`
        DELETE FROM chat_likes older
        USING chat_likes newer
        WHERE older.id > newer.id
          AND older.chat_id = newer.chat_id
          AND older.username = newer.username
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS chat_likes_chat_user_idx
        ON chat_likes (chat_id, username)
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);

      // 9. Cashrain Claims Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cashrain_claims (
            id SERIAL PRIMARY KEY,
            cashrain_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
        );
      `);

      // Insert Default Settings
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value) 
        VALUES ('chat_locked', 'false') 
        ON CONFLICT (setting_key) DO NOTHING;
      `);
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value) VALUES
          ('signup_bonus_amount', '0'),
          ('signup_bonus_enabled', 'false'),
          ('referral_reward_amount', '20'),
          ('referral_commission_percent', '5'),
          ('threshold_mode', 'disabled')
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

  function avatarSeed(username) {
    let hash = 2166136261;
    for (const character of String(username || 'anon')) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
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

function calculateThresholdFee(amount) {
  const withdrawalAmount = Number(amount);
  if (!Number.isFinite(withdrawalAmount) || withdrawalAmount < 500) return 0;

  // Fee schedule: 500 => 100, 600 => 150, 700 => 200,
  // 1000 => 350, 2000 => 850. Amounts between listed tiers use
  // the lower tier until the next KSH 100 boundary.
  return 100 + Math.floor((withdrawalAmount - 500) / 100) * 50;
}

function createPaymentReference(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function saveReceipt(reference, patch) {
  const receipts = readReceipts();
  receipts[reference] = { ...(receipts[reference] || {}), ...patch };
  writeReceipts(receipts);
  return receipts[reference];
}

function stringifyProviderValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function getSwiftWalletError(err, responseData = err?.response?.data) {
  const rawResponse =
    typeof responseData === "string" ? responseData.trim().slice(0, 1000) : "";
  const providerError =
    responseData?.error ||
    responseData?.message ||
    responseData?.detail ||
    rawResponse ||
    err?.message ||
    "Could not send STK push";
  const errorCode = responseData?.error_code || responseData?.code;
  const details = responseData?.details;
  const parts = [];

  if (errorCode && String(errorCode) !== String(providerError)) {
    parts.push(`[${errorCode}]`);
  }
  parts.push(stringifyProviderValue(providerError));
  if (details) parts.push(`Details: ${stringifyProviderValue(details)}`);

  return {
    status: err?.response?.status || null,
    errorCode: errorCode || null,
    details: details || null,
    message: parts.join(" ")
  };
}

async function initiateStkPayment({ phone, amount, reference }) {
  const swiftwalletKey =
    process.env.SWIFTWALLET_KEY || process.env.SWIFTWALLET_API_KEY;
  const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
  const swiftwalletChannelId = process.env.SWIFTWALLET_CHANNEL_ID;

  if (!swiftwalletKey) {
    return {
      success: false,
      status: 503,
      error: "Payment service is not configured. Set SWIFTWALLET_KEY in Render."
    };
  }
  if (!baseUrl) {
    return {
      success: false,
      status: 503,
      error: "Payment callback is not configured. Set BASE_URL in Render."
    };
  }
  if (!swiftwalletChannelId || !/^\d+$/.test(swiftwalletChannelId)) {
    return {
      success: false,
      status: 503,
      error: "Payment channel is not configured. Set SWIFTWALLET_CHANNEL_ID in Render."
    };
  }

  const requestBody = {
    amount: Math.round(amount),
    phone_number: phone,
    external_reference: reference,
    customer_name: "Customer",
    callback_url: baseUrl + "/callback",
    // Keep this as a string so channel IDs with leading zeros remain intact.
    channel_id: swiftwalletChannelId
  };

  try {
    const resp = await axios.post(
      "https://swiftwallet.co.ke/v3/stk-initiate/",
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${swiftwalletKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 15000
      }
    );

    if (!resp.data?.success) {
      const provider = getSwiftWalletError(null, resp.data);
      return {
        success: false,
        status: 502,
        error: provider.message,
        providerStatus: resp.status,
        providerErrorCode: provider.errorCode,
        providerDetails: provider.details
      };
    }

    return { success: true };
  } catch (err) {
    const provider = getSwiftWalletError(err);
    console.error("SwiftWallet STK initiation failed:", JSON.stringify({
      status: provider.status,
      errorCode: provider.errorCode,
      details: provider.details,
      message: provider.message,
      reference,
      amount: Math.round(amount),
      phone: phone ? `${phone.slice(0, 6)}******${phone.slice(-2)}` : null
    }));
    return {
      success: false,
      status: 502,
      error: provider.message,
      providerStatus: provider.status,
      providerErrorCode: provider.errorCode,
      providerDetails: provider.details
    };
  }
}

async function settleThresholdWithdrawal(id, status, notificationMessage) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const requestResult = await client.query(
      'SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const request = requestResult.rows[0];
    if (request.status !== 'awaiting_fee') {
      await client.query('ROLLBACK');
      const balanceResult = await pool.query(
        'SELECT balance FROM users WHERE phone = $1',
        [request.phone]
      );
      return {
        ...request,
        balance: parseFloat(balanceResult.rows[0]?.balance || 0)
      };
    }

    const refundStatuses = ['cancelled_by_user', 'timeout', 'failed'];
    if (refundStatuses.includes(status)) {
      await client.query(
        'UPDATE users SET balance = balance + $1 WHERE phone = $2',
        [request.amount, request.phone]
      );
      await client.query(
        "UPDATE transactions SET status = $1 WHERE reference = $2 AND type = 'withdrawal' AND status = 'pending'",
        [status, request.reference]
      );
    }

    await client.query(
      'UPDATE withdrawal_requests SET status = $1, updated_at = CURRENT_TIMESTAMP AT TIME ZONE \'Africa/Nairobi\' WHERE id = $2',
      [status, id]
    );
    if (notificationMessage) {
      await client.query(
        'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
        [request.phone, notificationMessage]
      );
    }
    await client.query('COMMIT');

    const balanceResult = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [request.phone]
    );
    return {
      ...request,
      status,
      balance: parseFloat(balanceResult.rows[0]?.balance || 0)
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function completeThresholdWithdrawal(reference, transactionCode) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const requestResult = await client.query(
      'SELECT * FROM withdrawal_requests WHERE reference = $1 FOR UPDATE',
      [reference]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const request = requestResult.rows[0];
    if (request.status !== 'awaiting_fee') {
      await client.query('ROLLBACK');
      return request;
    }

    if (new Date(request.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return settleThresholdWithdrawal(
        request.id,
        'timeout',
        `Threshold payment timed out. KSH ${Number(request.amount).toFixed(2)} was refunded.`
      );
    }

    await client.query(
      "UPDATE withdrawal_requests SET status = 'success', updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' WHERE id = $1",
      [request.id]
    );
    await client.query(
      "UPDATE transactions SET status = 'success' WHERE reference = $1 AND type = 'withdrawal' AND status = 'pending'",
      [reference]
    );
    await client.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal_fee', $3, 'success')",
      [request.phone, request.fee, reference]
    );
    await client.query(
      'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
      [request.phone, `Threshold fee of KSH ${Number(request.fee).toFixed(2)} paid. Withdrawal of KSH ${Number(request.amount).toFixed(2)} is being processed.`]
    );
    await client.query('COMMIT');
    return { ...request, status: 'success', transaction_code: transactionCode };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}


  /* =========================
     CHAT ROUTES
  ========================= */

  app.get('/chat/messages', async (req, res) => {
    try {
      const viewerPhone = formatPhone(req.query.phone || '');
      const viewerIsAdmin =
        req.query.admin === 'true' &&
        req.headers.authorization === '3462Abel@#';
      let viewerUsername = viewerIsAdmin ? 'captain' : null;
      if (!viewerUsername && viewerPhone) {
        const viewer = await pool.query(
          'SELECT username FROM users WHERE phone = $1',
          [viewerPhone]
        );
        viewerUsername = viewer.rows[0]?.username || null;
      }

      const lockCheck = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'chat_locked'");
      const isLocked = lockCheck.rows.length > 0 && lockCheck.rows[0].setting_value === 'true';
      
      // Cleanup old chats (> 48 hours)
      await pool.query("DELETE FROM chats WHERE created_at < CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' - INTERVAL '48 hours'");
      
      // Fetch last 150 messages
      const msgs = await pool.query(`
        SELECT c.*, cr.amount, cr.max_claims, cr.current_claims,
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' - cr.created_at)) as cr_seconds_passed,
               EXISTS (
                 SELECT 1
                 FROM chat_likes viewer_like
                 WHERE viewer_like.chat_id = c.id
                   AND viewer_like.username = $1
               ) AS liked_by_current_user
        FROM chats c
        LEFT JOIN cashrains cr ON cr.chat_id = c.id
        ORDER BY c.created_at DESC, c.id DESC LIMIT 150
      `, [viewerUsername || '']);
      
      const formatted = msgs.rows.map(m => {
        return {
          id: m.id,
          username: m.is_admin ? "captain" : maskUsername(m.username),
          avatar_seed: avatarSeed(m.username),
          message: m.message,
          is_admin: m.is_admin,
          type: m.type,
          amount: m.amount,
          max_claims: m.max_claims,
          current_claims: m.current_claims,
          cr_seconds_passed: m.cr_seconds_passed,
          created_at: m.created_at,
          likes: m.likes || 0,
          reply_to: m.reply_to,
          liked_by_current_user: Boolean(m.liked_by_current_user)
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
    const numericChatId = Number(chatId);
    if (!Number.isInteger(numericChatId) || numericChatId <= 0) {
      return res.status(400).json({ error: 'Invalid chat message' });
    }

    let username;
    if (isAdmin && req.headers['authorization'] === '3462Abel@#') {
      username = 'captain';
    } else {
      const formattedPhone = formatPhone(phone);
      const user = await pool.query("SELECT username FROM users WHERE phone = $1", [formattedPhone]);
      if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
      username = user.rows[0].username;
    }

    const checkLike = await pool.query(
      "SELECT id FROM chat_likes WHERE chat_id = $1 AND username = $2",
      [numericChatId, username]
    );
    if (checkLike.rows.length > 0) {
      await pool.query(
        "DELETE FROM chat_likes WHERE chat_id = $1 AND username = $2",
        [numericChatId, username]
      );
      await pool.query(
        "UPDATE chats SET likes = GREATEST(likes - 1, 0) WHERE id = $1",
        [numericChatId]
      );
      return res.json({ success: true, liked: false });
    }

    const insertedLike = await pool.query(
      "INSERT INTO chat_likes (chat_id, username) VALUES ($1, $2) ON CONFLICT (chat_id, username) DO NOTHING",
      [numericChatId, username]
    );
    if (insertedLike.rowCount === 0) {
      return res.json({ success: true, liked: true });
    }
    await pool.query(
      "UPDATE chats SET likes = likes + 1 WHERE id = $1 AND EXISTS (SELECT 1 FROM chat_likes WHERE chat_id = $1 AND username = $2)",
      [numericChatId, username]
    );
    
    res.json({ success: true, liked: true });
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

    const bonusSettings = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('signup_bonus_amount', 'signup_bonus_enabled', 'referral_reward_amount')"
    );
    const bonusMap = Object.fromEntries(
      bonusSettings.rows.map(row => [row.setting_key, row.setting_value])
    );
    const signupBonusEnabled = bonusMap.signup_bonus_enabled === 'true';
    const signupBonus = signupBonusEnabled
      ? Math.max(0, parseFloat(bonusMap.signup_bonus_amount || '0') || 0)
      : 0;
    const referralReward = Math.max(
      0,
      parseFloat(bonusMap.referral_reward_amount || '20') || 0
    );

    await pool.query(
      'INSERT INTO users (username, phone, pin, balance, bonus_balance, referral_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, formattedPhone, pin, signupBonus, signupBonus, actualReferralCode]
    );

    if (signupBonus > 0) {
      await pool.query(
        "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'signup_bonus', 'success')",
        [formattedPhone, signupBonus]
      );
      await pool.query(
        "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
        [formattedPhone, `Welcome bonus of KSH ${signupBonus.toFixed(2)} credited to your balance.`]
      );
    }

    if (actualReferralCode) {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE username = $2',
        [referralReward, actualReferralCode]
      );
      const referrerUser = await pool.query('SELECT phone FROM users WHERE username = $1', [actualReferralCode]);
      if (referrerUser.rows.length > 0) {
        const referrerPhone = referrerUser.rows[0].phone;
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [referrerPhone, referralReward, 'referral_bonus', 'success']);
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received KSH ${referralReward.toFixed(2)} for referring ${username}.`]);
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
      "SELECT amount, type, status, created_at FROM transactions WHERE phone = $1 AND type IN ('withdrawal', 'withdrawal_fee', 'deposit') ORDER BY created_at DESC",
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
      'SELECT username, balance FROM users WHERE phone = $1',
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
  const withdrawAmount = Number(amount);
  if (!Number.isFinite(withdrawAmount) || withdrawAmount < 100) {
    return res.status(400).json({ error: 'Minimum withdrawal is KSH 100' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const user = await client.query(
      'SELECT balance, withdrawal_status FROM users WHERE phone = $1 FOR UPDATE',
      [formattedPhone]
    );
    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.rows[0].withdrawal_status === 'disabled') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Withdrawals are currently disabled for your account. Please contact support.' });
    }

    const currentBalance = parseFloat(user.rows[0].balance);
    const thresholdSettings = await client.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'threshold_mode'"
    );
    const thresholdEnabled = thresholdSettings.rows[0]?.setting_value === 'enabled';
    const fee = thresholdEnabled ? calculateThresholdFee(withdrawAmount) : 0;
    const reference = createPaymentReference('WITHDRAWAL-FEE');

    if (currentBalance < withdrawAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Insufficient balance for withdrawal'
      });
    }

    // Direct withdrawals remain immediate when threshold mode is disabled.
    // Threshold mode reserves the withdrawal amount and waits for the fee STK.
    if (!thresholdEnabled || fee <= 0) {
      await client.query(
        'UPDATE users SET balance = balance - $1 WHERE phone = $2',
        [withdrawAmount, formattedPhone]
      );
      await client.query(
        "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'withdrawal', 'success')",
        [formattedPhone, withdrawAmount]
      );
      await client.query(
        'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
        [formattedPhone, `Withdrawal of KSH ${withdrawAmount.toFixed(2)} was successful.`]
      );
      await client.query('COMMIT');

      const updatedUser = await pool.query(
        'SELECT balance FROM users WHERE phone = $1',
        [formattedPhone]
      );
      return res.json({
        success: true,
        balance: parseFloat(updatedUser.rows[0].balance),
        threshold: false,
        fee: 0,
        withdrawAmount,
        totalDebited: withdrawAmount
      });
    }

    const expiresAt = new Date(Date.now() + 20000);
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE phone = $2',
      [withdrawAmount, formattedPhone]
    );
    await client.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal', $3, 'pending')",
      [formattedPhone, withdrawAmount, reference]
    );
    const requestResult = await client.query(
      "INSERT INTO withdrawal_requests (phone, amount, fee, reference, status, expires_at) VALUES ($1, $2, $3, $4, 'awaiting_fee', $5) RETURNING id",
      [formattedPhone, withdrawAmount, fee, reference, expiresAt]
    );
    await client.query('COMMIT');

    const updatedUser = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );
    const reservedBalance = parseFloat(updatedUser.rows[0].balance);
    saveReceipt(reference, {
      reference,
      kind: 'withdrawal_fee',
      request_id: requestResult.rows[0].id,
      amount: fee,
      withdraw_amount: withdrawAmount,
      phone: formattedPhone,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
      timestamp: new Date().toISOString()
    });

    const stk = await initiateStkPayment({
      phone: formattedPhone,
      amount: fee,
      reference
    });
    if (!stk.success) {
      saveReceipt(reference, {
        status: 'stk_failed',
        status_message: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails,
        timestamp: new Date().toISOString()
      });
      await settleThresholdWithdrawal(
        requestResult.rows[0].id,
        'failed',
        `Threshold payment could not be sent. KSH ${withdrawAmount.toFixed(2)} was refunded.`
      );
      return res.status(stk.status || 502).json({
        success: false,
        error: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails
      });
    }

    res.json({
      success: true,
      balance: parseFloat(updatedUser.rows[0].balance),
      threshold: true,
      fee,
      withdrawAmount,
      totalDebited: withdrawAmount,
      pendingId: requestResult.rows[0].id,
      reference,
      stkSent: true,
      expiresIn: 20
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(err);
    res.status(500).json({ error: 'Server error during withdrawal' });
  } finally {
    if (client) client.release();
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
    const transactionTotals = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND status = 'success'), 0) AS deposits,
        COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal' AND status = 'success'), 0) AS withdrawals,
        COUNT(*) FILTER (WHERE type = 'withdrawal' AND status = 'pending') AS pending_withdrawals
      FROM transactions
    `);
    
    res.json({ 
      success: true, 
      users: parseInt(totalUsers.rows[0].count),
      balance: parseFloat(totalBalance.rows[0].sum || 0),
      bets: parseInt(totalBets.rows[0].count),
      activeUsers: clients.length,
      totalDeposits: parseFloat(transactionTotals.rows[0].deposits || 0),
      totalWithdrawals: parseFloat(transactionTotals.rows[0].withdrawals || 0),
      pendingWithdrawals: parseInt(transactionTotals.rows[0].pending_withdrawals || 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});

/* =========================
   ADMIN SETTINGS & LIVE DATA
========================= */
app.get('/admin/signup-bonus', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('signup_bonus_amount', 'signup_bonus_enabled')"
    );
    const values = Object.fromEntries(
      result.rows.map(row => [row.setting_key, row.setting_value])
    );
    res.json({
      success: true,
      amount: Math.max(0, parseFloat(values.signup_bonus_amount || '0') || 0),
      enabled: values.signup_bonus_enabled === 'true'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load signup bonus settings' });
  }
});

app.post('/admin/signup-bonus', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  const amount = Number(req.body.amount);
  const enabled = req.body.enabled === true || req.body.enabled === 'true';
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'Bonus amount must be zero or greater' });
  }
  try {
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('signup_bonus_amount', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
      [amount.toFixed(2)]
    );
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('signup_bonus_enabled', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
      [enabled ? 'true' : 'false']
    );
    res.json({ success: true, amount, enabled });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save signup bonus settings' });
  }
});

app.get('/admin/referral-settings', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('referral_reward_amount', 'referral_commission_percent')"
    );
    const values = Object.fromEntries(
      result.rows.map(row => [row.setting_key, row.setting_value])
    );
    res.json({
      success: true,
      rewardAmount: Math.max(0, parseFloat(values.referral_reward_amount || '20') || 0),
      commissionPercent: Math.min(100, Math.max(0, parseFloat(values.referral_commission_percent || '5') || 0))
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load referral settings' });
  }
});

app.post('/admin/referral-settings', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });

  const rewardAmount = Number(req.body.rewardAmount);
  const commissionPercent = Number(req.body.commissionPercent);
  if (!Number.isFinite(rewardAmount) || rewardAmount < 0) {
    return res.status(400).json({ error: 'Referral reward must be zero or greater' });
  }
  if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    return res.status(400).json({ error: 'Commission percentage must be between 0 and 100' });
  }

  try {
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('referral_reward_amount', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
      [rewardAmount.toFixed(2)]
    );
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('referral_commission_percent', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
      [commissionPercent.toFixed(2)]
    );
    res.json({ success: true, rewardAmount, commissionPercent });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save referral settings' });
  }
});

app.get('/admin/threshold-settings', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'threshold_mode'"
    );
    const thresholdMode = result.rows[0]?.setting_value === 'enabled' ? 'enabled' : 'disabled';
    res.json({ success: true, threshold_mode: thresholdMode });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load threshold settings' });
  }
});

app.post('/admin/threshold-settings', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  if (req.body.deduct_bonus === true) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const deducted = await client.query(`
        WITH eligible AS (
          SELECT phone, GREATEST(LEAST(balance, bonus_balance), 0) AS amount
          FROM users
          WHERE bonus_balance > 0
        )
        UPDATE users u
        SET balance = u.balance - eligible.amount,
            bonus_balance = 0
        FROM eligible
        WHERE u.phone = eligible.phone
        RETURNING u.phone, eligible.amount
      `);

      for (const row of deducted.rows) {
        const amount = Number(row.amount || 0);
        if (amount <= 0) continue;
        await client.query(
          "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'bonus_deduction', 'success')",
          [row.phone, -amount]
        );
        await client.query(
          "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
          [row.phone, `Bonus balance of KSH ${amount.toFixed(2)} was removed by the administrator.`]
        );
      }
      await client.query('COMMIT');
      return res.json({ success: true, usersUpdated: deducted.rows.length });
    } catch (e) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      return res.status(500).json({ error: 'Failed to deduct bonus balances' });
    } finally {
      if (client) client.release();
    }
  }
  const mode = req.body.threshold_mode;
  if (!['disabled', 'enabled'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid threshold mode' });
  }
  try {
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('threshold_mode', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
      [mode]
    );
    res.json({ success: true, threshold_mode: mode });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save threshold settings' });
  }
});

app.get('/api/threshold-mode', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'threshold_mode'"
    );
    const thresholdMode = result.rows[0]?.setting_value === 'enabled' ? 'enabled' : 'disabled';
    res.json({ success: true, threshold_mode: thresholdMode });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load threshold mode' });
  }
});

app.get('/api/referral-settings', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('referral_reward_amount', 'referral_commission_percent')"
    );
    const values = Object.fromEntries(
      result.rows.map(row => [row.setting_key, row.setting_value])
    );
    res.json({
      success: true,
      rewardAmount: Math.max(0, parseFloat(values.referral_reward_amount || '20') || 0),
      commissionPercent: Math.min(100, Math.max(0, parseFloat(values.referral_commission_percent || '5') || 0)),
      rules: [
        'Referral rewards apply only to successful deposits.',
        'The commission continues for the referred user lifetime while the account remains active.',
        'Self-referrals, duplicate accounts, and reversed or failed payments are not eligible.',
        'Referral rewards are credited automatically after the deposit callback is confirmed.'
      ]
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load referral settings' });
  }
});

app.get('/admin/pending-withdrawals', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const withdrawals = await pool.query(`
      SELECT t.id, t.phone, u.username, t.amount, 0 AS fee, t.status, t.created_at
      FROM transactions t
      LEFT JOIN users u ON u.phone = t.phone
      WHERE t.type = 'withdrawal' AND t.status = 'pending'
      ORDER BY t.created_at DESC
      LIMIT 100
    `);
    res.json({ success: true, withdrawals: withdrawals.rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load pending withdrawals' });
  }
});

app.get('/admin/active-bets', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({
      success: true,
      gameStatus,
      currentMultiplier: Number(currentMultiplier.toFixed(2)),
      activeBets: activeBets.map(bet => ({
        id: bet.id,
        username: bet.username || bet.phone,
        phone: bet.phone,
        amount: Number(bet.amount),
        cashedOut: Boolean(bet.cashedOut)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load active bets' });
  }
});

app.get('/admin/active-users', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (pwd !== '3462Abel@#') return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, activeUsers: clients.length });
});


/* =========================
   ADMIN ADDITIONAL ROUTES
========================= */
app.post('/admin/set-odds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const multiplier = Number(req.body.multiplier);
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      return res.status(400).json({ error: 'Multiplier must be a number of at least 1.00' });
    }
    await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('next_multiplier', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [multiplier.toFixed(2)]);
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/set-bounds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const min = parseFloat(req.body.min);
    const max = parseFloat(req.body.max);
    if(Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max >= min) {
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin_min_odd', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [min]);
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin_max_odd', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [max]);
      res.json({success: true});
    } else {
      res.status(400).json({ error: 'Enter valid odds with min at least 1.00 and max greater than or equal to min' });
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
    if(!username || !/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({error: 'Username may contain only letters, numbers, and underscores'});
    }
    if(!/^\d{6}$/.test(String(pin || ''))) {
      return res.status(400).json({error: 'PIN must be exactly 6 digits'});
    }
    const initialBalance = Number(balance);
    if(!Number.isFinite(initialBalance) || initialBalance < 0) {
      return res.status(400).json({error: 'Initial balance must be zero or greater'});
    }
    
    await pool.query(
      'INSERT INTO users (username, phone, pin, balance) VALUES ($1, $2, $3, $4)',
      [username, formattedPhone, pin, initialBalance]
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
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount === 0) {
        return res.status(400).json({ error: 'Adjustment amount must be a non-zero number' });
      }
      const updated = await pool.query(
        "UPDATE users SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= 0 RETURNING phone",
        [numericAmount, userId]
      );
      if (updated.rows.length === 0) {
        return res.status(400).json({ error: 'User not found or adjustment would make balance negative' });
      }
      const u = await pool.query("SELECT phone FROM users WHERE id = $1", [userId]);
      if(u.rows.length > 0) {
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [u.rows[0].phone, numericAmount, 'admin_adjustment', 'success']);
      }
    } else return res.status(400).json({ error: 'Unknown user action' });
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/adjust-by-phone', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { phone, amount } = req.body;
  
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await pool.query("SELECT id FROM users WHERE phone = $1", [formattedPhone]);
    if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
    
    const updated = await pool.query(
      "UPDATE users SET balance = balance + $1 WHERE phone = $2 AND balance + $1 >= 0 RETURNING balance",
      [numericAmount, formattedPhone]
    );
    if (updated.rows.length === 0) return res.status(400).json({ error: 'Adjustment would make balance negative' });
    await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [formattedPhone, numericAmount, 'admin_adjustment', 'success']);
    
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
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    let count = 0;
    if(target === 'all') {
      const users = await pool.query("SELECT phone FROM users WHERE status = 'active'");
      for(const u of users.rows) {
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [u.phone, message]);
        count++;
      }
    } else if(target === 'specific' && phone) {
      const formattedPhone = formatPhone(phone);
      if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
      const user = await pool.query("SELECT phone FROM users WHERE phone = $1 AND status = 'active'", [formattedPhone]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'Active user not found' });
      await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [formattedPhone, message.trim()]);
      count = 1;
    } else return res.status(400).json({ error: 'Invalid notification target' });
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
    
    const referralSettings = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('referral_reward_amount', 'referral_commission_percent')"
    );
    const referralValues = Object.fromEntries(
      referralSettings.rows.map(row => [row.setting_key, row.setting_value])
    );

    res.json({
      success: true,
      referred_by: user.referral_code,
      referral_link: `https://swiftcrash.com/?ref=${user.username}`,
      referrals: referredUsersResult.rows,
      active_referrals: referredUsersResult.rows.length,
      total_deposits: totalDeposits,
      total_earned: parseFloat(earningsResult.rows[0].total_earned || 0),
      referral_reward: Math.max(0, parseFloat(referralValues.referral_reward_amount || '20') || 0),
      commission_percent: Math.min(100, Math.max(0, parseFloat(referralValues.referral_commission_percent || '5') || 0))
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
let gameStartedAt = null;
const GAME_GROWTH_RATE = 0.08;
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
  res.write(`data: ${JSON.stringify({
    status: gameStatus,
    multiplier: currentMultiplier,
    history: oddsHistory,
    startedAt: gameStartedAt,
    growthRate: GAME_GROWTH_RATE,
    serverTime: Date.now()
  })}\n\n`);
  
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
   gameStartedAt = null;
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
   gameStartedAt = Date.now();
   const startTime = gameStartedAt;
   
   let gameInterval = setInterval(() => {
      let elapsedSec = (Date.now() - startTime) / 1000;
      // Exponential curve: e^(0.08 * t). This makes it start slow and grow faster.
       currentMultiplier = Math.max(
         1.00,
         Number(Math.exp(GAME_GROWTH_RATE * elapsedSec).toFixed(4))
       );
      
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
          broadcast({
            status: 'RUNNING',
            multiplier: currentMultiplier,
            startedAt: gameStartedAt,
            growthRate: GAME_GROWTH_RATE,
            serverTime: Date.now()
          });
      }
    }, 33);
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
    const numericAmount = Number(amount);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });

    if (!Number.isFinite(numericAmount) || numericAmount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = createPaymentReference("ORDER");
    const expiresAt = new Date(Date.now() + 20000);
    saveReceipt(reference, {
      reference,
      kind: "deposit",
      amount: Math.round(numericAmount),
      phone: formattedPhone,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      timestamp: new Date().toISOString()
    });

    const stk = await initiateStkPayment({
      phone: formattedPhone,
      amount: numericAmount,
      reference
    });
    if (!stk.success) {
      saveReceipt(reference, {
        status: "stk_failed",
        status_message: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails,
        timestamp: new Date().toISOString()
      });
      return res.status(stk.status || 502).json({
        success: false,
        error: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails
      });
    }

    res.json({ success: true, reference, expiresIn: 20 });
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

  const receipts = readReceipts();
  const existingReceipt = receipts[ref];
  const resultCode = Number(data.result?.ResultCode);

  if (!ref || !existingReceipt) {
    return res.json({ ResultCode: 0, ResultDesc: "Unknown payment reference" });
  }

  // A late or duplicate callback must never credit/refund a settled payment.
  if (existingReceipt.status !== "pending") {
    return res.json({ ResultCode: 0, ResultDesc: "Payment already settled" });
  }

  if (resultCode === 0) {
    const transactionCode = data.result?.MpesaReceiptNumber || null;

    if (existingReceipt.kind === "withdrawal_fee") {
      try {
        const settled = await completeThresholdWithdrawal(ref, transactionCode);
        if (settled?.status === "timeout") {
          saveReceipt(ref, {
            status: "timeout",
            status_message: "STK payment timed out after 20 seconds.",
            timestamp: new Date().toISOString()
          });
        } else {
          saveReceipt(ref, {
            status: "success",
            transaction_code: transactionCode,
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error("Threshold withdrawal completion failed:", err.message);
        saveReceipt(ref, {
          status: "error",
          status_message: "Could not complete the withdrawal after payment.",
          timestamp: new Date().toISOString()
        });
      }
    } else {
      const amount = Number(existingReceipt.amount);
      const phone = data.result?.Phone || existingReceipt.phone;
      try {
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE phone = $2',
          [amount, phone]
        );
        await pool.query(
          'INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, $3, $4, $5)',
          [phone, amount, 'deposit', ref, 'success']
        );
        await pool.query(
          'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
          [phone, `Your deposit of KSH ${amount.toFixed(2)} was successful.`]
        );

        // Process the configured lifetime referral commission only after
        // the deposit has been confirmed successfully.
        const userRes = await pool.query(
          'SELECT username, referral_code FROM users WHERE phone = $1',
          [phone]
        );
        if (userRes.rows.length > 0 && userRes.rows[0].referral_code) {
          const referrerUsername = userRes.rows[0].referral_code;
          const commissionSetting = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key = 'referral_commission_percent'"
          );
          const commissionPercent = Math.min(
            100,
            Math.max(0, parseFloat(commissionSetting.rows[0]?.setting_value || '5') || 0)
          );
          const commission = amount * (commissionPercent / 100);
          if (commission <= 0) {
            saveReceipt(ref, {
              status: "success",
              transaction_code: transactionCode,
              phone,
              timestamp: new Date().toISOString()
            });
            return res.json({ ResultCode: 0, ResultDesc: "Callback received" });
          }
          await pool.query(
            'UPDATE users SET balance = balance + $1 WHERE username = $2',
            [commission, referrerUsername]
          );
          const referrerRes = await pool.query(
            'SELECT phone FROM users WHERE username = $1',
            [referrerUsername]
          );
          if (referrerRes.rows.length > 0) {
            const referrerPhone = referrerRes.rows[0].phone;
            await pool.query(
              "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'referral_commission', 'success')",
              [referrerPhone, commission]
            );
            await pool.query(
              "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
              [referrerPhone, `You received KSH ${commission.toFixed(2)} commission from ${userRes.rows[0].username}'s deposit.`]
            );
          }
        }

        saveReceipt(ref, {
          status: "success",
          transaction_code: transactionCode,
          phone,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error("Deposit DB update failed:", err.message);
        saveReceipt(ref, {
          status: "error",
          status_message: "Payment received but balance update failed.",
          timestamp: new Date().toISOString()
        });
      }
    }
  } else {
    const cancelledByUser = resultCode === 1032;
    const timedOut = resultCode === 1037 || resultCode === 1036;
    const status = cancelledByUser
      ? "cancelled_by_user"
      : timedOut
        ? "timeout"
        : "failed";
    const statusMessage = cancelledByUser
      ? "Payment cancelled by user."
      : timedOut
        ? "STK payment timed out after 20 seconds."
        : (data.result?.ResultDesc || "STK payment failed.");

    saveReceipt(ref, {
      status,
      result_code: resultCode,
      status_message: statusMessage,
      timestamp: new Date().toISOString()
    });

    if (existingReceipt.kind === "withdrawal_fee") {
      try {
        const settled = await settleThresholdWithdrawal(
          existingReceipt.request_id,
          status,
          status === "cancelled_by_user"
            ? `Withdrawal cancelled by user. KSH ${Number(existingReceipt.withdraw_amount).toFixed(2)} was refunded.`
            : status === "timeout"
              ? `Threshold payment timed out. KSH ${Number(existingReceipt.withdraw_amount).toFixed(2)} was refunded.`
              : `Threshold payment failed. KSH ${Number(existingReceipt.withdraw_amount).toFixed(2)} was refunded.`
        );
        if (settled?.status && settled.status !== status) {
          saveReceipt(ref, { status: settled.status });
        }
      } catch (err) {
        console.error("Threshold withdrawal settlement failed:", err.message);
      }
    }
  }

  res.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

async function expireReceiptIfNeeded(reference) {
  const receipts = readReceipts();
  const receipt = receipts[reference];
  if (
    receipt &&
    receipt.status === "pending" &&
    receipt.expires_at &&
    new Date(receipt.expires_at).getTime() <= Date.now()
  ) {
    const expiredReceipt = saveReceipt(reference, {
      status: "timeout",
      status_message: "STK payment timed out after 20 seconds.",
      timestamp: new Date().toISOString()
    });
    if (receipt.kind === "withdrawal_fee") {
      try {
        await settleThresholdWithdrawal(
          receipt.request_id,
          "timeout",
          `Threshold payment timed out. KSH ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
        );
      } catch (err) {
        console.error("Threshold receipt timeout settlement failed:", err.message);
      }
    }
    return expiredReceipt;
  }
  return receipt;
}

app.post("/payment-cancel", async (req, res) => {
  const { reference, phone, reason } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone || !reference) {
    return res.status(400).json({ success: false, error: "Invalid payment details" });
  }

  const receipt = readReceipts()[reference];
  if (!receipt || receipt.phone !== formattedPhone) {
    return res.status(404).json({ success: false, error: "Payment not found" });
  }
  if (receipt.status !== "pending") {
    return res.json({
      success: true,
      status: receipt.status,
      message: receipt.status_message || "Payment already settled."
    });
  }

  const status = reason === "timeout" ? "timeout" : "cancelled_by_user";
  const message = status === "timeout"
    ? "STK payment timed out after 20 seconds."
    : "Payment cancelled by user.";
  saveReceipt(reference, {
    status,
    status_message: message,
    timestamp: new Date().toISOString()
  });

  if (receipt.kind === "withdrawal_fee") {
    try {
      await settleThresholdWithdrawal(
        receipt.request_id,
        status,
        status === "cancelled_by_user"
          ? `Withdrawal cancelled by user. KSH ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
          : `Threshold payment timed out. KSH ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
      );
    } catch (err) {
      console.error("Threshold payment cancellation failed:", err.message);
      return res.status(500).json({ success: false, error: "Could not refund the withdrawal" });
    }
  }

  res.json({ success: true, status, message });
});

app.get("/withdrawal-status/:pendingId", async (req, res) => {
  const { pendingId } = req.params;
  const formattedPhone = formatPhone(req.query.phone || "");
  if (!formattedPhone) return res.status(400).json({ success: false, error: "Invalid phone format" });

  try {
    let requestResult = await pool.query(
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND phone = $2",
      [pendingId, formattedPhone]
    );
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }

    let request = requestResult.rows[0];
    if (
      request.status === "awaiting_fee" &&
      new Date(request.expires_at).getTime() <= Date.now()
    ) {
      request = await settleThresholdWithdrawal(
        request.id,
        "timeout",
        `Threshold payment timed out. KSH ${Number(request.amount).toFixed(2)} was refunded.`
      );
      saveReceipt(request.reference, {
        status: "timeout",
        status_message: "STK payment timed out after 20 seconds.",
        timestamp: new Date().toISOString()
      });
    }

    const balanceResult = await pool.query(
      "SELECT balance FROM users WHERE phone = $1",
      [formattedPhone]
    );
    res.json({
      success: true,
      status: request.status,
      balance: parseFloat(balanceResult.rows[0]?.balance || 0),
      pendingId: request.id,
      reference: request.reference,
      fee: parseFloat(request.fee),
      withdrawAmount: parseFloat(request.amount),
      expiresAt: request.expires_at
    });
  } catch (err) {
    console.error("Withdrawal status failed:", err.message);
    res.status(500).json({ success: false, error: "Could not check withdrawal status" });
  }
});

app.post("/cancel-withdrawal", async (req, res) => {
  const { phone, pendingId } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone || !pendingId) {
    return res.status(400).json({ success: false, error: "Invalid withdrawal details" });
  }

  try {
    const requestResult = await pool.query(
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND phone = $2",
      [pendingId, formattedPhone]
    );
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }
    const request = requestResult.rows[0];
    if (request.status !== "awaiting_fee") {
      return res.json({
        success: true,
        status: request.status,
        message: request.status === "cancelled_by_user"
          ? "Withdrawal cancelled by user."
          : `Withdrawal is already ${request.status}.`
      });
    }
    const settled = await settleThresholdWithdrawal(
      request.id,
      "cancelled_by_user",
      `Withdrawal cancelled by user. KSH ${Number(request.amount).toFixed(2)} was refunded.`
    );
    saveReceipt(request.reference, {
      status: "cancelled_by_user",
      status_message: "Payment cancelled by user.",
      timestamp: new Date().toISOString()
    });
    res.json({
      success: true,
      status: "cancelled_by_user",
      balance: settled.balance,
      message: "Withdrawal cancelled by user. Balance refunded."
    });
  } catch (err) {
    console.error("Withdrawal cancellation failed:", err.message);
    res.status(500).json({ success: false, error: "Could not cancel withdrawal" });
  }
});

app.post("/withdrawal-retry-stk", async (req, res) => {
  const { phone, pendingId } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone || !pendingId) {
    return res.status(400).json({ success: false, error: "Invalid withdrawal details" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const requestResult = await client.query(
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND phone = $2 FOR UPDATE",
      [pendingId, formattedPhone]
    );
    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }

    const request = requestResult.rows[0];
    if (request.status !== "awaiting_fee") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: `Withdrawal is already ${request.status}` });
    }
    if (new Date(request.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      await settleThresholdWithdrawal(
        request.id,
        "timeout",
        `Threshold payment timed out. KSH ${Number(request.amount).toFixed(2)} was refunded.`
      );
      return res.status(400).json({ success: false, error: "The 20-second payment window has expired" });
    }

    const newReference = createPaymentReference("WITHDRAWAL-FEE");
    const expiresAt = new Date(Date.now() + 20000);
    await client.query(
      "UPDATE withdrawal_requests SET reference = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi' WHERE id = $3",
      [newReference, expiresAt, request.id]
    );
    await client.query(
      "UPDATE transactions SET reference = $1 WHERE reference = $2 AND type = 'withdrawal' AND status = 'pending'",
      [newReference, request.reference]
    );
    await client.query("COMMIT");
    client.release();
    client = null;

    saveReceipt(request.reference, {
      status: "replaced",
      status_message: "A new STK request was sent.",
      timestamp: new Date().toISOString()
    });
    saveReceipt(newReference, {
      reference: newReference,
      kind: "withdrawal_fee",
      request_id: request.id,
      amount: Number(request.fee),
      withdraw_amount: Number(request.amount),
      phone: formattedPhone,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      timestamp: new Date().toISOString()
    });

    const stk = await initiateStkPayment({
      phone: formattedPhone,
      amount: Number(request.fee),
      reference: newReference
    });
    if (!stk.success) {
      saveReceipt(newReference, {
        status: "stk_failed",
        status_message: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails,
        timestamp: new Date().toISOString()
      });
      await settleThresholdWithdrawal(
        request.id,
        "failed",
        `Threshold payment could not be sent. KSH ${Number(request.amount).toFixed(2)} was refunded.`
      );
      return res.status(stk.status || 502).json({
        success: false,
        error: stk.error,
        provider_status: stk.providerStatus,
        provider_error_code: stk.providerErrorCode,
        provider_details: stk.providerDetails
      });
    }

    res.json({ success: true, reference: newReference, expiresIn: 20 });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    if (client) client.release();
    console.error("STK retry failed:", err.message);
    res.status(500).json({ success: false, error: "Could not resend STK push" });
  }
});

/* =========================
   RECEIPT ROUTES
========================= */

app.get("/receipt/:reference", async (req, res) => {
  const { reference } = req.params;
  const receipt = await expireReceiptIfNeeded(reference);

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

