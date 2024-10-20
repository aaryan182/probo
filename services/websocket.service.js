const WebSocket = require("ws");
const uuid = require("uuid");
const redisService = require("./redis.service");

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.clients = new Map();

    this.wss.on("connection", (ws) => {
      const id = uuid.v4();
      this.clients.set(id, ws);

      ws.on("message", (message) => {
        this.broadcast(message, id);
      });

      ws.on("close", () => {
        this.clients.delete(id);
      });
    });

    redisService.subscribe("updates", (message) => {
      this.sendToAll(JSON.stringify(message));
    });
  }

  broadcast(message, senderId) {
    this.clients.forEach((client, id) => {
      if (id !== senderId && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  sendToAll(message) {
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

module.exports = WebSocketService;
