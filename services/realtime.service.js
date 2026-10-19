const { Server } = require("socket.io");
const jwtUtil = require("../utils/jwt.util");
const workspaceService = require("./workspace.service");

let io = null;

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return null;
}

const roomFor = (workspaceId) => `ws:${workspaceId}`;

/**
 * Resolves who is connecting from the handshake: the `token` cookie (same JWT + workspace resolution as
 * TenantGuard). A super admin may watch another workspace via `auth.viewAs` / `?viewAs=`. Returns the workspace
 * id to join, or throws an Error whose message is sent to the client as the connect_error reason.
 */
async function authenticateHandshake(handshake) {
  const token = readCookie(handshake.headers?.cookie, "token");
  if (!token) throw new Error("Please sign in to continue.");

  let decoded;
  try {
    decoded = jwtUtil.verifyToken(token);
  } catch (error) {
    throw new Error("Your session has expired. Please sign in again.");
  }

  const viewAs = handshake.auth?.viewAs || handshake.query?.viewAs || null;
  let ctx;
  try {
    ctx = await workspaceService.resolveContext(decoded.userId, decoded.workspaceId, viewAs);
  } catch (error) {
    if (error instanceof workspaceService.WorkspaceError) throw new Error(error.message);
    throw error;
  }

  if (!ctx) throw new Error("Your session has expired. Please sign in again.");
  if (!ctx.workspace) throw new Error("Create a workspace to continue.");
  if (ctx.workspace.status === "suspended" && !ctx.isSuperAdmin) {
    throw new Error("This workspace has been suspended. Please contact support.");
  }

  return { userId: decoded.userId, workspaceId: ctx.workspace.id };
}

/**
 * Attaches a Socket.IO server to the given HTTP server. Sockets must authenticate from the session cookie and are
 * placed in the room of their active workspace (`ws:<id>`); events are only ever emitted to that room.
 */
function init(server) {
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const identity = await authenticateHandshake(socket.handshake);
      socket.data.userId = identity.userId;
      socket.data.workspaceId = identity.workspaceId;
      next();
    } catch (error) {
      if (!/sign in|Create a workspace|suspended|no longer exists/.test(error.message)) {
        console.error("Realtime auth error:", error.message);
        return next(new Error("We could not verify your session."));
      }
      next(new Error(error.message));
    }
  });

  io.on("connection", (socket) => {
    socket.join(roomFor(socket.data.workspaceId));
    socket.on("disconnect", () => {});
  });

  return io;
}

/**
 * Broadcasts a domain event to every client connected to one workspace. Fire-and-forget and safe to call before
 * `init()` runs, with no workspace, or if nobody is listening — a live-update push is a nice-to-have, never a
 * requirement for the mutation itself to succeed.
 */
function broadcast(workspaceId, event, payload) {
  if (!io || workspaceId === null || workspaceId === undefined) return;

  try {
    io.to(roomFor(workspaceId)).emit(event, payload);
  } catch (error) {
    console.error("Realtime broadcast failed:", error.message);
  }
}

module.exports = { init, broadcast, authenticateHandshake };
