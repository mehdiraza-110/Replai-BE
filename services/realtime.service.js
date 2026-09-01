const { Server } = require("socket.io");

let io = null;

/**
 * Attaches a Socket.IO server to the given HTTP server. Every connected
 * browser tab (any signed-in user, any page) joins the same broadcast —
 * this app has no per-workspace tenancy today, so there's nothing to scope
 * rooms by yet.
 */
function init(server) {
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    socket.on("disconnect", () => {});
  });

  return io;
}

/**
 * Broadcasts a domain event to every connected client. Fire-and-forget and
 * safe to call before `init()` runs or if a client is never listening —
 * a live-update push is a nice-to-have, never a requirement for the
 * mutation itself to succeed.
 */
function broadcast(event, payload) {
  if (!io) return;

  try {
    io.emit(event, payload);
  } catch (error) {
    console.error("Realtime broadcast failed:", error.message);
  }
}

module.exports = { init, broadcast };
