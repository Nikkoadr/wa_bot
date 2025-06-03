const fs = require("fs");
const express = require("express");
const session = require("express-session");
const { Client, LocalAuth } = require("whatsapp-web.js");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");
const qrcode = require("qrcode");
const axios = require("axios");
const cors = require("cors");
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const sessionPath = path.join(__dirname, "data");

app.use(
  session({
    secret: process.env.SESSION_SECRET || "whatsapp_bot_secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // true jika menggunakan HTTPS
  })
);
app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG_PATH = path.join(__dirname, "config.json");
const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Middleware untuk autentikasi token
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token || token !== process.env.AUTH_TOKEN) {
    return res.status(401).json({ status: false, message: "Unauthorized" });
  }
  next();
}

// Fungsi baca config dari file JSON
function readConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.warn("⚠️ Gagal baca config.json, menggunakan config kosong.");
    return { webhook_url: "", webhook_token: "" };
  }
}

// Fungsi simpan config ke file JSON
function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    return true;
  } catch (err) {
    console.error("❌ Gagal simpan config.json:", err.message);
    return false;
  }
}

// Cek config pada saat start
const initialConfig = readConfig();
if (!initialConfig.webhook_url || !initialConfig.webhook_token) {
  console.warn(
    "⚠️ Peringatan: Webhook URL atau Token belum diset di config.json!"
  );
}

// Format nomor WA ke format WhatsApp ID resmi
const formatNumber = (number) => {
  number = number.replace(/\D/g, "");
  if (number.startsWith("0")) {
    number = "62" + number.slice(1);
  }
  return number.includes("@c.us") ? number : `${number}@c.us`;
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: sessionPath,
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let isConnected = false;
let isReinitializing = false;

// Event: QR code diterima
client.on("qr", (qr) => {
  console.log("🔶 QR Code diterima, silakan scan untuk login WhatsApp...");
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error("❌ Gagal membuat QR Code:", err);
      return;
    }
    io.emit("qr", url);
  });
});

// Event: Autentikasi berhasil
client.on("authenticated", () => {
  console.log("✅ Autentikasi WhatsApp berhasil, sedang memuat...");
  io.emit("status", {
    type: "info",
    text: "🔐 Autentikasi berhasil, persiapan bot...",
  });
});

// Event: WhatsApp siap
client.on("ready", () => {
  console.log("🚀 WhatsApp client siap digunakan!");
  isConnected = true;
  io.emit("ready");
  io.emit("loggedin");
  io.emit("whatsapp-connection", true);
  io.emit("status", {
    type: "success",
    text: "🤖 Bot siap mengirim dan menerima pesan.",
  });
});

// Event: WhatsApp disconnect
client.on("disconnected", async (reason) => {
  console.warn(`⚠️ WhatsApp terputus: ${reason}`);
  isConnected = false;
  io.emit("whatsapp-connection", false);
  io.emit("status", {
    type: "danger",
    text: "🔴 Koneksi terputus! Silakan refresh dan scan ulang QR.",
  });

  if (isReinitializing) return;
  isReinitializing = true;

  try {
    if (client) {
      console.log("🧹 Membersihkan sesi WhatsApp yang lama...");
      await client.destroy();
    }

    if (reason === "NAVIGATION") {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🗑️ Sesi lama dihapus karena logout dari HP.");
    }

    console.log("⏳ Menunggu sebentar sebelum inisialisasi ulang...");
    await new Promise((r) => setTimeout(r, 3000));
    console.log("🔄 Menginisialisasi ulang WhatsApp client...");
    client.initialize();
  } catch (err) {
    console.error("❌ Gagal inisialisasi ulang:", err.message);
  } finally {
    isReinitializing = false;
  }
});

// Event: Pesan masuk
client.on("message", async (msg) => {
  if (!msg.body || msg.body.trim() === "") return;

  const config = readConfig();

  if (!config.webhook_url || !config.webhook_token) {
    console.warn(
      "⚠️ Webhook URL atau Token belum diset di config.json, abaikan pesan masuk."
    );
    return;
  }

  try {
    const payload = {
      from: msg.from,
      name: msg._data?.notifyName || "",
      message: msg.body,
    };
    console.log(`[WEBHOOK] Mengirim pesan dari ${payload.from} ke webhook...`);
    const response = await axios.post(config.webhook_url, payload, {
      headers: { "x-api-token": config.webhook_token },
    });
    console.log("[WEBHOOK] Pesan berhasil dikirim ke n8n.");

    if (response.data && typeof response.data.message === "string") {
      await client.sendMessage(msg.from, response.data.message);
      console.log(
        `[BOT] Balasan dikirim ke ${msg.from}: "${response.data.message}"`
      );
    } else {
      console.log(
        "[BOT] Tidak ada balasan atau format balasan tidak valid dari n8n."
      );
    }
  } catch (error) {
    console.error("❌ Gagal mengirim pesan ke webhook n8n:", error.message);
  }
});

// Socket connection
io.on("connection", (socket) => {
  console.log("🔌 Socket client tersambung.");

  socket.emit("whatsapp-connection", isConnected);

  socket.on("logout", async () => {
    try {
      console.log(
        "🚪 Permintaan logout diterima, melakukan logout WhatsApp..."
      );
      await client.logout();
      await client.destroy();
      isConnected = false;
      socket.emit("status", { type: "info", text: "🔓 Logout berhasil." });

      console.log("♻️ Menginisialisasi ulang client untuk login baru...");
      client.initialize();
    } catch (err) {
      console.error("❌ Gagal melakukan logout:", err.message);
      socket.emit("status", {
        type: "danger",
        text: "⚠️ Gagal logout, coba lagi.",
      });
    }
  });
});

// Middleware cek login
function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  } else {
    res.redirect("/login");
  }
}

// API: Kirim pesan
app.post("/send-message", authenticateToken, async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res
      .status(400)
      .json({ status: false, message: "Data pengiriman tidak lengkap." });
  }

  const toNumber = formatNumber(to);

  try {
    const isRegistered = await client
      .isRegisteredUser(toNumber)
      .catch(() => false);
    if (!isRegistered) {
      return res.status(422).json({
        status: false,
        message: "Nomor tujuan tidak terdaftar di WhatsApp.",
      });
    }

    await client.sendMessage(toNumber, message);
    console.log(`✉️ Pesan terkirim ke ${toNumber}: "${message}"`);
    res.json({ status: true, message: "Pesan berhasil dikirim." });
  } catch (error) {
    console.error("❌ Gagal mengirim pesan:", error.message);
    res.status(500).json({
      status: false,
      message: "Gagal mengirim pesan.",
      error: error.message,
    });
  }
});

// API: Status bot
app.get("/status", authenticateToken, (req, res) => {
  res.json({
    status: isConnected ? "connected" : "disconnected",
    uptime: process.uptime(),
    version: "1.0.0",
  });
});

// API: GET config webhook
app.get("/api/config", authenticateToken, (req, res) => {
  const config = readConfig();

  if (!config.webhook_url || !config.webhook_token) {
    return res.status(404).json({
      status: false,
      message: "Konfigurasi webhook belum diset.",
      webhook_url: "",
      webhook_token: "",
    });
  }

  res.json({
    status: true,
    webhook_url: config.webhook_url,
    webhook_token: config.webhook_token,
  });
});

// API: POST update config webhook
app.post("/api/config", authenticateToken, (req, res) => {
  const { webhook_url, webhook_token } = req.body;
  if (!webhook_url || !webhook_token) {
    return res
      .status(400)
      .json({ status: false, message: "Data config kurang lengkap." });
  }

  const newConfig = { webhook_url, webhook_token };
  const success = saveConfig(newConfig);

  if (!success) {
    return res
      .status(500)
      .json({ status: false, message: "Gagal menyimpan config." });
  }

  res.json({ status: true, message: "Config berhasil disimpan." });
});

// GET Login Page
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// POST Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const valid =
    username === process.env.LOGIN_USERNAME &&
    password === process.env.LOGIN_PASSWORD;

  if (valid) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else {
    res.status(401).send("Login gagal. Username atau password salah.");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// Halaman utama (dilindungi)
app.get("/", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Jalankan server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});

// Mulai WhatsApp client
console.log("✨ Memulai WhatsApp client...");
client.initialize();
