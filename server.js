require('dotenv').config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({
  verify(req, _res, buf) {
    // Lipila signs the raw JSON bytes, so retain them before JSON parsing.
    req.rawBody = Buffer.from(buf);
  }
}));

function isValidAdminPassword(candidate) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured || typeof candidate !== "string") return false;
  const suppliedBuffer = Buffer.from(candidate);
  const configuredBuffer = Buffer.from(configured);
  return suppliedBuffer.length === configuredBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, configuredBuffer);
}

// The port MUST be exactly what Replit expects or it won't be accessible
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

/* =========================
   DATABASE CONNECTION
========================= */

// Prefer DATABASE_URL so Render uses the configured Neon connection.
// The other names are retained only as fallbacks for older deployments.
const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.RAILWAY_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Missing database connection string. Set DATABASE_URL."
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
      console.log("✅ Connected to PostgreSQL");
      await client.query("SET TIMEZONE='Africa/Lusaka'");
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);
      await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS lipila_reference_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS lipila_identifier VARCHAR(100)
      `);

      // 4. Threshold Withdrawal Requests
      await pool.query(`
        CREATE TABLE IF NOT EXISTS withdrawal_requests (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            fee DECIMAL(15, 2) NOT NULL,
            reference VARCHAR(100) UNIQUE NOT NULL,
            fee_reference VARCHAR(100),
            status VARCHAR(30) NOT NULL DEFAULT 'awaiting_fee',
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka'),
            updated_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka'),
            expires_at TIMESTAMP NOT NULL
        );
      `);
      await pool.query(`
        ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS fee_reference VARCHAR(100),
        ADD COLUMN IF NOT EXISTS fee_lipila_reference_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS fee_lipila_identifier VARCHAR(100)
      `);

      // 4. Notifications Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);

      // 7. Chat Likes Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_likes (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
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
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);

      // 9. Cashrain Claims Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cashrain_claims (
            id SERIAL PRIMARY KEY,
            cashrain_id INTEGER NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
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
          ('threshold_mode', 'disabled'),
          ('minimum_deposit', '100'),
          ('minimum_bet', '10'),
          ('minimum_withdrawal', '500')
        ON CONFLICT (setting_key) DO NOTHING;
      `);

      // Aviator Predictor premium access and admin-controlled signal settings.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS predictor_plans (
            plan_key VARCHAR(30) PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            price_ksh DECIMAL(15,2) NOT NULL,
            duration_days INTEGER NOT NULL,
            features JSONB NOT NULL DEFAULT '[]'::jsonb,
            active BOOLEAN DEFAULT TRUE,
            updated_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);
      await pool.query(`
        ALTER TABLE predictor_plans
        ADD COLUMN IF NOT EXISTS popup_notifications BOOLEAN NOT NULL DEFAULT TRUE
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS predictor_subscriptions (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            plan_key VARCHAR(30) NOT NULL,
            amount_ksh DECIMAL(15,2) NOT NULL,
            starts_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka'),
            expires_at TIMESTAMP NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS predictor_access_logs (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            plan_key VARCHAR(30),
            action VARCHAR(30) NOT NULL DEFAULT 'open',
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka')
        );
      `);
      await pool.query(`
        INSERT INTO predictor_plans (plan_key, name, price_ksh, duration_days, features)
        VALUES
          ('starter', 'Starter Signal', 100, 1, '["Live signal feed","Basic trend read","Round history","1-day access"]'::jsonb),
          ('pro', 'Pro Flight Desk', 200, 7, '["Everything in Starter","Confidence meter","Auto-refresh signals","Conservative exit bands","7-day access"]'::jsonb),
          ('elite', 'Elite Analytics', 500, 30, '["Everything in Pro","Advanced trend profiles","Session analytics","Extended history","30-day access"]'::jsonb),
          ('apex', 'Apex Command', 1000, 90, '["Everything in Elite","Custom risk controls","Priority signal updates","Admin notes","90-day access"]'::jsonb)
        ON CONFLICT (plan_key) DO NOTHING;
      `);
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value) VALUES
          ('predictor_enabled', 'true'),
          ('predictor_mode', 'auto'),
          ('predictor_demo_mode', 'true'),
          ('predictor_manual_signal', 'WATCH'),
          ('predictor_manual_target', '2.00'),
          ('predictor_manual_confidence', '72'),
          ('predictor_target_offset', '0.41'),
          ('predictor_success_message', 'Target match recorded from recent round history.'),
          ('predictor_note', 'Signals are analytical estimates, not guaranteed outcomes.')
        ON CONFLICT (setting_key) DO NOTHING;
      `);

    } catch(e) {
      console.error("Error setting up DB schema:", e);
    }
  }
  setupChatDB();

  const WALLET_LIMIT_KEYS = ['minimum_deposit', 'minimum_bet', 'minimum_withdrawal'];
  const WALLET_LIMIT_DEFAULTS = {
    minimum_deposit: 100,
    minimum_bet: 10,
    minimum_withdrawal: 500
  };

  async function getWalletLimits() {
    const result = await pool.query(
      'SELECT setting_key, setting_value FROM settings WHERE setting_key = ANY($1::text[])',
      [WALLET_LIMIT_KEYS]
    );
    const saved = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
    return Object.fromEntries(WALLET_LIMIT_KEYS.map(key => {
      const value = Number(saved[key]);
      return [key, Number.isFinite(value) && value >= 1 ? value : WALLET_LIMIT_DEFAULTS[key]];
    }));
  }

  app.get('/api/wallet-limits', async (_req, res) => {
    try {
      res.json({ success: true, currency: 'ZMW', limits: await getWalletLimits() });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Could not load wallet limits' });
    }
  });

  app.get('/admin/wallet-limits', async (req, res) => {
    if (!isValidAdminPassword(req.headers.authorization)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
      res.json({ success: true, currency: 'ZMW', limits: await getWalletLimits() });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Could not load wallet limits' });
    }
  });

  app.post('/admin/wallet-limits', async (req, res) => {
    if (!isValidAdminPassword(req.headers.authorization)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const limits = {};
    for (const key of WALLET_LIMIT_KEYS) {
      const value = Number(req.body?.[key]);
      if (!Number.isFinite(value) || value < 1 || value > 10000000) {
        return res.status(400).json({
          success: false,
          error: 'Each minimum must be between ZMW 1 and ZMW 10,000,000.'
        });
      }
      limits[key] = value;
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      for (const key of WALLET_LIMIT_KEYS) {
        await client.query(
          `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
          [key, String(limits[key])]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true, limits: await getWalletLimits() });
    } catch (e) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      res.status(500).json({ success: false, error: 'Could not save wallet limits' });
    } finally {
      if (client) client.release();
    }
  });

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

  const spamRegex = /(?:0[79]\d{8}|260[79]\d{8}|\+260[79]\d{8})/;

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
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^[79]\d{8}$/.test(digits)) return "260" + digits;
  if (/^0[79]\d{8}$/.test(digits)) return "260" + digits.substring(1);
  if (/^260[79]\d{8}$/.test(digits)) return digits;
  return null;
}

function calculateThresholdFee(amount) {
  const withdrawalAmount = Number(amount);
  if (!Number.isFinite(withdrawalAmount) || withdrawalAmount < 500) return 0;

  // Fee schedule: 500 => 100, 600 => 150, 700 => 200,
  // 1000 => 350, 2000 => 850. Amounts between listed tiers use
  // the lower tier until the next ZMW 100 boundary.
  return 100 + Math.floor((withdrawalAmount - 500) / 100) * 50;
}

function createPaymentReference(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
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

const LIPILA_CURRENCY = "ZMW";

function getLipilaError(err, responseData = err?.response?.data) {
  return {
    status: err?.response?.status || null,
    message:
      responseData?.message ||
      responseData?.error ||
      err?.message ||
      "Lipila could not process the request."
  };
}

function lipilaData(responseData) {
  if (responseData?.data && typeof responseData.data === "object") {
    return responseData.data;
  }
  return responseData || {};
}

async function lipilaRequest(method, endpoint, { body, referenceId } = {}) {
  const apiKey = process.env.LIPILA_API_KEY;
  const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
  const apiBaseUrl = (process.env.LIPILA_API_BASE_URL || "https://api.lipila.dev")
    .replace(/\/$/, "");
  if (!apiKey) {
    return { success: false, status: 503, error: "Set LIPILA_API_KEY in the server environment." };
  }
  if (!baseUrl) {
    return { success: false, status: 503, error: "Set BASE_URL to the public server URL for Lipila callbacks." };
  }

  try {
    const response = await axios({
      method,
      url: `${apiBaseUrl}${endpoint}`,
      params: referenceId ? { referenceId } : undefined,
      data: body,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        callbackUrl: `${baseUrl}/callback`
      },
      timeout: 20000
    });
    return {
      success: true,
      status: response.status,
      data: lipilaData(response.data),
      rawData: response.data
    };
  } catch (err) {
    const provider = getLipilaError(err);
    const providerStatus = provider.status;
    return {
      success: false,
      status: providerStatus || 502,
      providerStatus,
      error: provider.message,
      providerData: lipilaData(err?.response?.data),
      // A timeout or server-side error can happen after Lipila accepted the request.
      outcomeUnknown: !providerStatus || providerStatus >= 500
    };
  }
}

function lipilaPaymentBody({ phone, amount, reference, narration }) {
  return {
    referenceId: reference,
    amount: Math.round(Number(amount) * 100) / 100,
    narration,
    accountNumber: phone,
    currency: LIPILA_CURRENCY,
    referenceData: reference
  };
}

async function initiateLipilaCollection({ phone, amount, reference, email, narration }) {
  const body = lipilaPaymentBody({
    phone,
    amount,
    reference,
    narration: narration || "Aviator wallet deposit"
  });
  if (email) body.email = email;
  return lipilaRequest("POST", "/api/v1/collections/mobile-money", { body });
}

async function initiateLipilaDisbursement({ phone, amount, reference }) {
  const body = lipilaPaymentBody({
    phone,
    amount,
    reference,
    narration: "Aviator wallet withdrawal"
  });
  return lipilaRequest("POST", "/api/v1/disbursements/mobile-money", { body });
}

async function checkLipilaStatus(kind, reference) {
  const isWithdrawal = kind === "withdrawal";
  const endpoint = isWithdrawal
    ? "/api/v1/disbursements/check-status"
    : "/api/v1/collections/check-status";
  return lipilaRequest("GET", endpoint, { referenceId: reference });
}

function verifyLipilaWebhook(req) {
  const secret = process.env.LIPILA_WEBHOOK_SECRET;
  const webhookId = req.get("webhook-id");
  const timestamp = req.get("webhook-timestamp");
  const signatureHeader = req.get("webhook-signature");
  const timestampSeconds = Number(timestamp);
  if (!secret || !webhookId || !timestamp || !signatureHeader || !req.rawBody) {
    return false;
  }
  if (!Number.isFinite(timestampSeconds) ||
      Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false;
  }

  let signingKey;
  try {
    signingKey = Buffer.from(secret, "base64");
  } catch (_) {
    return false;
  }
  if (signingKey.length !== 32) return false;

  const signedPayload = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`, "utf8"),
    req.rawBody
  ]);
  const expected = `v1,${crypto.createHmac("sha256", signingKey)
    .update(signedPayload)
    .digest("base64")}`;
  return signatureHeader.split(/\s+/).some(signature => {
    const received = Buffer.from(signature.trim());
    const expectedBuffer = Buffer.from(expected);
    return received.length === expectedBuffer.length &&
      crypto.timingSafeEqual(received, expectedBuffer);
  });
}

async function settleLipilaDeposit(reference, finalStatus, providerData) {
  let client;
  try {
    const receipt = await getLipilaReceipt(reference);
    if (!receipt || receipt.kind !== "deposit") return null;
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [reference]);
    let transaction = await client.query(
      "SELECT id, status FROM transactions WHERE reference = $1 AND type = 'deposit' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [reference]
    );
    if (transaction.rows.length === 0) {
      transaction = await client.query(
        "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'deposit', $3, 'pending') RETURNING id, status",
        [receipt.phone, receipt.amount, reference]
      );
    }
    if (transaction.rows[0].status !== "pending") {
      await client.query("COMMIT");
      return { status: transaction.rows[0].status, duplicate: true };
    }

    if (finalStatus === "failed") {
      await client.query(
        "UPDATE transactions SET status = 'failed' WHERE id = $1",
        [transaction.rows[0].id]
      );
      await client.query("COMMIT");
      return { status: "failed" };
    }

    const user = await client.query(
      "SELECT username, referral_code FROM users WHERE phone = $1 FOR UPDATE",
      [receipt.phone]
    );
    if (user.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: "pending", error: "Wallet account was not found." };
    }
    const amount = Number(receipt.amount);
    await client.query(
      "UPDATE users SET balance = balance + $1 WHERE phone = $2",
      [amount, receipt.phone]
    );
    await client.query(
      "UPDATE transactions SET status = 'success' WHERE id = $1",
      [transaction.rows[0].id]
    );
    await client.query(
      "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
      [receipt.phone, `Your ZMW ${amount.toFixed(2)} deposit was successful.`]
    );

    if (user.rows[0].referral_code) {
      const commissionSetting = await client.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'referral_commission_percent'"
      );
      const commissionPercent = Math.min(
        100,
        Math.max(0, parseFloat(commissionSetting.rows[0]?.setting_value || "5") || 0)
      );
      const commission = amount * (commissionPercent / 100);
      if (commission > 0) {
        const referrer = await client.query(
          "SELECT phone FROM users WHERE username = $1 FOR UPDATE",
          [user.rows[0].referral_code]
        );
        if (referrer.rows.length > 0) {
          await client.query(
            "UPDATE users SET balance = balance + $1 WHERE phone = $2",
            [commission, referrer.rows[0].phone]
          );
          await client.query(
            "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'referral_commission', $3, 'success')",
            [referrer.rows[0].phone, commission, reference]
          );
          await client.query(
            "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
            [referrer.rows[0].phone, `You received ZMW ${commission.toFixed(2)} commission from ${user.rows[0].username}'s deposit.`]
          );
        }
      }
    }
    await client.query("COMMIT");
    return { status: "success", transactionCode: providerData?.externalId || null };
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function settleLipilaWithdrawal(reference, finalStatus, providerData) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const requestResult = await client.query(
      "SELECT * FROM withdrawal_requests WHERE reference = $1 FOR UPDATE",
      [reference]
    );
    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const request = requestResult.rows[0];
    if (!["pending", "payout_pending"].includes(request.status)) {
      await client.query("COMMIT");
      return { ...request, duplicate: true };
    }

    if (finalStatus === "failed") {
      let feeRefund = 0;
      if (request.fee_reference && Number(request.fee) > 0) {
        const feePaid = await client.query(
          "SELECT 1 FROM transactions WHERE reference = $1 AND type = 'withdrawal_fee' AND status = 'success' LIMIT 1",
          [request.fee_reference]
        );
        const feeAlreadyRefunded = await client.query(
          "SELECT 1 FROM transactions WHERE reference = $1 AND type = 'withdrawal_fee_refund' LIMIT 1",
          [request.fee_reference]
        );
        if (feePaid.rows.length > 0 && feeAlreadyRefunded.rows.length === 0) {
          feeRefund = Number(request.fee);
        }
      }
      await client.query(
        "UPDATE users SET balance = balance + $1 WHERE phone = $2",
        [Number(request.amount) + feeRefund, request.phone]
      );
      await client.query(
        "UPDATE transactions SET status = 'failed' WHERE reference = $1 AND type = 'withdrawal' AND status = 'pending'",
        [reference]
      );
      if (feeRefund > 0) {
        await client.query(
          "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal_fee_refund', $3, 'success')",
          [request.phone, feeRefund, request.fee_reference]
        );
      }
      await client.query(
        "UPDATE withdrawal_requests SET status = 'failed', updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka' WHERE id = $1",
        [request.id]
      );
      await client.query(
        "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
        [request.phone, feeRefund > 0
          ? `Your ZMW ${Number(request.amount).toFixed(2)} withdrawal failed. The withdrawal amount and ZMW ${feeRefund.toFixed(2)} threshold fee were returned to your wallet.`
          : `Your ZMW ${Number(request.amount).toFixed(2)} withdrawal failed and was returned to your wallet.`]
      );
      await client.query("COMMIT");
      return { ...request, status: "failed", refundedFee: feeRefund };
    }

    await client.query(
      "UPDATE transactions SET status = 'success' WHERE reference = $1 AND type = 'withdrawal' AND status = 'pending'",
      [reference]
    );
    await client.query(
      "UPDATE withdrawal_requests SET status = 'success', updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka' WHERE id = $1",
      [request.id]
    );
    await client.query(
      "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
      [request.phone, `Your ZMW ${Number(request.amount).toFixed(2)} withdrawal was sent successfully.`]
    );
    await client.query("COMMIT");
    return { ...request, status: "success", transactionCode: providerData?.externalId || null };
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function getLipilaReceipt(reference) {
  const storedReceipt = readReceipts()[reference];
  if (storedReceipt) return storedReceipt;
  const transactionResult = await pool.query(
    "SELECT phone, amount, type, status FROM transactions WHERE reference = $1 AND type IN ('deposit', 'withdrawal') ORDER BY id DESC LIMIT 1",
    [reference]
  );
  const transaction = transactionResult.rows[0];
  if (!transaction) {
    const feeRequestResult = await pool.query(
      "SELECT id, phone, amount, fee, fee_reference, fee_lipila_reference_id, fee_lipila_identifier FROM withdrawal_requests WHERE fee_reference = $1 LIMIT 1",
      [reference]
    );
    const feeRequest = feeRequestResult.rows[0];
    if (!feeRequest) return null;
    return {
      reference: feeRequest.fee_reference,
      kind: "withdrawal_fee",
      request_id: feeRequest.id,
      phone: feeRequest.phone,
      amount: Number(feeRequest.fee),
      withdraw_amount: Number(feeRequest.amount),
      status: "pending",
      provider: "lipila",
      currency: LIPILA_CURRENCY,
      lipila_reference_id: feeRequest.fee_lipila_reference_id,
      lipila_identifier: feeRequest.fee_lipila_identifier
    };
  }
  return {
    reference,
    kind: transaction.type,
    phone: transaction.phone,
    amount: Number(transaction.amount),
    status: transaction.status,
    provider: "lipila",
    currency: LIPILA_CURRENCY
  };
}

async function saveLipilaProviderReferences(reference, providerData) {
  await pool.query(
    "UPDATE transactions SET lipila_reference_id = $1, lipila_identifier = $2 WHERE reference = $3 AND type IN ('deposit', 'withdrawal')",
    [providerData?.referenceId || null, providerData?.identifier || null, reference]
  );
}

async function resolveLipilaReference(data) {
  const receipts = readReceipts();
  const possibleReferences = [
    data?.referenceData,
    data?.identifier,
    data?.referenceId,
    data?.externalReference
  ].filter(value => typeof value === "string" && value.length > 0);
  const directMatch = possibleReferences.find(reference => receipts[reference]);
  if (directMatch) return directMatch;
  const localMatch = Object.keys(receipts).find(reference =>
    possibleReferences.includes(receipts[reference]?.lipila_reference_id) ||
    possibleReferences.includes(receipts[reference]?.lipila_identifier)
  );
  if (localMatch) return localMatch;
  const databaseMatch = await pool.query(
    `SELECT reference FROM transactions
     WHERE reference = ANY($1::text[])
        OR lipila_reference_id = ANY($1::text[])
        OR lipila_identifier = ANY($1::text[])
     ORDER BY id DESC
     LIMIT 1`,
    [possibleReferences]
  );
  if (databaseMatch.rows[0]?.reference) return databaseMatch.rows[0].reference;
  const feeRequestMatch = await pool.query(
    `SELECT fee_reference AS reference FROM withdrawal_requests
     WHERE fee_reference = ANY($1::text[])
        OR fee_lipila_reference_id = ANY($1::text[])
        OR fee_lipila_identifier = ANY($1::text[])
     ORDER BY id DESC
     LIMIT 1`,
    [possibleReferences]
  );
  return feeRequestMatch.rows[0]?.reference || null;
}

async function applyLipilaFinalStatus(reference, providerData) {
  const receipt = await getLipilaReceipt(reference);
  if (!receipt) return { success: false, status: "not_found" };
  if (!["deposit", "withdrawal", "withdrawal_fee"].includes(receipt.kind)) {
    return { success: false, status: "unsupported" };
  }
  const normalizedStatus = String(providerData?.status || "").toLowerCase();
  if (normalizedStatus !== "successful" && normalizedStatus !== "failed") {
    return { success: true, status: "pending" };
  }
  const providerAmount = Number(providerData.amount);
  const expectedAmount = Number(receipt.amount);
  const providerPhone = providerData.accountNumber
    ? formatPhone(providerData.accountNumber)
    : null;
  if (
    String(providerData.currency || "").toUpperCase() !== LIPILA_CURRENCY ||
    !Number.isFinite(providerAmount) ||
    Math.abs(providerAmount - expectedAmount) > 0.009 ||
    (providerPhone && providerPhone !== receipt.phone)
  ) {
    console.error("Lipila status did not match the stored payment details:", reference);
    return { success: false, status: "pending", error: "Provider payment details did not match." };
  }

  const finalStatus = normalizedStatus === "successful" ? "success" : "failed";
  if (receipt.kind === "withdrawal_fee") {
    const feeSettlement = finalStatus === "success"
      ? await completeThresholdWithdrawal(reference, providerData.externalId || null)
      : await settleThresholdWithdrawal(
          receipt.request_id,
          "failed",
          `Threshold payment failed. ZMW ${Number(receipt.withdraw_amount || 0).toFixed(2)} was returned to your wallet.`
        );
    saveReceipt(reference, {
      status: finalStatus,
      status_message: providerData.message || null,
      transaction_code: providerData.externalId || null,
      lipila_status: providerData.status,
      timestamp: new Date().toISOString()
    });
    return {
      success: true,
      status: feeSettlement?.status || finalStatus
    };
  }

  const settlement = receipt.kind === "withdrawal"
    ? await settleLipilaWithdrawal(reference, finalStatus, providerData)
    : await settleLipilaDeposit(reference, finalStatus, providerData);
  if (!settlement) return { success: false, status: "not_found" };
  const settledStatus = settlement.status || finalStatus;
  saveReceipt(reference, {
    status: settledStatus,
    status_message: providerData.message || null,
    transaction_code: providerData.externalId || null,
    lipila_status: providerData.status,
    timestamp: new Date().toISOString()
  });
  return { success: true, status: settledStatus };
}

async function refreshLipilaStatus(reference) {
  const receipt = await getLipilaReceipt(reference);
  if (!receipt) return { success: false, status: "not_found" };
  if (receipt.status !== "pending") return { success: true, status: receipt.status };
  const result = await checkLipilaStatus(receipt.kind, reference);
  if (!result.success) {
    return { success: false, status: "pending", error: result.error };
  }
  const final = await applyLipilaFinalStatus(reference, result.data);
  if (final.status === "pending" && result.data?.status) {
    saveReceipt(reference, { lipila_status: result.data.status });
  }
  return final;
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
      'UPDATE withdrawal_requests SET status = $1, updated_at = CURRENT_TIMESTAMP AT TIME ZONE \'Africa/Lusaka\' WHERE id = $2',
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
  let request;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const requestResult = await client.query(
      'SELECT * FROM withdrawal_requests WHERE fee_reference = $1 OR (fee_reference IS NULL AND reference = $1) LIMIT 1 FOR UPDATE',
      [reference]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    request = requestResult.rows[0];
    if (request.status !== 'awaiting_fee') {
      const feeRefunded = await client.query(
        "SELECT 1 FROM transactions WHERE reference = $1 AND type = 'withdrawal_fee_refund' LIMIT 1",
        [reference]
      );
      if (['failed', 'timeout', 'cancelled_by_user'].includes(request.status) &&
          feeRefunded.rows.length === 0 &&
          Number(request.fee) > 0) {
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE phone = $2',
          [request.fee, request.phone]
        );
        await client.query(
          "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal_fee_refund', $3, 'success')",
          [request.phone, request.fee, reference]
        );
        await client.query(
          'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
          [request.phone, `A late ZMW ${Number(request.fee).toFixed(2)} threshold payment was returned to your wallet because the withdrawal had already ended.`]
        );
        await client.query('COMMIT');
        return { ...request, feeRefunded: true, duplicate: true };
      }
      await client.query('COMMIT');
      return { ...request, duplicate: true };
    }

    await client.query(
      "UPDATE withdrawal_requests SET status = 'payout_pending', updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka' WHERE id = $1",
      [request.id]
    );
    const existingFeeTransaction = await client.query(
      "SELECT 1 FROM transactions WHERE reference = $1 AND type = 'withdrawal_fee' AND status = 'success' LIMIT 1",
      [reference]
    );
    if (existingFeeTransaction.rows.length === 0) {
      await client.query(
        "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal_fee', $3, 'success')",
        [request.phone, request.fee, reference]
      );
    }
    await client.query(
      'INSERT INTO notifications (phone, message) VALUES ($1, $2)',
      [request.phone, `Threshold fee of ZMW ${Number(request.fee).toFixed(2)} paid. Lipila is processing your ZMW ${Number(request.amount).toFixed(2)} withdrawal.`]
    );
    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) client.release();
  }

  const payoutReference = request.reference;
  saveReceipt(payoutReference, {
    reference: payoutReference,
    kind: 'withdrawal',
    request_id: request.id,
    amount: Number(request.amount),
    phone: request.phone,
    status: 'pending',
    provider: 'lipila',
    currency: LIPILA_CURRENCY,
    timestamp: new Date().toISOString()
  });

  const payout = await initiateLipilaDisbursement({
    phone: request.phone,
    amount: Number(request.amount),
    reference: payoutReference
  });
  if (!payout.success) {
    if (!payout.outcomeUnknown) {
      saveReceipt(payoutReference, {
        status: 'failed',
        status_message: payout.error,
        provider_status: payout.providerStatus || payout.status || null,
        timestamp: new Date().toISOString()
      });
      await settleLipilaWithdrawal(payoutReference, 'failed', {});
      return { ...request, status: 'failed', error: payout.error };
    }
    saveReceipt(payoutReference, {
      lipila_status: 'Submission status unknown',
      status_message: 'The payout may have reached Lipila; its status is being checked.',
      timestamp: new Date().toISOString()
    });
    return { ...request, status: 'pending', outcomeUnknown: true };
  }

  const payoutData = payout.data || {};
  await saveLipilaProviderReferences(payoutReference, payoutData);
  saveReceipt(payoutReference, {
    lipila_reference_id: payoutData.referenceId || null,
    lipila_identifier: payoutData.identifier || null,
    lipila_status: payoutData.status || 'Pending',
    fee_transaction_code: transactionCode || null
  });
  if (['successful', 'failed'].includes(String(payoutData.status || '').toLowerCase())) {
    const payoutSettlement = await applyLipilaFinalStatus(payoutReference, payoutData);
    return { ...request, status: payoutSettlement.status };
  }
  return { ...request, status: 'pending' };
}


  /* =========================
     CHAT ROUTES
  ========================= */

  app.get('/chat/messages', async (req, res) => {
    try {
      const viewerPhone = formatPhone(req.query.phone || '');
      const viewerIsAdmin =
        req.query.admin === 'true' &&
        isValidAdminPassword(req.headers.authorization);
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
      await pool.query("DELETE FROM chats WHERE created_at < CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka' - INTERVAL '48 hours'");
      
      // Fetch last 150 messages
      const msgs = await pool.query(`
        SELECT c.*, cr.amount, cr.max_claims, cr.current_claims,
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lusaka' - cr.created_at)) as cr_seconds_passed,
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
        return res.status(403).json({ error: 'Chat access is restricted for players with balance below 50 ZMW' });
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
    if (isAdmin && isValidAdminPassword(req.headers.authorization)) {
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
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  
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
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  if (gameStatus === 'RUNNING') {
    currentCrashPoint = currentMultiplier; 
    res.json({ success: true, message: "Crash triggered immediately" });
  } else {
    res.status(400).json({ error: "Game is not currently running" });
  }
});

app.post('/admin/delete-transaction', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  
  const { transactionId } = req.body;
  try {
    await pool.query("DELETE FROM transactions WHERE id = $1", [transactionId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.post('/admin/update-user', async (req, res) => {
  const adminPwd = req.headers.authorization;
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  
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
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  
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
  if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
  
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
        return res.status(403).json({error: `You need a balance of ${r.min_balance} ZMW to claim`});
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
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
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
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
    const { chatId } = req.body;
    try {
      await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);
      await pool.query("DELETE FROM cashrains WHERE chat_id = $1", [chatId]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/toggle-lock', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
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
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
    const { username } = req.body;
    try {
      const r = await pool.query("UPDATE users SET chat_status = 'suspended' WHERE username = $1 RETURNING id", [username]);
      if(r.rows.length === 0) return res.status(404).json({error: 'User not found'});
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/unsuspend-user', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
    const { username } = req.body;
    try {
      const r = await pool.query("UPDATE users SET chat_status = 'active' WHERE username = $1 RETURNING id", [username]);
      if(r.rows.length === 0) return res.status(404).json({error: 'User not found'});
      res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.get('/admin/chat/suspended-users', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
    try {
      const r = await pool.query("SELECT username FROM users WHERE chat_status = 'suspended'");
      res.json({ success: true, users: r.rows.map(row => row.username) });
    } catch(e) { res.status(500).json({error: 'Server error'}); }
  });

  app.post('/admin/chat/reply-by-username', async (req, res) => {
    const adminPwd = req.headers.authorization;
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
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
    if (!isValidAdminPassword(adminPwd)) return res.status(403).json({ error: "Unauthorized" });
    
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
        [formattedPhone, `Welcome bonus of ZMW ${signupBonus.toFixed(2)} credited to your balance.`]
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
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received ZMW ${referralReward.toFixed(2)} for referring ${username}.`]);
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
    res.json({ success: true, currency: 'ZMW', transactions: tx.rows });
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
    const betAmount = Number(amount);
    const limits = await getWalletLimits();
    if (!Number.isFinite(betAmount) || betAmount < limits.minimum_bet) {
      return res.status(400).json({ error: `Minimum bet is ZMW ${limits.minimum_bet}` });
    }
    const user = await pool.query(
      'SELECT username, balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (user.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });

    let currentBalance = parseFloat(user.rows[0].balance);

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

    res.json({
      success: true,
      balance: currentBalance,
      betId,
      status: 'pending',
      pending: true,
      nextRound: true,
      message: 'Bet accepted and queued for the next round'
    });

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
  const withdrawAmount = Math.round(Number(amount) * 100) / 100;
  if (!formattedPhone) {
    return res.status(400).json({ success: false, error: 'Use a valid Zambia mobile number.' });
  }

  let client;
  let withdrawalRequest;
  try {
    const limits = await getWalletLimits();
    if (!Number.isFinite(withdrawAmount) || withdrawAmount < limits.minimum_withdrawal) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ZMW ${limits.minimum_withdrawal}` });
    }
    const thresholdResult = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'threshold_mode'"
    );
    const thresholdEnabled = thresholdResult.rows[0]?.setting_value === 'enabled';
    const thresholdFee = thresholdEnabled ? calculateThresholdFee(withdrawAmount) : 0;
    const feeReference = thresholdFee > 0
      ? createPaymentReference('ZMW-WITHDRAWAL-FEE')
      : null;
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

    if (parseFloat(user.rows[0].balance) < withdrawAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Insufficient balance for withdrawal'
      });
    }

    const reference = createPaymentReference('ZMW-WITHDRAWAL');
    const expiresAt = thresholdFee > 0
      ? new Date(Date.now() + 20 * 1000)
      : new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE phone = $2',
      [withdrawAmount, formattedPhone]
    );
    await client.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'withdrawal', $3, 'pending')",
      [formattedPhone, withdrawAmount, reference]
    );
    const requestResult = await client.query(
      "INSERT INTO withdrawal_requests (phone, amount, fee, reference, fee_reference, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [
        formattedPhone,
        withdrawAmount,
        thresholdFee,
        reference,
        feeReference,
        thresholdFee > 0 ? 'awaiting_fee' : 'pending',
        expiresAt
      ]
    );
    withdrawalRequest = requestResult.rows[0];
    await client.query('COMMIT');

    const updatedUser = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (thresholdFee > 0 && feeReference) {
      saveReceipt(feeReference, {
        reference: feeReference,
        kind: 'withdrawal_fee',
        request_id: withdrawalRequest.id,
        amount: thresholdFee,
        withdraw_amount: withdrawAmount,
        phone: formattedPhone,
        status: 'pending',
        provider: 'lipila',
        currency: LIPILA_CURRENCY,
        expires_at: expiresAt.toISOString(),
        timestamp: new Date().toISOString()
      });

      const feeCollection = await initiateLipilaCollection({
        phone: formattedPhone,
        amount: thresholdFee,
        reference: feeReference,
        narration: "JetX withdrawal threshold fee"
      });
      if (!feeCollection.success && !feeCollection.outcomeUnknown) {
        await settleThresholdWithdrawal(
          withdrawalRequest.id,
          'failed',
          `Threshold payment could not be started. ZMW ${withdrawAmount.toFixed(2)} was returned to your wallet.`
        );
        saveReceipt(feeReference, {
          status: 'failed',
          status_message: feeCollection.error,
          provider_status: feeCollection.providerStatus || feeCollection.status || null,
          timestamp: new Date().toISOString()
        });
        const refundedUser = await pool.query(
          'SELECT balance FROM users WHERE phone = $1',
          [formattedPhone]
        );
        return res.status(502).json({
          success: false,
          error: feeCollection.error,
          provider_status: feeCollection.providerStatus || feeCollection.status || null,
          balance: parseFloat(refundedUser.rows[0]?.balance || 0)
        });
      }

      if (feeCollection.success) {
        const feeData = feeCollection.data || {};
        await pool.query(
          'UPDATE withdrawal_requests SET fee_lipila_reference_id = $1, fee_lipila_identifier = $2 WHERE id = $3',
          [feeData.referenceId || null, feeData.identifier || null, withdrawalRequest.id]
        );
        saveReceipt(feeReference, {
          lipila_reference_id: feeData.referenceId || null,
          lipila_identifier: feeData.identifier || null,
          lipila_status: feeData.status || 'Pending'
        });
        if (['successful', 'failed'].includes(String(feeData.status || '').toLowerCase())) {
          await applyLipilaFinalStatus(feeReference, feeData);
        }
      } else {
        saveReceipt(feeReference, {
          lipila_status: 'Submission status unknown',
          status_message: 'The fee prompt may have reached Lipila; its status is being checked.',
          timestamp: new Date().toISOString()
        });
      }

      return res.status(202).json({
        success: true,
        pending: true,
        status: 'awaiting_fee',
        threshold: true,
        stkSent: true,
        balance: parseFloat(updatedUser.rows[0]?.balance || 0),
        pendingId: withdrawalRequest.id,
        reference: feeReference,
        currency: LIPILA_CURRENCY,
        fee: thresholdFee,
        withdrawAmount,
        totalDebited: withdrawAmount,
        expiresIn: 20,
        provider: 'Lipila',
        message: feeCollection.outcomeUnknown
          ? 'The threshold payment status is being checked. Do not submit another withdrawal yet.'
          : 'Approve the threshold fee request on your phone. The withdrawal is sent after the fee is confirmed.'
      });
    }

    saveReceipt(reference, {
      reference,
      kind: 'withdrawal',
      request_id: withdrawalRequest.id,
      amount: withdrawAmount,
      phone: formattedPhone,
      status: 'pending',
      provider: 'lipila',
      currency: LIPILA_CURRENCY,
      timestamp: new Date().toISOString()
    });

    const payout = await initiateLipilaDisbursement({
      phone: formattedPhone,
      amount: withdrawAmount,
      reference
    });
    if (!payout.success) {
      if (!payout.outcomeUnknown) {
        await settleLipilaWithdrawal(reference, 'failed', {});
        saveReceipt(reference, {
          status: 'failed',
          status_message: payout.error,
          timestamp: new Date().toISOString()
        });
        return res.status(502).json({
          success: false,
          error: payout.error,
          provider_status: payout.providerStatus || payout.status || null
        });
      }
      saveReceipt(reference, {
        lipila_status: 'Submission status unknown',
        status_message: 'The payout request may have reached Lipila; the balance remains reserved while status is checked.',
        timestamp: new Date().toISOString()
      });
      return res.status(202).json({
        success: true,
        pending: true,
        status: 'pending',
        balance: parseFloat(updatedUser.rows[0].balance),
        pendingId: withdrawalRequest.id,
        reference,
        currency: LIPILA_CURRENCY,
        withdrawAmount,
        totalDebited: withdrawAmount,
        provider: 'Lipila',
        message: 'Payout status is being checked. The reserved balance will be returned if Lipila reports a failure.'
      });
    }

    const providerData = payout.data || {};
    await saveLipilaProviderReferences(reference, providerData);
    saveReceipt(reference, {
      lipila_reference_id: providerData.referenceId || null,
      lipila_identifier: providerData.identifier || null,
      lipila_status: providerData.status || 'Pending'
    });
    let settlement = { status: 'pending' };
    if (['successful', 'failed'].includes(String(providerData.status || '').toLowerCase())) {
      settlement = await applyLipilaFinalStatus(reference, providerData);
    }

    const currentUser = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );
    const responseStatus = settlement.status || 'pending';
    res.status(responseStatus === 'pending' ? 202 : 200).json({
      success: responseStatus !== 'failed',
      pending: responseStatus === 'pending',
      status: responseStatus,
      balance: parseFloat(currentUser.rows[0]?.balance || 0),
      currency: LIPILA_CURRENCY,
      threshold: false,
      fee: 0,
      withdrawAmount,
      totalDebited: withdrawAmount,
      pendingId: withdrawalRequest.id,
      reference,
      payoutRequested: true,
      provider: 'Lipila',
      message: providerData.message || undefined
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
  if (!isValidAdminPassword(password)) {
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });

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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
          [row.phone, `Bonus balance of ZMW ${amount.toFixed(2)} was removed by the administrator.`]
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, activeUsers: clients.length });
});


/* =========================
   ADMIN ADDITIONAL ROUTES
========================= */
app.post('/admin/set-odds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
  try {
    const users = await pool.query("SELECT id, username, phone, pin, balance, status, withdrawal_status FROM users ORDER BY id DESC");
    res.json({success: true, users: users.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/action', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
  
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
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
  try {
    const tx = await pool.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100");
    res.json({success: true, transactions: tx.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/send-notification', async (req, res) => {
  const pwd = req.headers['authorization'];
  if (!isValidAdminPassword(pwd)) return res.status(401).json({error: 'Unauthorized'});
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
   AVIATOR PREDICTOR PREMIUM
========================= */

const PREDICTOR_SETTING_KEYS = [
  'predictor_enabled',
  'predictor_mode',
  'predictor_demo_mode',
  'predictor_manual_signal',
  'predictor_manual_target',
  'predictor_manual_confidence',
  'predictor_target_offset',
  'predictor_success_message',
  'predictor_note'
];

function predictorAdmin(req) {
  return isValidAdminPassword(req.headers.authorization);
}

async function getPredictorSettings() {
  const result = await pool.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key = ANY($1::text[])",
    [PREDICTOR_SETTING_KEYS]
  );
  return Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
}

async function getPredictorPlans(includeInactive = false) {
  const result = await pool.query(
    `SELECT plan_key, name, price_ksh, duration_days, features, active, popup_notifications
     FROM predictor_plans
     ${includeInactive ? '' : 'WHERE active = TRUE'}
     ORDER BY price_ksh ASC`
  );
  return result.rows.map(plan => ({
    ...plan,
    price_zmw: Number(plan.price_ksh),
    price_ksh: Number(plan.price_ksh),
    currency: LIPILA_CURRENCY,
    features: Array.isArray(plan.features) ? plan.features : []
  }));
}

async function getPredictorStats() {
  const [accesses, active, revenue, recent] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count, COUNT(DISTINCT phone)::int AS unique_users FROM predictor_access_logs"),
    pool.query("SELECT COUNT(*)::int AS count, COUNT(DISTINCT phone)::int AS unique_users FROM predictor_subscriptions WHERE status = 'active' AND expires_at > NOW()"),
    pool.query("SELECT COALESCE(SUM(amount_ksh), 0)::numeric AS total FROM predictor_subscriptions WHERE status = 'active'"),
    pool.query(`
      SELECT l.phone, l.plan_key, l.action, l.created_at
      FROM predictor_access_logs l
      ORDER BY l.created_at DESC
      LIMIT 12
    `)
  ]);
  return {
    total_accesses: accesses.rows[0]?.count || 0,
    unique_access_users: accesses.rows[0]?.unique_users || 0,
    active_subscriptions: active.rows[0]?.count || 0,
    paying_users: active.rows[0]?.unique_users || 0,
    subscription_revenue: Number(revenue.rows[0]?.total || 0),
    recent_accesses: recent.rows
  };
}

function buildPredictorSignal(live, settings) {
  if (settings.predictor_mode === 'manual') {
    return {
      signal: settings.predictor_manual_signal || 'WATCH',
      confidence: Number(settings.predictor_manual_confidence || 72),
      target: Math.max(
        1.01,
        Number(settings.predictor_manual_target || 2) -
          Number(settings.predictor_target_offset || 0.41)
      ),
      detail: settings.predictor_note || 'Admin guidance is active.'
    };
  }

  const history = (live.history || []).map(Number).filter(Number.isFinite);
  const multiplier = Number(live.multiplier || 1);
  const recent = history.slice(0, 5);
  const average = recent.length
    ? recent.reduce((sum, value) => sum + value, 0) / recent.length
    : 2;
  let signal = 'WATCH';
  let confidence = 54;
  let target = Math.min(2.5, Math.max(1.5, average || 2));
  let detail = 'Waiting for more round context';

  if (live.status === 'RUNNING' && multiplier >= 2.5) {
    signal = 'EXIT';
    confidence = 78;
    target = multiplier;
    detail = 'The live round is extended; protect your session.';
  } else if (live.status === 'RUNNING' && multiplier >= 1.35) {
    signal = 'WATCH';
    confidence = 66;
    target = Math.max(multiplier, Math.min(2.5, multiplier + 0.35));
    detail = 'Round is moving; wait for a defined exit point.';
  } else if (live.status === 'WAITING' && recent.length >= 3 && average < 2) {
    signal = 'ENTER';
    confidence = 61;
    target = 1.6;
    detail = 'Early-round context is available; keep the target conservative.';
  } else if (live.status === 'CRASHED') {
    signal = 'WATCH';
    confidence = 59;
    target = Math.min(2.2, Math.max(1.4, average || 1.8));
    detail = 'A new round is forming; avoid chasing the last result.';
  }
  return { signal, confidence, target, detail };
}

app.get('/api/predictor/popup', async (req, res) => {
  const phone = formatPhone(req.query.phone || '');
  if (!phone) {
    return res.status(400).json({ success: false, error: 'Valid phone number required' });
  }
  try {
    const settings = await getPredictorSettings();
    if (settings.predictor_enabled === 'false') {
      return res.json({ success: true, eligible: false, prediction: null });
    }
    const subscriptionResult = await pool.query(`
      SELECT s.plan_key, p.name
      FROM predictor_subscriptions s
      JOIN predictor_plans p ON p.plan_key = s.plan_key
      WHERE s.phone = $1
        AND s.status = 'active'
        AND s.expires_at > NOW()
        AND p.popup_notifications = TRUE
      ORDER BY s.expires_at DESC
      LIMIT 1
    `, [phone]);
    if (subscriptionResult.rows.length === 0) {
      return res.json({ success: true, eligible: false, prediction: null });
    }

    // Publish one compact signal notification at most once per live round.
    if (gameStatus !== 'RUNNING' || !gameStartedAt) {
      return res.json({ success: true, eligible: true, prediction: null });
    }
    const subscription = subscriptionResult.rows[0];
    const signal = buildPredictorSignal({
      status: gameStatus,
      multiplier: currentMultiplier,
      history: oddsHistory
    }, settings);
    res.json({
      success: true,
      eligible: true,
      prediction: {
        id: `${gameStartedAt}:${subscription.plan_key}`,
        plan: subscription.name,
        signal: signal.signal,
        confidence: Math.max(1, Math.min(99, Number(signal.confidence) || 50)),
        target: Number(Number(signal.target || 2).toFixed(2)),
        detail: String(signal.detail || '').slice(0, 180),
        roundStartedAt: gameStartedAt
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not check for a prediction' });
  }
});

app.get('/api/predictor/config', async (req, res) => {
  try {
    const [settings, plans] = await Promise.all([getPredictorSettings(), getPredictorPlans()]);
    res.json({
      success: true,
      currency: LIPILA_CURRENCY,
      settings,
      plans,
      live: {
        status: gameStatus,
        multiplier: Number(currentMultiplier || 1).toFixed(2),
        history: oddsHistory.slice(0, 20)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Predictor configuration unavailable' });
  }
});

app.get('/api/predictor/access', async (req, res) => {
  const formattedPhone = formatPhone(req.query.phone || '');
  if (!formattedPhone) {
    return res.json({ success: true, subscribed: false, subscription: null, access_count: 0 });
  }
  try {
    const [subscriptionResult, accessResult] = await Promise.all([
      pool.query(`
        SELECT s.*, p.name, p.features
        FROM predictor_subscriptions s
        JOIN predictor_plans p ON p.plan_key = s.plan_key
        WHERE s.phone = $1 AND s.status = 'active' AND s.expires_at > NOW()
        ORDER BY s.expires_at DESC
        LIMIT 1
      `, [formattedPhone]),
      pool.query("SELECT COUNT(*)::int AS count FROM predictor_access_logs WHERE phone = $1", [formattedPhone])
    ]);
    const subscription = subscriptionResult.rows[0] || null;
    res.json({
      success: true,
      subscribed: Boolean(subscription),
      subscription: subscription ? {
        ...subscription,
        amount_zmw: Number(subscription.amount_ksh),
        amount_ksh: Number(subscription.amount_ksh),
        currency: LIPILA_CURRENCY,
        features: Array.isArray(subscription.features) ? subscription.features : []
      } : null,
      access_count: accessResult.rows[0]?.count || 0
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not check predictor access' });
  }
});

app.delete('/api/predictor/subscription', async (req, res) => {
  const formattedPhone = formatPhone(req.body?.phone || '');
  if (!formattedPhone) {
    return res.status(400).json({ success: false, error: 'Login required' });
  }

  try {
    const result = await pool.query(`
      UPDATE predictor_subscriptions
      SET status = 'cancelled'
      WHERE id = (
        SELECT id
        FROM predictor_subscriptions
        WHERE phone = $1
          AND status = 'active'
          AND expires_at > NOW()
        ORDER BY expires_at DESC
        LIMIT 1
      )
      RETURNING id, plan_key, status, expires_at
    `, [formattedPhone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No active predictor plan was found' });
    }

    await pool.query(
      "INSERT INTO predictor_access_logs (phone, plan_key, action) VALUES ($1, $2, 'cancel')",
      [formattedPhone, result.rows[0].plan_key]
    );

    res.json({
      success: true,
      message: 'Predictor plan deleted',
      subscription: result.rows[0]
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not delete predictor plan' });
  }
});

app.post('/api/predictor/subscription/change', async (req, res) => {
  const formattedPhone = formatPhone(req.body?.phone || '');
  const nextPlanKey = String(req.body?.planKey || '');
  if (!formattedPhone) {
    return res.status(400).json({ success: false, error: 'Login required' });
  }
  if (!nextPlanKey) {
    return res.status(400).json({ success: false, error: 'Choose a plan to continue' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const planResult = await client.query(
      "SELECT * FROM predictor_plans WHERE plan_key = $1 AND active = TRUE",
      [nextPlanKey]
    );
    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const userResult = await client.query(
      "SELECT phone, balance, status FROM users WHERE phone = $1 FOR UPDATE",
      [formattedPhone]
    );
    if (userResult.rows.length === 0 || userResult.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Active account required' });
    }

    const currentResult = await client.query(`
      SELECT id, plan_key
      FROM predictor_subscriptions
      WHERE phone = $1 AND status = 'active' AND expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT 1
      FOR UPDATE
    `, [formattedPhone]);
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'No active predictor plan was found' });
    }
    if (currentResult.rows[0].plan_key === nextPlanKey) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'That plan is already active' });
    }

    const plan = planResult.rows[0];
    const price = Number(plan.price_zmw ?? plan.price_ksh);
    const balance = Number(userResult.rows[0].balance || 0);
    if (balance < price) {
      await client.query('ROLLBACK');
      return res.status(402).json({
        success: false,
        needsTopUp: true,
        currency: LIPILA_CURRENCY,
        price,
        error: `Add ZMW ${Math.ceil(price - balance)} to your wallet to change to this plan`
      });
    }

    const expiresAt = new Date(Date.now() + Number(plan.duration_days) * 86400000);
    await client.query("UPDATE predictor_subscriptions SET status = 'cancelled' WHERE id = $1", [currentResult.rows[0].id]);
    await client.query("UPDATE users SET balance = balance - $1 WHERE phone = $2", [price, formattedPhone]);
    await client.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'predictor_subscription_change', $3, 'success')",
      [formattedPhone, price, `PREDICTOR-CHANGE-${Date.now()}`]
    );
    const subscription = await client.query(`
      INSERT INTO predictor_subscriptions (phone, plan_key, amount_ksh, starts_at, expires_at)
      VALUES ($1, $2, $3, NOW(), $4)
      RETURNING *
    `, [formattedPhone, nextPlanKey, price, expiresAt]);
    await client.query('COMMIT');

    res.json({
      success: true,
      currency: LIPILA_CURRENCY,
      message: 'Predictor plan changed',
      subscription: {
        ...subscription.rows[0],
        amount_zmw: Number(subscription.rows[0].amount_ksh),
        name: plan.name,
        features: Array.isArray(plan.features) ? plan.features : []
      }
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ success: false, error: 'Could not change predictor plan' });
  } finally {
    client.release();
  }
});

// Lightweight predictor re-entry for returning users. This does not expose a
// PIN and only returns the minimum profile data needed by the predictor page.
// Subscription status is still checked by the access query below.
app.post('/api/predictor/phone-access', async (req, res) => {
  const formattedPhone = formatPhone(req.body.phone || '');
  if (!formattedPhone) {
    return res.status(400).json({ success: false, error: 'Enter a valid Zambia mobile number.' });
  }
  try {
    const userResult = await pool.query(
      "SELECT username, phone, balance, status FROM users WHERE phone = $1 LIMIT 1",
      [formattedPhone]
    );
    if (userResult.rows.length === 0 || userResult.rows[0].status !== 'active') {
      return res.status(404).json({ success: false, error: 'No active account was found for this phone. Create an account on the Aviator page first.' });
    }
    const user = userResult.rows[0];
    res.json({
      success: true,
      user: {
        username: user.username,
        phone: user.phone,
        balance: Number(user.balance || 0)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not verify that phone number.' });
  }
});

app.post('/api/predictor/access', async (req, res) => {
  const formattedPhone = formatPhone(req.body.phone || '');
  if (!formattedPhone) return res.status(400).json({ success: false, error: 'Login required' });
  try {
    const active = await pool.query(`
      SELECT plan_key FROM predictor_subscriptions
      WHERE phone = $1 AND status = 'active' AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1
    `, [formattedPhone]);
    if (active.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Active predictor subscription required' });
    }
    await pool.query(
      "INSERT INTO predictor_access_logs (phone, plan_key, action) VALUES ($1, $2, 'open')",
      [formattedPhone, active.rows[0].plan_key]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not record predictor access' });
  }
});

app.post('/api/predictor/subscribe', async (req, res) => {
  const formattedPhone = formatPhone(req.body.phone || '');
  const planKey = String(req.body.planKey || '');
  if (!formattedPhone) return res.status(400).json({ success: false, error: 'Login required' });
  const client = await pool.connect();
  try {
    const planResult = await client.query(
      "SELECT * FROM predictor_plans WHERE plan_key = $1 AND active = TRUE",
      [planKey]
    );
    if (planResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    const plan = planResult.rows[0];
    await client.query('BEGIN');
    const userResult = await client.query(
      "SELECT phone, balance, status FROM users WHERE phone = $1 FOR UPDATE",
      [formattedPhone]
    );
    if (userResult.rows.length === 0 || userResult.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Active account required' });
    }
    const price = Number(plan.price_zmw ?? plan.price_ksh);
    const balance = Number(userResult.rows[0].balance || 0);
    if (balance < price) {
      await client.query('ROLLBACK');
      return res.status(402).json({
        success: false,
        needsTopUp: true,
        currency: LIPILA_CURRENCY,
        price,
        error: `Add ZMW ${Math.ceil(price - balance)} to your wallet to activate this plan`
      });
    }
    const expiresAt = new Date(Date.now() + Number(plan.duration_days) * 86400000);
    await client.query("UPDATE users SET balance = balance - $1 WHERE phone = $2", [price, formattedPhone]);
    await client.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'predictor_subscription', $3, 'success')",
      [formattedPhone, price, `PREDICTOR-${Date.now()}`]
    );
    const subscription = await client.query(`
      INSERT INTO predictor_subscriptions (phone, plan_key, amount_ksh, starts_at, expires_at)
      VALUES ($1, $2, $3, NOW(), $4)
      RETURNING *
    `, [formattedPhone, planKey, price, expiresAt]);
    await client.query('COMMIT');
    res.json({
      success: true,
      currency: LIPILA_CURRENCY,
      subscription: {
        ...subscription.rows[0],
        amount_zmw: Number(subscription.rows[0].amount_ksh),
        name: plan.name,
        features: Array.isArray(plan.features) ? plan.features : []
      }
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ success: false, error: 'Subscription activation failed' });
  } finally {
    client.release();
  }
});

app.get('/admin/predictor/config', async (req, res) => {
  if (!predictorAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    res.json({ success: true, currency: LIPILA_CURRENCY, settings: await getPredictorSettings(), plans: await getPredictorPlans(true), stats: await getPredictorStats() });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not load predictor admin data' });
  }
});

app.post('/admin/predictor/config', async (req, res) => {
  if (!predictorAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { settings = {}, plans = [] } = req.body || {};
  const allowedSignals = new Set(['ENTER', 'WATCH', 'EXIT', 'PAUSE']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of PREDICTOR_SETTING_KEYS) {
      if (settings[key] === undefined) continue;
      let value = String(settings[key]);
      if (key === 'predictor_mode' && !['auto', 'manual'].includes(value)) value = 'auto';
      if (key === 'predictor_manual_signal' && !allowedSignals.has(value)) value = 'WATCH';
      if (key === 'predictor_manual_target') value = String(Math.min(50, Math.max(1.01, Number(value) || 2)));
      if (key === 'predictor_manual_confidence') value = String(Math.min(99, Math.max(1, Number(value) || 50)));
      if (key === 'predictor_target_offset') value = String(Math.min(5, Math.max(0, Number(value) || 0)));
      if (key === 'predictor_success_message') value = value.slice(0, 180);
      if (key === 'predictor_enabled' || key === 'predictor_demo_mode') value = value === 'true' ? 'true' : 'false';
      await client.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
        [key, value]
      );
    }
    for (const plan of Array.isArray(plans) ? plans : []) {
      const planKey = String(plan.plan_key || '');
      const name = String(plan.name || '').trim();
      const price = Number(plan.price_zmw ?? plan.price_ksh);
      const duration = Number(plan.duration_days);
      const features = Array.isArray(plan.features) ? plan.features.map(item => String(item).trim()).filter(Boolean).slice(0, 10) : [];
      const active = plan.active !== false && String(plan.active) !== 'false';
      const popupNotifications = plan.popup_notifications !== false && String(plan.popup_notifications) !== 'false';
      if (!planKey || !name || !Number.isFinite(price) || price < 1 || !Number.isInteger(duration) || duration < 1) continue;
      await client.query(`
        INSERT INTO predictor_plans (plan_key, name, price_ksh, duration_days, features, active, popup_notifications, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
        ON CONFLICT (plan_key) DO UPDATE SET
          name = EXCLUDED.name,
          price_ksh = EXCLUDED.price_ksh,
          duration_days = EXCLUDED.duration_days,
          features = EXCLUDED.features,
          active = EXCLUDED.active,
          popup_notifications = EXCLUDED.popup_notifications,
          updated_at = NOW()
      `, [planKey, name, price, duration, JSON.stringify(features), active, popupNotifications]);
    }
    await client.query('COMMIT');
    res.json({ success: true, currency: LIPILA_CURRENCY, settings: await getPredictorSettings(), plans: await getPredictorPlans(), stats: await getPredictorStats() });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ success: false, error: 'Could not save predictor settings' });
  } finally {
    client.release();
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
   LIPILA PAYMENT ROUTES
========================= */

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, email } = req.body;
    const formattedPhone = formatPhone(phone);
    const numericAmount = Math.round(Number(amount) * 100) / 100;
    const limits = await getWalletLimits();

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Use a valid Zambia mobile number." });

    if (!Number.isFinite(numericAmount) || numericAmount < limits.minimum_deposit)
      return res.status(400).json({ success: false, error: `Minimum deposit is ZMW ${limits.minimum_deposit}` });

    const reference = createPaymentReference("ZMW-DEPOSIT");
    saveReceipt(reference, {
      reference,
      kind: "deposit",
      amount: numericAmount,
      phone: formattedPhone,
      status: "pending",
      provider: "lipila",
      currency: LIPILA_CURRENCY,
      timestamp: new Date().toISOString()
    });
    await pool.query(
      "INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, 'deposit', $3, 'pending')",
      [formattedPhone, numericAmount, reference]
    );

    const collection = await initiateLipilaCollection({
      phone: formattedPhone,
      amount: numericAmount,
      reference,
      email: typeof email === "string" ? email.trim() : undefined
    });
    if (!collection.success) {
      if (!collection.outcomeUnknown) {
        await pool.query(
          "UPDATE transactions SET status = 'failed' WHERE reference = $1 AND type = 'deposit' AND status = 'pending'",
          [reference]
        );
        saveReceipt(reference, {
          status: "failed",
          status_message: collection.error,
          timestamp: new Date().toISOString()
        });
        return res.status(collection.status || 502).json({
          success: false,
          error: collection.error
        });
      }
      saveReceipt(reference, {
        lipila_status: "Submission status unknown",
        status_message: "The collection request may have reached Lipila; check payment status before retrying.",
        timestamp: new Date().toISOString()
      });
      return res.status(202).json({
        success: true,
        pending: true,
        status: "pending",
        reference,
        currency: LIPILA_CURRENCY,
        provider: "Lipila",
        message: "Payment status is pending confirmation. Check status before submitting another deposit."
      });
    }

    const providerData = collection.data || {};
    await saveLipilaProviderReferences(reference, providerData);
    saveReceipt(reference, {
      lipila_reference_id: providerData.referenceId || null,
      lipila_identifier: providerData.identifier || null,
      lipila_status: providerData.status || "Pending"
    });
    let settlement = { status: "pending" };
    if (["successful", "failed"].includes(String(providerData.status || "").toLowerCase())) {
      settlement = await applyLipilaFinalStatus(reference, providerData);
    }
    res.status(settlement.status === "pending" ? 202 : 200).json({
      success: settlement.status !== "failed",
      pending: settlement.status === "pending",
      status: settlement.status,
      reference,
      currency: LIPILA_CURRENCY,
      provider: "Lipila",
      message: providerData.message || undefined
    });
  } catch (err) {
    console.error("Lipila collection setup failed:", err.message);
    res.status(500).json({
      success: false,
      error: "Could not start the deposit."
    });
  }
});

app.post("/callback", async (req, res) => {
  if (!verifyLipilaWebhook(req)) {
    return res.status(401).json({ success: false, error: "Invalid Lipila webhook signature." });
  }

  const data = lipilaData(req.body);
  try {
    const reference = await resolveLipilaReference(data);
    const receipt = reference ? await getLipilaReceipt(reference) : null;
    if (!receipt) {
      return res.status(404).json({ success: false, received: false, error: "Payment reference not found." });
    }
    const expectedType = receipt.kind === "withdrawal" ? "disbursement" : "collection";
    if (data.type && String(data.type).toLowerCase() !== expectedType) {
      return res.status(400).json({ success: false, error: "Lipila transaction type does not match." });
    }
    const result = await applyLipilaFinalStatus(reference, data);
    return res.status(200).json({
      success: result.success,
      received: true,
      status: result.status
    });
  } catch (err) {
    console.error("Lipila webhook settlement failed:", err.message);
    return res.status(500).json({ success: false, error: "Could not settle Lipila transaction." });
  }
});

app.get("/payment-status/:reference", async (req, res) => {
  const reference = req.params.reference;
  const formattedPhone = formatPhone(req.query.phone || "");
  const receipt = await getLipilaReceipt(reference);
  if (!formattedPhone || !receipt || receipt.phone !== formattedPhone) {
    return res.status(404).json({ success: false, error: "Payment not found." });
  }
  try {
    const result = receipt.status === "pending"
      ? await refreshLipilaStatus(reference)
      : { success: true, status: receipt.status };
    const updatedReceipt = readReceipts()[reference] || receipt;
    res.json({
      success: result.success,
      status: updatedReceipt.status || result.status,
      reference,
      kind: updatedReceipt.kind,
      amount: Number(updatedReceipt.amount),
      currency: LIPILA_CURRENCY,
      message: result.error || updatedReceipt.status_message || undefined
    });
  } catch (err) {
    console.error("Lipila payment status check failed:", err.message);
    res.status(502).json({ success: false, status: "pending", error: "Could not check payment status." });
  }
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
      status_message: "Payment timed out.",
      timestamp: new Date().toISOString()
    });
    if (receipt.kind === "withdrawal_fee") {
      try {
        await settleThresholdWithdrawal(
          receipt.request_id,
          "timeout",
          `Threshold payment timed out. ZMW ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
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

  const receipt = await getLipilaReceipt(reference);
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
  if (receipt.provider === "lipila") {
    const status = await refreshLipilaStatus(reference);
    return res.status(409).json({
      success: false,
      status: status.status || "pending",
      message: "A Lipila payment cannot be cancelled from this server. Wait for Lipila's final status."
    });
  }

  const status = reason === "timeout" ? "timeout" : "cancelled_by_user";
  const message = status === "timeout"
    ? "Payment timed out."
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
          ? `Withdrawal cancelled by user. ZMW ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
          : `Threshold payment timed out. ZMW ${Number(receipt.withdraw_amount).toFixed(2)} was refunded.`
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
    if (request.status === "awaiting_fee") {
      await refreshLipilaStatus(request.fee_reference || request.reference);
      requestResult = await pool.query(
        "SELECT * FROM withdrawal_requests WHERE id = $1 AND phone = $2",
        [pendingId, formattedPhone]
      );
      request = requestResult.rows[0];
    } else if (["pending", "payout_pending"].includes(request.status)) {
      await refreshLipilaStatus(request.reference);
      requestResult = await pool.query(
        "SELECT * FROM withdrawal_requests WHERE id = $1 AND phone = $2",
        [pendingId, formattedPhone]
      );
      request = requestResult.rows[0];
    }
    if (
      request.status === "awaiting_fee" &&
      new Date(request.expires_at).getTime() <= Date.now()
    ) {
      const feeReference = request.fee_reference || request.reference;
      request = await settleThresholdWithdrawal(
        request.id,
        "timeout",
        `Threshold payment timed out. ZMW ${Number(request.amount).toFixed(2)} was refunded.`
      );
      saveReceipt(feeReference, {
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
      feeReference: request.fee_reference || null,
      threshold: Number(request.fee) > 0,
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
      `Withdrawal cancelled by user. ZMW ${Number(request.amount).toFixed(2)} was refunded.`
    );
    saveReceipt(request.fee_reference || request.reference, {
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

  try {
    const requestResult = await pool.query(
      "SELECT id, status FROM withdrawal_requests WHERE id = $1 AND phone = $2",
      [pendingId, formattedPhone]
    );
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }
    return res.status(409).json({
      success: false,
      status: requestResult.rows[0].status,
      error: "A second fee prompt cannot be sent safely while Lipila may still process the first. Wait for the current status or refund, then start a new withdrawal."
    });
  } catch (err) {
    console.error("Withdrawal retry check failed:", err.message);
    return res.status(500).json({ success: false, error: "Could not check the withdrawal status." });
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
      doc.text(`Amount: ZMW ${receipt.amount}`);
  doc.text(`Status: ${receipt.status}`);
  doc.text(`Transaction Code: ${receipt.transaction_code || "N/A"}`);
  doc.text(`Date: ${receipt.timestamp}`);

  doc.end();
});

// REMOVED DUPLICATE LISTEN CALL HERE

