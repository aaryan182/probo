const WebSocket = require("ws");
const uuid = require("uuid");

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.clients = new Map();
    this.subscriptions = new Map();

    this.wss.on("connection", (ws) => {
      const id = uuid.v4();
      this.clients.set(id, ws);

      ws.on("message", (message) => {
        try {
          const data = JSON.parse(message);
          if (data.type === "subscribe") {
            this.handleSubscription(id, ws, data.stockSymbol);
          }
        } catch (error) {
          console.error("WebSocket message error:", error);
        }
      });

      ws.on("close", () => {
        this.clients.delete(id);
        this.subscriptions.delete(id);
      });
    });

    redisService.subscribe("updates", (message) => {
      this.handleUpdate(message);
    });
  }

  handleSubscription(clientId, ws, stockSymbol) {
    this.subscriptions.set(clientId, stockSymbol);
  }

  handleUpdate(message) {
    this.clients.forEach((client, clientId) => {
      if (
        client.readyState === WebSocket.OPEN &&
        (!message.stockSymbol ||
          this.subscriptions.get(clientId) === message.stockSymbol)
      ) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

module.exports = WebSocketService;
