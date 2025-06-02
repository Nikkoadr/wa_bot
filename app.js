require("dotenv").config();
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");
const qrcode = require("qrcode");
const axios = require("axios");
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

//process.chdir(path.join(__dirname, "data"));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Cek env wajib
if (!process.env.WEBHOOK_URL || !process.env.WEBHOOK_TOKEN) {
  console.warn("⚠️ WEBHOOK_URL dan WEBHOOK_TOKEN belum disetel di .env!");
}

// Format nomor menjadi ID WhatsApp
const formatNumber = (number) => {
  number = number.replace(/\D/g, "");

  if (number.startsWith("0")) {
    number = "62" + number.slice(1);
  }

  return number.includes("@c.us") ? number : `${number}@c.us`;
};


const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./data",
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let isConnected = false;

// QR Code generation
client.on("qr", (qr) => {
  console.log("[QR] Silakan scan QR");
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error("❌ Gagal generate QR code:", err);
      return;
    }
    io.emit("qr", url);
    io.emit("status", { type: "warning", text: "Scan QR Code untuk login" });
  });
});

client.on("authenticated", () => {
  console.log("[AUTH] Autentikasi berhasil");
  io.emit("status", {
    type: "info",
    text: "Autentikasi berhasil, memuat WhatsApp...",
  });
});

client.on("ready", () => {
  console.log("[READY] WhatsApp siap digunakan");
  isConnected = true;
  io.emit("ready");
  io.emit("loggedin");
  io.emit("whatsapp-connection", true);
  io.emit("status", {
    type: "success",
    text: "Bot siap menerima dan mengirim pesan!",
  });
});

client.on("disconnected", async (reason) => {
  console.log("[DISCONNECTED]", reason);
  isConnected = false;
  io.emit("whatsapp-connection", false);
  io.emit("status", {
    type: "danger",
    text: "Terputus, silakan refresh dan scan ulang QR.",
  });

  // Destroy and re-initialize to get new QR
  await client.destroy();
  client.initialize();
});

// Handle pesan masuk ke webhook

client.on("message", async (msg) => {
  // Abaikan jika pesan kosong
  if (!msg.body || msg.body.trim() === "") return;

  try {
    // Kirim data ke n8n webhook
    const response = await axios.post(
      process.env.WEBHOOK_URL,
      {
        from: msg.from,
        name: msg._data?.notifyName || "",
        message: msg.body,
      },
      {
        headers: {
          "x-api-token": process.env.WEBHOOK_TOKEN,
        },
      }
    );

    console.log("[WEBHOOK] Pesan terkirim ke n8n");

    // Jika n8n membalas dengan data.message, kirim kembali ke user WA
    if (response.data && typeof response.data.message === "string") {
      await client.sendMessage(msg.from, response.data.message);
      console.log("[BOT] Balasan dikirim ke:", msg.from);
    } else {
      console.log("[BOT] Tidak ada balasan dari n8n atau format tidak valid");
    }
  } catch (error) {
    console.error("❌ Gagal kirim ke webhook n8n:", error.message);
  }
});

// WebSocket koneksi
io.on("connection", (socket) => {
  console.log("🔌 Socket client connected");

  // Kirim status koneksi awal
  socket.emit("whatsapp-connection", isConnected);

  // Logout WhatsApp dari socket
  socket.on("logout", async () => {
    try {
      await client.logout();
      await client.destroy();
      isConnected = false;
      socket.emit("status", { type: "info", text: "Berhasil logout" });

      // Re-initiate WA client for new QR
      client.initialize();
    } catch (err) {
      console.error("❌ Gagal logout:", err.message);
      socket.emit("status", { type: "danger", text: "Gagal logout" });
    }
  });
});

// API: Kirim pesan manual
app.post("/send-message", async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res
      .status(400)
      .json({ status: false, message: "Data tidak lengkap" });
  }

  const toNumber = formatNumber(to);

  try {
    const isRegistered = await client
      .isRegisteredUser(toNumber)
      .catch(() => false);
    if (!isRegistered) {
      return res
        .status(422)
        .json({ status: false, message: "Nomor tidak terdaftar di WhatsApp" });
    }

    await client.sendMessage(toNumber, message);
    res.json({ status: true, message: "Pesan berhasil dikirim" });
  } catch (error) {
    console.error("❌ Gagal kirim pesan dari HTTP:", error.message);
    res.status(500).json({
      status: false,
      message: "Gagal kirim pesan",
      error: error.message,
    });
  }
});

// API: Status bot
app.get("/status", (req, res) => {
  res.json({
    status: isConnected ? "connected" : "disconnected",
    uptime: process.uptime(),
    version: "1.0.0",
  });
});

// Halaman utama
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});

// Inisialisasi WhatsApp client
client.initialize();
