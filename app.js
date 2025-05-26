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

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let isConnected = false;

// Generate QR Code
client.on("qr", (qr) => {
  console.log("[QR] Silakan scan QR");
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error("Gagal generate QR code:", err);
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

client.on("message", async (msg) => {
  console.log(`[PESAN MASUK] ${msg.from}: ${msg.body}`);
  io.emit("message", { from: msg.from, body: msg.body });

  // Kirim ke Webhook n8n
  try {
    await axios.post(
      "https://n8n.smkmuhkandanghar.sch.id/webhook/whatsapp-masuk",
      {
        from: msg.from,
        name: msg._data?.notifyName || "",
        message: msg.body,
      }
    );
    console.log("[WEBHOOK] Terkirim ke n8n");
  } catch (error) {
    console.error("❌ Gagal kirim ke webhook n8n:", error.message);
  }

  // Respon otomatis sederhana
  if (msg.body.toLowerCase() === "halo") {
    msg.reply("Hai juga! Ada yang bisa saya bantu?");
  }
});

client.on("disconnected", (reason) => {
  console.log("[DISCONNECTED]", reason);
  isConnected = false;
  io.emit("whatsapp-connection", false);
  io.emit("status", {
    type: "danger",
    text: "Terputus, silakan refresh dan scan ulang QR.",
  });
});

// Endpoint kirim pesan manual
io.on("connection", (socket) => {
  console.log("🔌 Socket client connected");
  socket.emit("whatsapp-connection", isConnected);

  socket.on("send-message", async ({ number, message }) => {
    try {
      const cleanNumber = number.replace(/\D/g, "");
      if (!/^628[1-9][0-9]{7,11}$/.test(cleanNumber)) {
        socket.emit("alert", {
          icon: "warning",
          title: "Nomor tidak valid",
          text: "Gunakan format 628xxxxxxxxxx (hanya angka).",
        });
        return;
      }

      const chatId = cleanNumber + "@c.us";
      const isRegistered = await client.isRegisteredUser(chatId);

      if (!isRegistered) {
        socket.emit("alert", {
          icon: "error",
          title: "Nomor tidak terdaftar",
          text: `Nomor ${cleanNumber} tidak terdaftar di WhatsApp.`,
        });
        return;
      }

      await client.sendMessage(chatId, message);
      socket.emit("alert", {
        icon: "success",
        title: "Pesan terkirim",
        text: `Pesan berhasil dikirim ke ${cleanNumber}`,
      });
    } catch (err) {
      console.error("❌ Gagal kirim pesan:", err.message);
      socket.emit("alert", {
        icon: "error",
        title: "Kesalahan",
        text: "Gagal mengirim pesan. Periksa koneksi atau format nomor.",
      });
    }
  });
});

// Halaman utama
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});

// Inisialisasi WA client
client.initialize();
